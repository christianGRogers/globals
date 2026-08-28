/*
 * The native transport. One file-backed region, mapped into every process that opens it,
 * written by exactly one owner and copied out by readers under a seqlock.
 *
 * Nothing here ever hands V8 a pointer it does not own. The mapping is read and written
 * only inside these functions, and the reader's copy lands in a caller-supplied buffer that
 * V8 allocated, which is what keeps the memory cage out of the picture. That constraint is
 * the reason this file exists at all; see spikes/03-memory-cage and spikes/08-mmap-accessor.
 *
 * Region layout:
 *   0   u32  magic, "GSM1"
 *   4   u32  layout version
 *   8   u32  seqlock sequence, even when stable, odd while a flush is in flight
 *   12  u32  reserved
 *   16  u64  data size in bytes
 *   24  u64  commit count, the version a reader's sync returns
 *   32       reserved up to 64
 *   64       the data region
 */
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sched.h>
#include <unistd.h>
#endif

#define SHM_MAGIC 0x314d5347u /* "GSM1" read as little endian bytes G S M 1 */
#define SHM_LAYOUT_VERSION 1u
#define HEADER_BYTES 64u
#define SYNC_RETRY_CAP 50000000u

#define OFF_MAGIC 0u
#define OFF_LAYOUT 4u
#define OFF_SEQ 8u
#define OFF_DATA_SIZE 16u
#define OFF_COMMIT 24u

typedef struct {
  volatile uint8_t* map;
  uint64_t data_size;
  int owner;
#ifdef _WIN32
  HANDLE mapping;
#else
  int fd;
#endif
} Region;

#define SEQ_PTR(r) ((volatile uint32_t*)((r)->map + OFF_SEQ))
#define COMMIT_PTR(r) ((volatile uint64_t*)((r)->map + OFF_COMMIT))
#define DATA_PTR(r) ((r)->map + HEADER_BYTES)

#ifdef _WIN32
static uint32_t load_seq(const Region* r) {
  return (uint32_t)InterlockedOr((volatile LONG*)SEQ_PTR(r), 0);
}
static void store_seq(Region* r, uint32_t v) {
  InterlockedExchange((volatile LONG*)SEQ_PTR(r), (LONG)v);
}
static uint64_t load_commit(const Region* r) {
  return (uint64_t)InterlockedOr64((volatile LONG64*)COMMIT_PTR(r), 0);
}
static void store_commit(Region* r, uint64_t v) {
  InterlockedExchange64((volatile LONG64*)COMMIT_PTR(r), (LONG64)v);
}
static void fence(void) { MemoryBarrier(); }
#else
static uint32_t load_seq(const Region* r) {
  return __atomic_load_n(SEQ_PTR(r), __ATOMIC_ACQUIRE);
}
static void store_seq(Region* r, uint32_t v) {
  __atomic_store_n(SEQ_PTR(r), v, __ATOMIC_RELEASE);
}
static uint64_t load_commit(const Region* r) {
  return __atomic_load_n(COMMIT_PTR(r), __ATOMIC_ACQUIRE);
}
static void store_commit(Region* r, uint64_t v) {
  __atomic_store_n(COMMIT_PTR(r), v, __ATOMIC_RELEASE);
}
static void fence(void) { __atomic_thread_fence(__ATOMIC_SEQ_CST); }
#endif

static napi_value fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static void region_release(Region* r) {
  if (r->map != NULL) {
#ifdef _WIN32
    UnmapViewOfFile((void*)r->map);
    if (r->mapping != NULL) CloseHandle(r->mapping);
    r->mapping = NULL;
#else
    munmap((void*)r->map, HEADER_BYTES + r->data_size);
    if (r->fd >= 0) close(r->fd);
    r->fd = -1;
#endif
    r->map = NULL;
  }
}

static void finalize_region(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  Region* r = (Region*)data;
  region_release(r);
  free(r);
}

