# Changelog

### 1.0.0 - Verus solo stratum server
  * Reduced s-nomp to a single process, command line only solo mining stratum server for VerusCoin
  * Removed the website, API, payment processing, redis, MPOS mode, profit switching, clustering and all other coins
  * Added an interactive console and `scripts/cli.js` commands: miners, hashrate, status, blocks, loglevel, stop
  * Hashing module rebuilt from the portable VerusHash code so it compiles on ARM, no libsodium or boost needed
  * No npm dependencies left, node-stratum-pool is included as `lib/stratum` (bignum replaced by BigInt)
  * The server waits for the daemon instead of giving up when it is not reachable

### 20161127
  * Fixed payment processor crashes
  * Fixed varDiff and set default to 0.125
  * Fixed merkleRoot issue with multiple transactions in each block
  * Fixed incorrect hashrates
  * Begin compatibility testing with Node 7+
  * Added t_address -> z_address -> t_address coin transfer function
  

