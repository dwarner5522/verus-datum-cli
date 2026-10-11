// Small self contained BLAKE2b (RFC 7693) with personalization support, used
// to verify the PBaaS pre-header hash. Keeps the module free of a libsodium
// dependency.
#ifndef VERUS_BLAKE2B_H
#define VERUS_BLAKE2B_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Unkeyed BLAKE2b. outlen is 1..64 bytes, personal is 16 bytes or NULL.
// Returns 0 on success.
int verus_blake2b(unsigned char *out, size_t outlen,
                  const unsigned char *in, size_t inlen,
                  const unsigned char *personal);

#ifdef __cplusplus
}
#endif

#endif
