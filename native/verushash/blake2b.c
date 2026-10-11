// BLAKE2b as specified in RFC 7693, sequential mode, no key, optional
// 16 byte personalization. Written for clarity rather than speed.
#include <string.h>

#include "blake2b.h"

static const uint64_t blake2b_iv[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL,
    0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
    0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL
};

static const unsigned char blake2b_sigma[12][16] = {
    {  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15 },
    { 14, 10,  4,  8,  9, 15, 13,  6,  1, 12,  0,  2, 11,  7,  5,  3 },
    { 11,  8, 12,  0,  5,  2, 15, 13, 10, 14,  3,  6,  7,  1,  9,  4 },
    {  7,  9,  3,  1, 13, 12, 11, 14,  2,  6,  5, 10,  4,  0, 15,  8 },
    {  9,  0,  5,  7,  2,  4, 10, 15, 14,  1, 11, 12,  6,  8,  3, 13 },
    {  2, 12,  6, 10,  0, 11,  8,  3,  4, 13,  7,  5, 15, 14,  1,  9 },
    { 12,  5,  1, 15, 14, 13,  4, 10,  0,  7,  6,  3,  9,  2,  8, 11 },
    { 13, 11,  7, 14, 12,  1,  3,  9,  5,  0, 15,  4,  8,  6,  2, 10 },
    {  6, 15, 14,  9, 11,  3,  0,  8, 12,  2, 13,  7,  1,  4, 10,  5 },
    { 10,  2,  8,  4,  7,  6,  1,  5, 15, 11,  9, 14,  3, 12, 13,  0 },
    {  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15 },
    { 14, 10,  4,  8,  9, 15, 13,  6,  1, 12,  0,  2, 11,  7,  5,  3 }
};

static uint64_t load64(const unsigned char *p)
{
    uint64_t v = 0;
    int i;
    for (i = 7; i >= 0; i--)
        v = (v << 8) | p[i];
    return v;
}

static void store64(unsigned char *p, uint64_t v)
{
    int i;
    for (i = 0; i < 8; i++) {
        p[i] = (unsigned char)(v & 0xff);
        v >>= 8;
    }
}

static uint64_t rotr64(uint64_t x, int n)
{
    return (x >> n) | (x << (64 - n));
}

#define G(a, b, c, d, x, y)          \
    do {                             \
        v[a] = v[a] + v[b] + (x);    \
        v[d] = rotr64(v[d] ^ v[a], 32); \
        v[c] = v[c] + v[d];          \
        v[b] = rotr64(v[b] ^ v[c], 24); \
        v[a] = v[a] + v[b] + (y);    \
        v[d] = rotr64(v[d] ^ v[a], 16); \
        v[c] = v[c] + v[d];          \
        v[b] = rotr64(v[b] ^ v[c], 63); \
    } while (0)

static void compress(uint64_t h[8], const unsigned char block[128], uint64_t t, int last)
{
    uint64_t m[16], v[16];
    int i, r;

    for (i = 0; i < 16; i++)
        m[i] = load64(block + 8 * i);
    for (i = 0; i < 8; i++) {
        v[i] = h[i];
        v[i + 8] = blake2b_iv[i];
    }
    v[12] ^= t; // low 64 bits of the byte counter; inputs here are far below 2^64
    if (last)
        v[14] = ~v[14];

    for (r = 0; r < 12; r++) {
        const unsigned char *s = blake2b_sigma[r];
        G(0, 4,  8, 12, m[s[0]],  m[s[1]]);
        G(1, 5,  9, 13, m[s[2]],  m[s[3]]);
        G(2, 6, 10, 14, m[s[4]],  m[s[5]]);
        G(3, 7, 11, 15, m[s[6]],  m[s[7]]);
        G(0, 5, 10, 15, m[s[8]],  m[s[9]]);
        G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        G(2, 7,  8, 13, m[s[12]], m[s[13]]);
        G(3, 4,  9, 14, m[s[14]], m[s[15]]);
    }

    for (i = 0; i < 8; i++)
        h[i] ^= v[i] ^ v[i + 8];
}

int verus_blake2b(unsigned char *out, size_t outlen,
                  const unsigned char *in, size_t inlen,
                  const unsigned char *personal)
{
    uint64_t h[8];
    unsigned char block[128];
    unsigned char digest[64];
    uint64_t t = 0;
    int i;

    if (out == NULL || outlen == 0 || outlen > 64 || (in == NULL && inlen > 0))
        return -1;

    for (i = 0; i < 8; i++)
        h[i] = blake2b_iv[i];
    // parameter block: digest length, key length 0, fanout 1, depth 1
    h[0] ^= 0x01010000ULL ^ (uint64_t)outlen;
    if (personal != NULL) {
        h[6] ^= load64(personal);
        h[7] ^= load64(personal + 8);
    }

    while (inlen > 128) {
        t += 128;
        compress(h, in, t, 0);
        in += 128;
        inlen -= 128;
    }

    memset(block, 0, sizeof(block));
    if (inlen > 0)
        memcpy(block, in, inlen);
    t += inlen;
    compress(h, block, t, 1);

    for (i = 0; i < 8; i++)
        store64(digest + 8 * i, h[i]);
    memcpy(out, digest, outlen);
    return 0;
}
