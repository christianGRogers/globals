// Spike 08: one file-backed region mapped into every process, read through native
// accessor calls instead of an ArrayBuffer, so the V8 memory cage is never involved.
//
// Layout of the region:
//   bytes 0..3     seqlock sequence, even when stable, odd while a publish is in flight
//   bytes 8..71    sixteen int32 slots for direct visibility checks (slot i at 8 + 4i)
//   bytes 256..767 the seqlock payload, sixty four doubles written per publish
//
// remapOver is the deliberately dangerous arm: it maps the same file MAP_FIXED over the
// pages of a caller-supplied (in-cage) ArrayBuffer, giving zero copy TypedArray reads.
// Everything else here is ordinary supported N-API.
#include <node_api.h>
#include <stdint.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#endif

#define PAYLOAD_WORDS 64

static volatile uint8_t* g_map = NULL;
static size_t g_size = 0;
#ifdef _WIN32
static HANDLE g_mapping = INVALID_HANDLE_VALUE;
#else
static int g_fd = -1;
#endif

#define SEQ ((volatile uint32_t*)(g_map))
#define SLOTS ((volatile int32_t*)(g_map + 8))
#define PAYLOAD ((volatile double*)(g_map + 256))

#ifdef _WIN32
static uint32_t load_seq(void) { MemoryBarrier(); uint32_t v = *SEQ; MemoryBarrier(); return v; }
static void store_seq(uint32_t v) { MemoryBarrier(); *SEQ = v; MemoryBarrier(); }
static int32_t load_slot(int i) { MemoryBarrier(); int32_t v = SLOTS[i]; MemoryBarrier(); return v; }
static void store_slot(int i, int32_t v) { MemoryBarrier(); SLOTS[i] = v; MemoryBarrier(); }
static void fence(void) { MemoryBarrier(); }
#else
static uint32_t load_seq(void) { return __atomic_load_n(SEQ, __ATOMIC_ACQUIRE); }
static void store_seq(uint32_t v) { __atomic_store_n(SEQ, v, __ATOMIC_RELEASE); }
static int32_t load_slot(int i) { return __atomic_load_n(&SLOTS[i], __ATOMIC_ACQUIRE); }
static void store_slot(int i, int32_t v) { __atomic_store_n(&SLOTS[i], v, __ATOMIC_RELEASE); }
static void fence(void) { __atomic_thread_fence(__ATOMIC_SEQ_CST); }
#endif

static napi_value throw_if(napi_env env, int cond, const char* message) {
  if (cond) napi_throw_error(env, NULL, message);
  return NULL;
}

// open(path: string, size: number, create: boolean)
static napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  char path[1024];
  size_t path_len = 0;
  napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &path_len);
  double size_d = 0;
  napi_get_value_double(env, argv[1], &size_d);
  bool create = false;
  napi_get_value_bool(env, argv[2], &create);
  size_t size = (size_t)size_d;

#ifdef _WIN32
  HANDLE file = CreateFileA(path, GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                            create ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return throw_if(env, 1, "CreateFile failed");
  g_mapping = CreateFileMappingA(file, NULL, PAGE_READWRITE, 0, (DWORD)size, NULL);
  CloseHandle(file);
  if (g_mapping == NULL) return throw_if(env, 1, "CreateFileMapping failed");
  g_map = (volatile uint8_t*)MapViewOfFile(g_mapping, FILE_MAP_ALL_ACCESS, 0, 0, size);
  if (g_map == NULL) return throw_if(env, 1, "MapViewOfFile failed");
#else
  g_fd = open(path, O_RDWR | (create ? O_CREAT : 0), 0600);
  if (g_fd < 0) return throw_if(env, 1, "open failed");
  if (create && ftruncate(g_fd, (off_t)size) != 0) return throw_if(env, 1, "ftruncate failed");
  void* p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, g_fd, 0);
  if (p == MAP_FAILED) return throw_if(env, 1, "mmap failed");
  g_map = (volatile uint8_t*)p;
#endif
  g_size = size;
  return NULL;
}

static napi_value Pid(napi_env env, napi_callback_info info) {
  napi_value out;
#ifdef _WIN32
  napi_create_int32(env, (int32_t)GetCurrentProcessId(), &out);
#else
  napi_create_int32(env, (int32_t)getpid(), &out);
#endif
  return out;
}

// storeSlot(i, v)
static napi_value StoreSlot(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t i = 0, v = 0;
  napi_get_value_int32(env, argv[0], &i);
  napi_get_value_int32(env, argv[1], &v);
  store_slot(i & 15, v);
  return NULL;
}