static Region* get_region(napi_env env, napi_value value) {
  void* out = NULL;
  if (napi_get_value_external(env, value, &out) != napi_ok || out == NULL) {
    fail(env, "ESHM_HANDLE", "not a region handle");
    return NULL;
  }
  Region* r = (Region*)out;
  if (r->map == NULL) {
    fail(env, "ESHM_CLOSED", "the region is closed");
    return NULL;
  }
  return r;
}

static int read_u64_arg(napi_env env, napi_value value, uint64_t* out) {
  double d = 0;
  if (napi_get_value_double(env, value, &d) != napi_ok || d < 0 || d != (double)(uint64_t)d) {
    return 0;
  }
  *out = (uint64_t)d;
  return 1;
}

/* map_file maps HEADER_BYTES + data_size of the file at path. On create it sizes and
 * initialises the header first; on attach it validates the header it finds. */
static napi_value open_region(napi_env env, napi_callback_info info, int create) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  char path[2048];
  size_t path_len = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &path_len) != napi_ok) {
    return fail(env, "ESHM_ARG", "path must be a string");
  }

  uint64_t data_size = 0;
  if (create) {
    if (argc < 2 || !read_u64_arg(env, argv[1], &data_size) || data_size == 0) {
      return fail(env, "ESHM_ARG", "dataSize must be a positive integer");
    }
  }

  Region* r = (Region*)calloc(1, sizeof(Region));
  if (r == NULL) return fail(env, "ESHM_IO", "out of memory");
#ifndef _WIN32
  r->fd = -1;
#endif

#ifdef _WIN32
  HANDLE file = CreateFileA(path, GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                            create ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    free(r);
    return fail(env, "ESHM_IO", create ? "could not create the region file" : "could not open the region file");
  }
  if (!create) {
    uint8_t header[HEADER_BYTES];
    DWORD got = 0;
    if (!ReadFile(file, header, HEADER_BYTES, &got, NULL) || got != HEADER_BYTES) {
      CloseHandle(file);
      free(r);
      return fail(env, "ESHM_MAGIC", "the file is too small to hold a region header");
    }
    uint32_t magic, layout;
    memcpy(&magic, header + OFF_MAGIC, 4);
    memcpy(&layout, header + OFF_LAYOUT, 4);
    memcpy(&data_size, header + OFF_DATA_SIZE, 8);
    if (magic != SHM_MAGIC) {
      CloseHandle(file);
      free(r);
      return fail(env, "ESHM_MAGIC", "the file is not a region: bad magic");
    }
    if (layout != SHM_LAYOUT_VERSION) {
      CloseHandle(file);
      free(r);
      return fail(env, "ESHM_LAYOUT", "the region uses a layout this build does not understand");
    }
  } else {
    LARGE_INTEGER size;
    size.QuadPart = (LONGLONG)(HEADER_BYTES + data_size);
    if (!SetFilePointerEx(file, size, NULL, FILE_BEGIN) || !SetEndOfFile(file)) {
      CloseHandle(file);
      free(r);
      return fail(env, "ESHM_IO", "could not size the region file");
    }
  }
  r->mapping = CreateFileMappingA(file, NULL, PAGE_READWRITE, 0, 0, NULL);
  CloseHandle(file);
  if (r->mapping == NULL) {
    free(r);
    return fail(env, "ESHM_IO", "could not create the file mapping");
  }
  r->map = (volatile uint8_t*)MapViewOfFile(r->mapping, FILE_MAP_ALL_ACCESS, 0, 0,
                                            (SIZE_T)(HEADER_BYTES + data_size));
  if (r->map == NULL) {
    CloseHandle(r->mapping);
    free(r);
    return fail(env, "ESHM_IO", "could not map the region");
  }
