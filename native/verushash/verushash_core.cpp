// Based on verushash.cc from https://github.com/VerusCoin/verushash-node
// (hellcatz, Michael Toutonghi), reworked to be independent of the Node/V8
// API version and of libsodium.
#include <string.h>
#include <stdint.h>
#include <vector>

#include "verus_hash.h"
#include "blake2b.h"
#include "verushash_core.h"

// The hashers are function local statics so their over-aligned buffers are
// placed correctly and construction happens on first use.
static CVerusHashV2 &hasher(int solutionVersion)
{
    static bool initialized = false;
    if (!initialized)
    {
        CVerusHash::init();
        CVerusHashV2::init();
        initialized = true;
    }

    static CVerusHashV2 vh2(SOLUTION_VERUSHHASH_V2);
    static CVerusHashV2 vh2b1(SOLUTION_VERUSHHASH_V2_1);
    static CVerusHashV2 vh2b2(SOLUTION_VERUSHHASH_V2_2);

    switch (solutionVersion)
    {
        case SOLUTION_VERUSHHASH_V2_2: return vh2b2;
        case SOLUTION_VERUSHHASH_V2_1: return vh2b1;
        default: return vh2;
    }
}

void verushash_v1(unsigned char *out, const unsigned char *in, size_t len)
{
    hasher(SOLUTION_VERUSHHASH_V2); // makes sure the haraka constants are loaded
    verus_hash(out, in, len);
}

void verushash_v2(unsigned char *out, const unsigned char *in, size_t len)
{
    CVerusHashV2 &vh = hasher(SOLUTION_VERUSHHASH_V2);
    vh.Reset();
    vh.Write(in, len);
    vh.Finalize(out);
}

void verushash_v2b(unsigned char *out, const unsigned char *in, size_t len)
{
    CVerusHashV2 &vh = hasher(SOLUTION_VERUSHHASH_V2);
    vh.Reset();
    vh.Write(in, len);
    vh.Finalize2b(out);
}

void verushash_v2b1(unsigned char *out, const unsigned char *in, size_t len)
{
    CVerusHashV2 &vh = hasher(SOLUTION_VERUSHHASH_V2_1);
    vh.Reset();
    vh.Write(in, len);
    vh.Finalize2b(out);
}

static const unsigned char BLAKE2Bpersonal[16] = { 'V','e','r','u','s','D','e','f','a','u','l','t','H','a','s','h' };

// block header layout
static const size_t HDR_PREVBLOCK   = 4;
static const size_t HDR_MERKLEROOT  = 4 + 32;
static const size_t HDR_SAPLINGROOT = 4 + 32 + 32;
static const size_t HDR_BITS        = 4 + 32 + 32 + 32 + 4;
static const size_t HDR_NONCE       = 4 + 32 + 32 + 32 + 4 + 4;
static const size_t HDR_SIZE        = 140;
static const size_t SOLN_OFFSET     = HDR_SIZE + 3;               // skip the compact size prefix of the solution
static const size_t SOLN_HEADER_SIZE = 4 + 1 + 1 + 2 + 32 + 32;   // version, descr, numPBaaS, extraSpace, hashPrevMMRRoot, hashBlockMMRRoot
static const size_t SOLN_PBAAS_CID_SIZE = 20;                     // hash160
static const size_t SOLN_PBAAS_PREHASH_SIZE = 32;                 // blake2b of the pre header

void verushash_v2b2(unsigned char *out, const unsigned char *in, size_t len)
{
    // work on a copy, non-canonical data may have to be cleared before hashing
    std::vector<unsigned char> copy(in, in + len);
    unsigned char *buff = copy.data();

    // detect pbaas, validate and clear non-canonical data if needed
    if (len >= SOLN_OFFSET + SOLN_HEADER_SIZE + SOLN_PBAAS_CID_SIZE + SOLN_PBAAS_PREHASH_SIZE)
    {
        unsigned char *solution = buff + SOLN_OFFSET;
        uint32_t sol_ver = (uint32_t)solution[0] | ((uint32_t)solution[1] << 8) |
                           ((uint32_t)solution[2] << 16) | ((uint32_t)solution[3] << 24);
        const uint8_t numPBaaSHeaders = solution[5];

        if (sol_ver > 6 && numPBaaSHeaders > 0)
        {
            unsigned char preHeader[32 + 32 + 32 + 32 + 4 + 32 + 32] = { 0, };

            // copy non-canonical items from block header
            memcpy(&preHeader[0], buff + HDR_PREVBLOCK, 32);     // hashPrevBlock
            memcpy(&preHeader[32], buff + HDR_MERKLEROOT, 32);   // hashMerkleRoot
            memcpy(&preHeader[64], buff + HDR_SAPLINGROOT, 32);  // hashFinalSaplingRoot
            memcpy(&preHeader[96], buff + HDR_NONCE, 32);        // nNonce (if nonce changes must update preHeaderHash in solution)
            memcpy(&preHeader[128], buff + HDR_BITS, 4);         // nBits
            memcpy(&preHeader[132], solution + 8, 32 + 32);      // hashPrevMMRRoot, hashBlockMMRRoot

            // if the data has already been cleared of non-canonical data, just continue along
            bool cleared = true;
            for (size_t i = 0; i < sizeof(preHeader); i++)
            {
                if (preHeader[i] != 0) { cleared = false; break; }
            }

            if (!cleared)
            {
                // detect merged mining by looking for preHeaderHash (blake2b) in first pbaas chain definition
                unsigned char preHeaderHash[32];
                bool matched = false;
                if (verus_blake2b(preHeaderHash, sizeof(preHeaderHash), preHeader, sizeof(preHeader), BLAKE2Bpersonal) == 0)
                {
                    matched = memcmp(preHeaderHash,
                                     solution + SOLN_HEADER_SIZE + SOLN_PBAAS_CID_SIZE,
                                     SOLN_PBAAS_PREHASH_SIZE) == 0;
                }

                if (matched)
                {
                    // clear non-canonical data for pbaas merge mining
                    memset(buff + HDR_PREVBLOCK, 0, 32 + 32 + 32);  // hashPrevBlock, hashMerkleRoot, hashFinalSaplingRoot
                    memset(buff + HDR_BITS, 0, 4);                  // nBits
                    memset(buff + HDR_NONCE, 0, 32);                // nNonce
                    memset(solution + 8, 0, 32 + 32);               // hashPrevMMRRoot, hashBlockMMRRoot
                }
                else
                {
                    // invalid share, pbaas activated must be pbaas mining capatible
                    memset(out, 0xff, 32);
                    return;
                }
            }
        }
    }

    CVerusHashV2 &vh = hasher(SOLUTION_VERUSHHASH_V2_2);
    vh.Reset();
    vh.Write(buff, len);
    vh.Finalize2b(out);
}
