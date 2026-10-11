{
    "targets": [
        {
            "target_name": "verushash",
            "sources": [
                "native/verushash/addon.cc",
                "native/verushash/verushash_core.cpp",
                "native/verushash/verus_hash.cpp",
                "native/verushash/verus_clhash_portable.cpp",
                "native/verushash/haraka_portable.c",
                "native/verushash/blake2b.c"
            ],
            "include_dirs": [
                "native/verushash"
            ],
            "defines": [
                "NAPI_VERSION=3"
            ],
            "cflags": [
                "-O2",
                "-fno-strict-aliasing"
            ],
            "cflags_cc": [
                "-std=c++11",
                "-O2",
                "-fno-strict-aliasing"
            ],
            "xcode_settings": {
                "OTHER_CFLAGS": ["-O2", "-fno-strict-aliasing"],
                "OTHER_CPLUSPLUSFLAGS": ["-std=c++11", "-O2", "-fno-strict-aliasing"]
            }
        }
    ]
}
