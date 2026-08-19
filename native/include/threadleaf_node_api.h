#ifndef THREADLEAF_NODE_API_H
#define THREADLEAF_NODE_API_H

/*
 * Declaration-only Node-API ABI shim.
 *
 * The addon is intentionally written against Node-API rather than V8 or NAN.
 * These declarations mirror the ABI-stable host functions and keep the Linux
 * focused build possible on systems that ship the Node runtime without
 * development headers. A host build may substitute its installed node_api.h;
 * no Node implementation is copied or linked into the addon.
 */

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

/* Keep the Node-API contract explicit and stable across Node and Electron. */
#define THREADLEAF_NAPI_VERSION 10
#if defined(NAPI_VERSION) && NAPI_VERSION != THREADLEAF_NAPI_VERSION
#error "Threadleaf native builds require the pinned Node-API version 10."
#endif
#ifndef NAPI_VERSION
#define NAPI_VERSION THREADLEAF_NAPI_VERSION
#endif

#if defined(_WIN32)
#define THREADLEAF_NAPI_EXTERN __declspec(dllimport)
#else
#define THREADLEAF_NAPI_EXTERN
#endif

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_ref__* napi_ref;

typedef enum {
  napi_ok = 0,
  napi_invalid_arg = 1,
  napi_object_expected = 2,
  napi_string_expected = 3,
  napi_name_expected = 4,
  napi_function_expected = 5,
  napi_number_expected = 6,
  napi_boolean_expected = 7,
  napi_array_expected = 8,
  napi_generic_failure = 9,
  napi_pending_exception = 10,
  napi_cancelled = 11,
  napi_escape_called_twice = 12,
  napi_handle_scope_mismatch = 13,
  napi_callback_scope_mismatch = 14,
  napi_queue_full = 15,
  napi_closing = 16,
  napi_bigint_expected = 17,
  napi_date_expected = 18,
  napi_arraybuffer_expected = 19,
  napi_detachable_arraybuffer_expected = 20,
  napi_would_deadlock = 21,
} napi_status;

typedef enum {
  napi_default = 0,
  napi_writable = 1 << 0,
  napi_enumerable = 1 << 1,
  napi_configurable = 1 << 2,
  napi_static = 1 << 10,
} napi_property_attributes;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void* finalize_data, void* finalize_hint);

typedef struct {
  const char* utf8name;
  napi_value name;
  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;
  napi_property_attributes attributes;
  void* data;
} napi_property_descriptor;

THREADLEAF_NAPI_EXTERN napi_status napi_get_cb_info(
    napi_env env,
    napi_callback_info cbinfo,
    size_t* argc,
    napi_value* argv,
    napi_value* this_arg,
    void** data);
THREADLEAF_NAPI_EXTERN napi_status napi_create_object(napi_env env, napi_value* result);
THREADLEAF_NAPI_EXTERN napi_status napi_get_undefined(napi_env env, napi_value* result);
THREADLEAF_NAPI_EXTERN napi_status napi_create_string_utf8(
    napi_env env,
    const char* str,
    size_t length,
    napi_value* result);
THREADLEAF_NAPI_EXTERN napi_status napi_get_value_string_utf8(
    napi_env env,
    napi_value value,
    char* buf,
    size_t bufsize,
    size_t* result);
THREADLEAF_NAPI_EXTERN napi_status napi_get_value_int32(
    napi_env env,
    napi_value value,
    int32_t* result);
THREADLEAF_NAPI_EXTERN napi_status napi_get_value_bool(
    napi_env env,
    napi_value value,
    bool* result);
THREADLEAF_NAPI_EXTERN napi_status napi_create_int32(
    napi_env env,
    int32_t value,
    napi_value* result);
THREADLEAF_NAPI_EXTERN napi_status napi_get_buffer_info(
    napi_env env,
    napi_value value,
    void** data,
    size_t* length);
THREADLEAF_NAPI_EXTERN napi_status napi_create_error(
    napi_env env,
    napi_value code,
    napi_value msg,
    napi_value* result);
THREADLEAF_NAPI_EXTERN napi_status napi_set_named_property(
    napi_env env,
    napi_value object,
    const char* utf8name,
    napi_value value);
THREADLEAF_NAPI_EXTERN napi_status napi_define_properties(
    napi_env env,
    napi_value object,
    size_t property_count,
    const napi_property_descriptor* properties);
THREADLEAF_NAPI_EXTERN napi_status napi_throw(napi_env env, napi_value error);
THREADLEAF_NAPI_EXTERN napi_status napi_wrap(
    napi_env env,
    napi_value js_object,
    void* native_object,
    napi_finalize finalize_cb,
    void* finalize_hint,
    napi_ref* result);
THREADLEAF_NAPI_EXTERN napi_status napi_unwrap(
    napi_env env,
    napi_value js_object,
    void** result);

#endif