// loadSlot(i) -> number
static napi_value LoadSlot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t i = 0;
  napi_get_value_int32(env, argv[0], &i);
  napi_value out;
  napi_create_int32(env, load_slot(i & 15), &out);
  return out;
}

static napi_value Version(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_uint32(env, load_seq(), &out);
  return out;
}

// publish(value): one seqlock write of the whole payload
static napi_value Publish(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  double v = 0;
  napi_get_value_double(env, argv[0], &v);
  uint32_t s = load_seq();
  store_seq(s + 1);
  fence();
  for (int i = 0; i < PAYLOAD_WORDS; i++) PAYLOAD[i] = v;
  fence();
  store_seq(s + 2);
  return NULL;
}

// readRecord() -> { value, retries, violation }: one consistent seqlock read
static napi_value ReadRecord(napi_env env, napi_callback_info info) {
  uint32_t retries = 0;
  int violation = 0;
  double value = 0;
  for (;;) {
    uint32_t s1 = load_seq();
    if (s1 & 1) {
      retries++;
      continue;
    }
    double first = PAYLOAD[0];
    int mismatch = 0;
    for (int i = 1; i < PAYLOAD_WORDS; i++) {
      if (PAYLOAD[i] != first) {
        mismatch = 1;
        break;
      }
    }
    fence();
    uint32_t s2 = load_seq();
    if (s1 == s2) {
      // A stable window with unequal words is the failure the protocol cannot tolerate.
      if (mismatch) violation = 1;
      value = first;
      break;
    }
    retries++;
    if (retries > 100000000u) {
      violation = 1;
      break;
    }
  }
  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_double(env, value, &v);
  napi_set_named_property(env, out, "value", v);
  napi_create_uint32(env, retries, &v);
  napi_set_named_property(env, out, "retries", v);
  napi_get_boolean(env, violation, &v);
  napi_set_named_property(env, out, "violation", v);
  return out;
}

// copyInto(typedArray) -> bytes copied. Copying INTO an in-cage buffer is supported; this
// measures the refresh path of the copy-on-version-change hybrid.
static napi_value CopyInto(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void* data = NULL;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t offset;
  napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &offset);
  size_t elem = type == napi_float64_array ? 8 : type == napi_int32_array ? 4 : 1;
  size_t bytes = len * elem;
  if (bytes > g_size) bytes = g_size;
  memcpy(data, (const void*)g_map, bytes);
  napi_value out;
  napi_create_double(env, (double)bytes, &out);
  return out;
}

// remapOver(typedArray) -> { byteOffset, byteLength }
// Maps the shared file MAP_FIXED over the page-aligned interior of the caller's buffer.
// The caller must keep that buffer referenced forever. This is the experiment, not a
// supported operation, and everything that goes wrong here is the caller's fault by design.
static napi_value RemapOver(napi_env env, napi_callback_info info) {
#ifdef _WIN32
  return throw_if(env, 1, "remapOver is not implemented on Windows in this spike");
#else
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void* data = NULL;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t offset;
  napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &offset);

  long pg = sysconf(_SC_PAGESIZE);
  uintptr_t base = (uintptr_t)data;
  uintptr_t aligned = (base + (uintptr_t)pg - 1) & ~((uintptr_t)pg - 1);
  if (len < (aligned - base)) return throw_if(env, 1, "buffer too small to align");
  size_t avail = len - (aligned - base);
  size_t maplen = g_size < avail ? g_size : avail;
  maplen &= ~((size_t)pg - 1);
  if (maplen == 0) return throw_if(env, 1, "buffer too small for one page");

  void* p = mmap((void*)aligned, maplen, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, g_fd, 0);
  if (p == MAP_FAILED) return throw_if(env, 1, "MAP_FIXED remap failed");

  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_double(env, (double)(aligned - base), &v);
  napi_set_named_property(env, out, "byteOffset", v);
  napi_create_double(env, (double)maplen, &v);
  napi_set_named_property(env, out, "byteLength", v);
  return out;
#endif
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "open", NULL, Open, NULL, NULL, NULL, napi_default, NULL },
    { "pid", NULL, Pid, NULL, NULL, NULL, napi_default, NULL },
    { "storeSlot", NULL, StoreSlot, NULL, NULL, NULL, napi_default, NULL },
    { "loadSlot", NULL, LoadSlot, NULL, NULL, NULL, napi_default, NULL },
    { "version", NULL, Version, NULL, NULL, NULL, napi_default, NULL },
    { "publish", NULL, Publish, NULL, NULL, NULL, napi_default, NULL },
    { "readRecord", NULL, ReadRecord, NULL, NULL, NULL, napi_default, NULL },
    { "copyInto", NULL, CopyInto, NULL, NULL, NULL, napi_default, NULL },
    { "remapOver", NULL, RemapOver, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
