/*
 * Spike 03. Map a shared region, hand it to JavaScript as an external ArrayBuffer, then
 * write to the region behind JavaScript back and see whether the change is visible.
 *
 * Throwaway diagnostic code. It leaks the mapping on purpose, because the process exits
 * immediately after the check.
 */
#include <node_api.h>
#include <string.h>

#define REGION_BYTES 4096

#ifdef USE_MMAP
#include <sys/mman.h>
static void *map_region(void) {
  void *p = mmap(NULL, REGION_BYTES, PROT_READ | PROT_WRITE,
                 MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  return p == MAP_FAILED ? NULL : p;
}
#else
#include <windows.h>
static void *map_region(void) {
  HANDLE h = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0,
                                REGION_BYTES, NULL);
  if (h == NULL) return NULL;
  return MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, REGION_BYTES);
}
#endif

static void *region = NULL;

static napi_value Wrap(napi_env env, napi_callback_info info) {
  (void)info;
  if (region == NULL) {
    region = map_region();
    if (region == NULL) {
      napi_throw_error(env, NULL, "could not map the region");
      return NULL;
    }
    memset(region, 0, REGION_BYTES);
    ((int32_t *)region)[0] = 0x5EED;
  }

  napi_value buffer;
  /* The call under test. On a V8 with the sandbox enabled this copies. On newer builds
   * it aborts the process, which is a clearer answer to the same question. */
  napi_status status = napi_create_external_arraybuffer(env, region, REGION_BYTES, NULL,
                                                        NULL, &buffer);
  if (status != napi_ok) {
    napi_throw_error(env, NULL, "napi_create_external_arraybuffer was rejected");
    return NULL;
  }
  return buffer;
}

static napi_value PokeNative(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (region == NULL) {
    napi_throw_error(env, NULL, "call wrap() first");
    return NULL;
  }
  int32_t value = 0;
  napi_get_value_int32(env, argv[0], &value);
  ((int32_t *)region)[0] = value;
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value wrap, poke;
  napi_create_function(env, "wrap", NAPI_AUTO_LENGTH, Wrap, NULL, &wrap);
  napi_create_function(env, "pokeNative", NAPI_AUTO_LENGTH, PokeNative, NULL, &poke);
  napi_set_named_property(env, exports, "wrap", wrap);
  napi_set_named_property(env, exports, "pokeNative", poke);
  return exports;
}