#else
  r->fd = open(path, O_RDWR | (create ? O_CREAT : 0), 0600);
  if (r->fd < 0) {
    free(r);
    return fail(env, "ESHM_IO", create ? "could not create the region file" : "could not open the region file");
  }
  if (!create) {
    uint8_t header[HEADER_BYTES];
    if (pread(r->fd, header, HEADER_BYTES, 0) != (ssize_t)HEADER_BYTES) {
      close(r->fd);
      free(r);
      return fail(env, "ESHM_MAGIC", "the file is too small to hold a region header");
    }
    uint32_t magic, layout;
    memcpy(&magic, header + OFF_MAGIC, 4);
    memcpy(&layout, header + OFF_LAYOUT, 4);
    memcpy(&data_size, header + OFF_DATA_SIZE, 8);
    if (magic != SHM_MAGIC) {
      close(r->fd);
      free(r);
      return fail(env, "ESHM_MAGIC", "the file is not a region: bad magic");
    }
    if (layout != SHM_LAYOUT_VERSION) {
      close(r->fd);
      free(r);
      return fail(env, "ESHM_LAYOUT", "the region uses a layout this build does not understand");
    }
  } else if (ftruncate(r->fd, (off_t)(HEADER_BYTES + data_size)) != 0) {
    close(r->fd);
    free(r);
    return fail(env, "ESHM_IO", "could not size the region file");
  }
  void* p = mmap(NULL, HEADER_BYTES + data_size, PROT_READ | PROT_WRITE, MAP_SHARED, r->fd, 0);
  if (p == MAP_FAILED) {
    close(r->fd);
    free(r);
    return fail(env, "ESHM_IO", "could not map the region");
  }
  r->map = (volatile uint8_t*)p;
#endif

  r->data_size = data_size;
  r->owner = create;

  if (create) {
    uint32_t magic = SHM_MAGIC;
    uint32_t layout = SHM_LAYOUT_VERSION;
    memcpy((void*)(r->map + OFF_MAGIC), &magic, 4);
    memcpy((void*)(r->map + OFF_LAYOUT), &layout, 4);
    memcpy((void*)(r->map + OFF_DATA_SIZE), &data_size, 8);
    store_commit(r, 0);
    fence();
    store_seq(r, 0);
  }

  napi_value external;
  if (napi_create_external(env, r, finalize_region, NULL, &external) != napi_ok) {
    region_release(r);
    free(r);
    return fail(env, "ESHM_IO", "could not wrap the region");
  }
  return external;
}

static napi_value Create(napi_env env, napi_callback_info info) {
  return open_region(env, info, 1);
}

static napi_value Attach(napi_env env, napi_callback_info info) {
  return open_region(env, info, 0);
}

static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void* out = NULL;
  if (napi_get_value_external(env, argv[0], &out) != napi_ok || out == NULL) {
    return fail(env, "ESHM_HANDLE", "not a region handle");
  }
  region_release((Region*)out);
  return NULL;
}

static napi_value DataSize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Region* r = get_region(env, argv[0]);
  if (r == NULL) return NULL;
  napi_value out;
  napi_create_double(env, (double)r->data_size, &out);
  return out;
}

static napi_value Version(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Region* r = get_region(env, argv[0]);
  if (r == NULL) return NULL;
  napi_value out;
  napi_create_double(env, (double)load_commit(r), &out);
  return out;
}

/* flush(region, src Uint8Array, ranges Uint32Array of offset,length pairs) -> version.
 * One seqlock section covers every range plus the commit bump, so a reader either sees the
 * whole commit or retries. */
