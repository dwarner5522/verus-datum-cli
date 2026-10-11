// Architecture independent stand-in for the SSE2 __m128i type.
//
// The portable VerusHash code only needs __m128i as a 16 byte value that can
// be copied, XORed and reinterpreted as smaller integers; every real SSE/AES
// operation is emulated in plain C. Defining the type with the compiler's
// generic vector extension (supported by GCC and Clang on every target) lets
// the same source build on x86, ARM (Orange Pi, Raspberry Pi, ...) and others
// without any <immintrin.h> / NEON headers.
//
// The type is declared with 1 byte alignment so loads and stores through
// casted pointers are always safe, whatever the buffer they point into.
#ifndef VERUS_M128_H
#define VERUS_M128_H

#if !defined(__GNUC__) && !defined(__clang__)
#error "verushash: GCC or Clang is required (generic vector extension)"
#endif

#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__)
#error "verushash: only little endian targets are supported"
#endif

typedef long long __m128i __attribute__((__vector_size__(16), __may_alias__, __aligned__(1)));

#endif
