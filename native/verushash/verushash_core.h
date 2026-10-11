// Plain C++ entry points for the VerusHash variants used by the pool.
// Every function writes a 32 byte hash to `out`.
#ifndef VERUSHASH_CORE_H
#define VERUSHASH_CORE_H

#include <stddef.h>

void verushash_v1(unsigned char *out, const unsigned char *in, size_t len);    // VerusHash 1.0
void verushash_v2(unsigned char *out, const unsigned char *in, size_t len);    // VerusHash 2.0
void verushash_v2b(unsigned char *out, const unsigned char *in, size_t len);   // VerusHash 2.0b
void verushash_v2b1(unsigned char *out, const unsigned char *in, size_t len);  // VerusHash 2.1
// VerusHash 2.2 over a serialized block header (140 byte header + solution).
// Handles PBaaS merge mined headers the same way the Verus daemon does.
void verushash_v2b2(unsigned char *out, const unsigned char *in, size_t len);

#endif