static napi_value Flush(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Region* r = get_region(env, argv[0]);
  if (r == NULL) return NULL;
  if (!r->owner) return fail(env, "ESHM_OWNER", "only the creating side may flush");

  void* src = NULL;
  size_t src_len = 0;
  napi_typedarray_type src_type;
  napi_value src_ab;
  size_t src_off;
  if (napi_get_typedarray_info(env, argv[1], &src_type, &src_len, &src, &src_ab, &src_off) != napi_ok ||
      src_type != napi_uint8_array) {
    return fail(env, "ESHM_ARG", "src must be a Uint8Array");
  }

  void* ranges = NULL;
  size_t range_words = 0;
  napi_typedarray_type ranges_type;
  napi_value ranges_ab;
  size_t ranges_off;
  if (napi_get_typedarray_info(env, argv[2], &ranges_type, &range_words, &ranges, &ranges_ab, &ranges_off) != napi_ok ||
      ranges_type != napi_uint32_array || range_words == 0 || (range_words & 1) != 0) {
    return fail(env, "ESHM_ARG", "ranges must be a Uint32Array of offset,length pairs");
  }

  const uint32_t* pairs = (const uint32_t*)ranges;
  for (size_t i = 0; i < range_words; i += 2) {
    uint64_t off = pairs[i];
    uint64_t len = pairs[i + 1];
    if (off + len > r->data_size || off + len > (uint64_t)src_len) {
      return fail(env, "ESHM_BOUNDS", "a range reaches past the region or the source");
    }
  }

  uint32_t s = load_seq(r);
  store_seq(r, s + 1);
  fence();
  for (size_t i = 0; i < range_words; i += 2) {
    memcpy((void*)(DATA_PTR(r) + pairs[i]), (const uint8_t*)src + pairs[i], pairs[i + 1]);
  }
  uint64_t commit = load_commit(r) + 1;
  store_commit(r, commit);
  fence();
  store_seq(r, s + 2);

  napi_value out;
  napi_create_double(env, (double)commit, &out);
  return out;
}

/* sync(region, dest Uint8Array) -> the version the captured copy belongs to. */
static napi_value Sync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Region* r = get_region(env, argv[0]);
  if (r == NULL) return NULL;

  void* dest = NULL;
  size_t dest_len = 0;
  napi_typedarray_type dest_type;
  napi_value dest_ab;
  size_t dest_off;
  if (napi_get_typedarray_info(env, argv[1], &dest_type, &dest_len, &dest, &dest_ab, &dest_off) != napi_ok ||
      dest_type != napi_uint8_array) {
    return fail(env, "ESHM_ARG", "dest must be a Uint8Array");
  }
  if ((uint64_t)dest_len < r->data_size) {
    return fail(env, "ESHM_BOUNDS", "dest is smaller than the region");
  }

  for (uint32_t attempts = 0; attempts < SYNC_RETRY_CAP; attempts++) {
    // A reader that spins without yielding can starve the very writer it is waiting on
    // when cores are scarce, which converts contention into livelock. Give the scheduler
    // a chance regularly; the fast path never reaches this.
    if (attempts != 0 && (attempts & 1023) == 0) {
#ifdef _WIN32
      SwitchToThread();
#else
      sched_yield();
#endif
    }
    uint32_t s1 = load_seq(r);
    if (s1 & 1) continue;
    memcpy(dest, (const void*)DATA_PTR(r), r->data_size);
    uint64_t commit = load_commit(r);
    fence();
    uint32_t s2 = load_seq(r);
    if (s1 == s2) {
      napi_value out;
      napi_create_double(env, (double)commit, &out);
      return out;
    }
  }
  return fail(env, "ESHM_LIVELOCK", "the writer never left a stable window to copy");
}

static napi_value Stats(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Region* r = get_region(env, argv[0]);
  if (r == NULL) return NULL;
  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_double(env, (double)r->data_size, &v);
  napi_set_named_property(env, out, "dataSize", v);
  napi_create_double(env, (double)load_commit(r), &v);
  napi_set_named_property(env, out, "version", v);
  napi_get_boolean(env, r->owner, &v);
  napi_set_named_property(env, out, "owner", v);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "create", NULL, Create, NULL, NULL, NULL, napi_default, NULL },
    { "attach", NULL, Attach, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, Close, NULL, NULL, NULL, napi_default, NULL },
    { "dataSize", NULL, DataSize, NULL, NULL, NULL, napi_default, NULL },
    { "version", NULL, Version, NULL, NULL, NULL, napi_default, NULL },
    { "flush", NULL, Flush, NULL, NULL, NULL, napi_default, NULL },
    { "sync", NULL, Sync, NULL, NULL, NULL, napi_default, NULL },
    { "stats", NULL, Stats, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  napi_value layout;
  napi_create_uint32(env, SHM_LAYOUT_VERSION, &layout);
  napi_set_named_property(env, exports, "LAYOUT_VERSION", layout);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
