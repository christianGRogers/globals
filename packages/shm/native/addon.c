/*
 * The native transport. One file-backed region, mapped into every process that opens it,
 * written by exactly one owner and copied out by readers, with two data slots so the copy
 * out never races the copy in.
 *
 * Nothing here ever hands V8 a pointer it does not own. The mapping is read and written
 * only inside these functions, and the reader's copy lands in a caller-supplied buffer that
 * V8 allocated, which is what keeps the memory cage out of the picture. That constraint is
 * the reason this file exists at all; see spikes/03-memory-cage and spikes/08-mmap-accessor.
 *
 * The protocol is double buffered rather than a bare seqlock, and the transport soak is
 * why. Layout one held the lock for the whole flush memcpy, so a writer at full rate on a
 * large region left stable windows barely longer than the reader's own copy, and a reader
 * could retry to the point of livelock. Now the writer builds every commit in the slot the
 * last commit did not publish and then publishes (version, slot) as one atomic word. A
 * reader copies the published slot and rereads the word: the copy is torn only if the
 * writer completed two whole commits during it, and a commit cannot be faster than the copy
 * it would have to lap, so the retry is a rarity instead of a livelock.
 *
 * The inactive slot is one commit stale, so each flush first reapplies the previous
 * commit's ranges from the owner's current mirror, which brings every byte the last two
 * commits touched up to date; bytes older than that are already equal in both slots.
 *
 * Each slot carries its own sequence and version, because the published word alone cannot
 * reveal a write in progress: a reader could start copying the published slot just as the
 * writer, one commit later, starts rewriting that same slot underneath it. The slot's
 * sequence is odd exactly while the writer is inside it, so the reader's bracket read
 * catches the overlap and retries, and the retry is bounded because the writer alternates
 * slots and must complete a whole further commit before touching the same slot again.
 *
 * Region layout, version 2:
 *   0   u32  magic, "GSM1"
 *   4   u32  layout version
 *   8   u64  reserved
 *   16  u64  data size in bytes, per slot
 *   24  u64  the word: version << 1 | published slot index
 *   32  u32  slot 0 sequence, odd while the writer is inside slot 0
 *   36       reserved
 *   40  u64  slot 0 version
 *   48  u32  slot 1 sequence
 *   52       reserved
 *   56  u64  slot 1 version
 *   64                 slot 0
 *   64 + dataSize      slot 1
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
#define SHM_LAYOUT_VERSION 2u
#define HEADER_BYTES 64u
#define SYNC_RETRY_CAP 50000000u

#define OFF_MAGIC 0u
#define OFF_LAYOUT 4u
#define OFF_DATA_SIZE 16u
#define OFF_WORD 24u

typedef struct {
  volatile uint8_t* map;
  uint64_t data_size;
  int owner;
  /* The previous commit's ranges, owner side only: offset,length pairs. */
  uint32_t* prev_ranges;
  size_t prev_pairs;
#ifdef _WIN32
  HANDLE mapping;
#else
  int fd;
#endif
} Region;

#define WORD_PTR(r) ((volatile uint64_t*)((r)->map + OFF_WORD))
#define SLOT_SEQ_PTR(r, s) ((volatile uint32_t*)((r)->map + 32u + 16u * (s)))
#define SLOT_VER_PTR(r, s) ((volatile uint64_t*)((r)->map + 40u + 16u * (s)))
#define SLOT_PTR(r, s) ((r)->map + HEADER_BYTES + (uint64_t)(s) * (r)->data_size)
#define MAP_BYTES(r) (HEADER_BYTES + 2u * (r)->data_size)

#ifdef _WIN32
static uint64_t load_word(const Region* r) {
  return (uint64_t)InterlockedOr64((volatile LONG64*)WORD_PTR(r), 0);
}
static void store_word(Region* r, uint64_t v) {
  InterlockedExchange64((volatile LONG64*)WORD_PTR(r), (LONG64)v);
}
static uint32_t load_u32(volatile uint32_t* p) {
  return (uint32_t)InterlockedOr((volatile LONG*)p, 0);
}
static void store_u32(volatile uint32_t* p, uint32_t v) {
  InterlockedExchange((volatile LONG*)p, (LONG)v);
}
static uint64_t load_u64(volatile uint64_t* p) {
  return (uint64_t)InterlockedOr64((volatile LONG64*)p, 0);
}
static void store_u64(volatile uint64_t* p, uint64_t v) {
  InterlockedExchange64((volatile LONG64*)p, (LONG64)v);
}
static void fence(void) { MemoryBarrier(); }
static void yield_cpu(void) { SwitchToThread(); }
#else
static uint64_t load_word(const Region* r) {
  return __atomic_load_n(WORD_PTR(r), __ATOMIC_ACQUIRE);
}
static void store_word(Region* r, uint64_t v) {
  __atomic_store_n(WORD_PTR(r), v, __ATOMIC_RELEASE);
}
static uint32_t load_u32(volatile uint32_t* p) { return __atomic_load_n(p, __ATOMIC_ACQUIRE); }
static void store_u32(volatile uint32_t* p, uint32_t v) { __atomic_store_n(p, v, __ATOMIC_RELEASE); }
static uint64_t load_u64(volatile uint64_t* p) { return __atomic_load_n(p, __ATOMIC_ACQUIRE); }
static void store_u64(volatile uint64_t* p, uint64_t v) { __atomic_store_n(p, v, __ATOMIC_RELEASE); }
static void fence(void) { __atomic_thread_fence(__ATOMIC_SEQ_CST); }
static void yield_cpu(void) { sched_yield(); }
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
    munmap((void*)r->map, MAP_BYTES(r));
    if (r->fd >= 0) close(r->fd);
    r->fd = -1;
