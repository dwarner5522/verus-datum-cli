// Node.js binding for the portable VerusHash implementation.
//
// Uses Node-API (N-API) so the compiled module keeps working across Node.js
// versions without a rebuild and without the `nan` compatibility layer.
#include <node_api.h>
#include <stdint.h>
#include <string.h>

#include "verushash_core.h"

typedef void (*hash_fn)(unsigned char *out, const unsigned char *in, size_t len);

static napi_value run_hash(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    void *data = NULL;

    if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok)
        return NULL;

    if (argc < 1) {
        napi_throw_type_error(env, NULL, "Wrong number of arguments");
        return NULL;
    }

    bool isBuffer = false;
    if (napi_is_buffer(env, argv[0], &isBuffer) != napi_ok || !isBuffer) {
        napi_throw_type_error(env, NULL, "Argument must be a Buffer");
        return NULL;
    }

    void *input = NULL;
    size_t length = 0;
    if (napi_get_buffer_info(env, argv[0], &input, &length) != napi_ok)
        return NULL;

    unsigned char hash[32];
    ((hash_fn)data)(hash, (const unsigned char *)input, length);

    napi_value result;
    if (napi_create_buffer_copy(env, sizeof(hash), hash, NULL, &result) != napi_ok)
        return NULL;
    return result;
}

static napi_value init(napi_env env, napi_value exports)
{
    static const struct { const char *name; hash_fn fn; } methods[] = {
        { "hash",    verushash_v1 },    // VerusHash V1
        { "hash2",   verushash_v2 },    // VerusHash V2
        { "hash2b",  verushash_v2b },   // VerusHash V2B
        { "hash2b1", verushash_v2b1 },  // VerusHash V2B1
        { "hash2b2", verushash_v2b2 },  // VerusHash V2B2
    };

    for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
        napi_value fn;
        if (napi_create_function(env, methods[i].name, NAPI_AUTO_LENGTH, run_hash, (void *)methods[i].fn, &fn) != napi_ok)
            return NULL;
        if (napi_set_named_property(env, exports, methods[i].name, fn) != napi_ok)
            return NULL;
    }
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
