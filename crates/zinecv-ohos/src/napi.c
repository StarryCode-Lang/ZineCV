#include <napi/native_api.h>
extern char *zinecv_core_probe(void);
extern void zinecv_string_free(char *value);
static napi_value Probe(napi_env env, napi_callback_info info) {
    (void)info;
    char *json = zinecv_core_probe();
    napi_value result = NULL;
    napi_status status = napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &result);
    zinecv_string_free(json);
    if (status != napi_ok) return NULL;
    return result;
}
static napi_value Init(napi_env env, napi_value exports) {
    napi_value probe;
    if (napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, NULL, &probe) != napi_ok) return NULL;
    if (napi_set_named_property(env, exports, "probe", probe) != napi_ok) return NULL;
    return exports;
}
static napi_module module = {1, 0, NULL, Init, "zinecv", NULL, {0}};
__attribute__((constructor)) static void Register(void) { napi_module_register(&module); }