#endif
    r->map = NULL;
  }
  free(r->prev_ranges);
  r->prev_ranges = NULL;
  r->prev_pairs = 0;
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
    size.QuadPart = (LONGLONG)(HEADER_BYTES + 2u * data_size);
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
                                            (SIZE_T)(HEADER_BYTES + 2u * data_size));
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
  } else if (ftruncate(r->fd, (off_t)(HEADER_BYTES + 2u * data_size)) != 0) {
    close(r->fd);
    free(r);
    return fail(env, "ESHM_IO", "could not size the region file");
  }
  void* p = mmap(NULL, HEADER_BYTES + 2u * data_size, PROT_READ | PROT_WRITE, MAP_SHARED, r->fd, 0);
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
    store_u32(SLOT_SEQ_PTR(r, 0), 0);
    store_u32(SLOT_SEQ_PTR(r, 1), 0);
    store_u64(SLOT_VER_PTR(r, 0), 0);
    store_u64(SLOT_VER_PTR(r, 1), 0);
    fence();
    store_word(r, 0);
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
  napi_create_double(env, (double)(load_word(r) >> 1), &out);
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

  uint64_t word = load_word(r);
  uint64_t version = word >> 1;
  uint32_t active = (uint32_t)(word & 1u);
  uint32_t inactive = 1u - active;
  volatile uint8_t* slot = SLOT_PTR(r, inactive);

  uint32_t sseq = load_u32(SLOT_SEQ_PTR(r, inactive));
  store_u32(SLOT_SEQ_PTR(r, inactive), sseq + 1);
  fence();

  /* The inactive slot is one commit behind the published one, and the difference is the
   * previous commit's ranges. They are copied slot to slot, from the published state, not
   * from the caller's mirror: the mirror may hold bytes the caller has changed but not
   * declared this commit, and an undeclared byte must never publish. Bytes older than the
   * last two commits are already equal in both slots, inductively. */
  volatile const uint8_t* published = SLOT_PTR(r, active);
  for (size_t i = 0; i < r->prev_pairs * 2; i += 2) {
    memcpy((void*)(slot + r->prev_ranges[i]), (const void*)(published + r->prev_ranges[i]),
           r->prev_ranges[i + 1]);
  }
  for (size_t i = 0; i < range_words; i += 2) {
    memcpy((void*)(slot + pairs[i]), (const uint8_t*)src + pairs[i], pairs[i + 1]);
  }
  store_u64(SLOT_VER_PTR(r, inactive), version + 1);

  /* Remember this commit's ranges for the next flush to reapply. */
  size_t pair_count = range_words / 2;
  if (pair_count > r->prev_pairs) {
    uint32_t* grown = (uint32_t*)realloc(r->prev_ranges, range_words * sizeof(uint32_t));
    if (grown == NULL) return fail(env, "ESHM_IO", "out of memory tracking ranges");
    r->prev_ranges = grown;
  }
  memcpy(r->prev_ranges, pairs, range_words * sizeof(uint32_t));
  r->prev_pairs = pair_count;

  fence();
  store_u32(SLOT_SEQ_PTR(r, inactive), sseq + 2);
  fence();
  store_word(r, ((version + 1) << 1) | inactive);

  napi_value out;
  napi_create_double(env, (double)(version + 1), &out);
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
    if (attempts != 0 && (attempts & 15) == 0) yield_cpu();
    uint32_t s = (uint32_t)(load_word(r) & 1u);
    uint32_t s1 = load_u32(SLOT_SEQ_PTR(r, s));
    if (s1 & 1u) continue;
    memcpy(dest, (const void*)SLOT_PTR(r, s), r->data_size);
    uint64_t version = load_u64(SLOT_VER_PTR(r, s));
    fence();
    uint32_t s2 = load_u32(SLOT_SEQ_PTR(r, s));
    /* An unchanged even sequence brackets the copy: no writer was inside this slot, so the
     * bytes are one whole commit and the slot version names which one. A change means the
     * writer lapped into this slot mid-copy; it must finish an entire further commit before
     * touching this slot again, so the retry is bounded rather than a livelock. */
    if (s1 == s2) {
      napi_value out;
      napi_create_double(env, (double)version, &out);
      return out;
    }
  }
  return fail(env, "ESHM_LIVELOCK", "the writer lapped this copy repeatedly");
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
  napi_create_double(env, (double)(load_word(r) >> 1), &v);
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
