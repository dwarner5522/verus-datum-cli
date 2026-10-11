// Minimal 256 bit blob, just enough for the VerusHash key cache and for
// returning BLAKE2b digests. Replaces the much larger bitcoin uint256 class.
#ifndef VERUS_UINT256_H
#define VERUS_UINT256_H

#include <string.h>

struct uint256
{
    unsigned char data[32];

    uint256() { SetNull(); }

    void SetNull() { memset(data, 0, sizeof(data)); }

    bool IsNull() const
    {
        for (size_t i = 0; i < sizeof(data); i++)
            if (data[i] != 0)
                return false;
        return true;
    }

    bool operator==(const uint256 &o) const { return memcmp(data, o.data, sizeof(data)) == 0; }
    bool operator!=(const uint256 &o) const { return !(*this == o); }
} __attribute__((__may_alias__));

#endif
