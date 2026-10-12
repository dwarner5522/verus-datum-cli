# Verus solo stratum server

A small, command line only stratum server for solo mining [VerusCoin](https://verus.io) (VerusHash 2.2)
with your own miners, for example a handful of Orange Pis running ccminer.

It is a stripped down s-nomp: the website, payment processing, redis, profit switching, clustering and
all other coins are gone. What is left is one Node.js process that talks to your Verus daemon, hands out
work to your miners and tells you which miners are connected and how fast they are hashing.

* runs on ARM (Orange Pi, Raspberry Pi, ...) as well as x86 - the hashing code is plain C/C++
* no npm dependencies, no database, about 60 MB of memory
* interactive console plus a command line client for scripts and remote shells

## Requirements

* A synced Verus daemon (`verusd`) with RPC enabled, on the same machine or reachable over the network
* [Node.js](https://nodejs.org) 12 or newer with npm
* A C++ compiler, make and python3 to build the hashing module

On Debian, Ubuntu or Armbian:

```bash
sudo apt-get install build-essential python3 nodejs npm
```

## Installation

```bash
git clone https://github.com/dwarner5522/verus-datum-cli verus-stratum
cd verus-stratum
npm install        # builds the verushash module
npm test           # optional: checks the build against real Verus blocks
cp config_example.json config.json
```

`npm test` does not need a daemon. It is worth running once on a new machine: it proves that the
hashing module built for that CPU produces the same block hashes as the Verus network.

## Setting up the Verus daemon

`VRSC.conf` (usually `~/.komodo/VRSC/VRSC.conf`) needs RPC access for the stratum server:

```
server=1
rpcuser=rpcuser
rpcpassword=use-a-long-random-password
rpcport=27486
rpcallowip=127.0.0.1
```

## Where the block reward goes

Set `payoutAddress` in `config.json` to the R-address that should receive the block rewards. The
server then asks the daemon to pay that address with every request for work, and checks each block
template it gets back: work whose reward would go anywhere else is never handed to a miner. `status`
shows the address and whether the current template pays it.

**The user name of a miner has no influence on where the reward goes.** Without a `payoutAddress`
the daemon decides: the address given with `mineraddress=<R-address>` in `VRSC.conf`, or else an
address of the daemon's own wallet.

The daemon keeps a block template for a few seconds and gives it to whoever asks next. If another
program gets block templates from the same daemon with a different payout, the two can receive each
other's templates. This server then waits (`status` says so) instead of mining for the other address,
but the other program may not check. Use one daemon per payout address.

Optional: the server polls the daemon for new work once per second. To be told about new blocks
immediately, add this to `VRSC.conf`:

```
blocknotify=node /path/to/verus-stratum/scripts/cli.js blocknotify %s
```

## Merge mining PBaaS chains

Nothing has to be set up in this server. Run the daemon of a PBaaS chain (for example
`verusd -chain=vDEX`) on the same machine as the VRSC daemon and switch mining on in it with
`verus -chain=vDEX setgenerate true 1`. It then registers its blocks with the VRSC daemon, which
includes them in the work this server hands out. A share that is good enough for the PBaaS chain but
not for VRSC is submitted as well, and the VRSC daemon passes it on.

`status` shows how many chains the current work includes. The block reward of a PBaaS chain goes to
the address its own daemon is set up with (`setminingdistribution` or `mineraddress`), not to the
`payoutAddress` above.

## Configuration

Edit `config.json`:

| Option | Meaning |
| --- | --- |
| `daemon` | host, port, user and password of the Verus daemon RPC interface |
| `payoutAddress` | R-address the block rewards are paid to, see above. Leave empty to let the daemon decide |
| `blocksFile` | where found blocks are recorded, relative to the config file. Default: `blocks.log` next to the server |
| `ports` | stratum ports the miners connect to, each with a starting difficulty `diff` and optional `varDiff` settings |
| `stratumHost` | address to listen on, `0.0.0.0` for all interfaces |
| `cliPort`, `cliHost` | where the running server listens for `scripts/cli.js`, keep it on `127.0.0.1` |
| `logLevel` | `debug` (every share), `info`, `warning` or `error` |
| `blockRefreshInterval` | how often the daemon is asked for new work, in milliseconds |
| `jobRebroadcastTimeout` | resend work to the miners after this many seconds without a change |
| `connectionTimeout` | drop a miner that has not submitted a share for this many seconds |
| `hashrateWindow` | number of seconds the "current" hashrate is averaged over |
| `statusInterval` | write a one line summary to the log every this many seconds, 0 to turn it off |
| `banning` | optionally ban addresses that send mostly invalid shares |

One unit of difficulty is 8192 hashes. With the default `diff` of 8192 a share is about 67 million
hashes, one every 13 seconds or so for a board doing 5 MH/s. `varDiff` then adjusts each miner so it
submits a share about every `targetTime` seconds, slow boards end up with a lower difficulty.

## Running

```bash
npm start
```

When started in a terminal the server shows a `verus>` prompt:

```
verus> miners
WORKER  IP            STATUS   CONNECTED  DIFF     RATE 5m    RATE 1h  ACCEPTED  REJECTED  STALE  LAST SHARE
opi5-1  192.168.1.21  online      2h 13m  9.22 k  5.12 MH/s  5.08 MH/s       532         1      2      4s ago
opi5-2  192.168.1.22  online      2h 13m  8.19 k  4.97 MH/s  5.01 MH/s       519         0      1     11s ago
opi5-3  192.168.1.23  OFFLINE          -       -    0.00 H/s  3.10 MH/s       301         0      0     25m ago

2 miners online, 1 offline - total hashrate 10.09 MH/s (5m), 13.19 MH/s (1h)
```

| Command | |
| --- | --- |
| `miners` | the miners that are or were connected: address, time connected, difficulty, hashrates, share counts |
| `hashrate` | hashrate of the pool and of each miner over the last minutes, the last hour and since it first connected, plus its best share |
| `status` | daemon and network state, current job, total hashrate, share and block counts, average time to find a block |
| `blocks` | blocks found by this server (also kept in `blocks.log`) |
| `json` | everything above as one JSON object, for scripts and dashboards |
| `loglevel [level]` | show or change the log level while running |
| `stop` | shut down (`quit`, `exit`, Ctrl+C and Ctrl+D do the same) |
| `help` | list the commands |

The same commands work from any other shell on the machine while the server is running, which is how
you query it when it runs in the background:

```bash
node scripts/cli.js miners
node scripts/cli.js hashrate
watch -n 10 node scripts/cli.js miners
```

Hashrates are estimated from the shares a miner submits, so they jump around for the first minutes and
will never exactly match what the miner itself reports. A miner that drops off the network stays in
the list as `OFFLINE` for a day so you notice it.

### Running as a service

`scripts/verus-stratum.service` is an example systemd unit. Adjust the user and paths in it, then:

```bash
sudo cp scripts/verus-stratum.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now verus-stratum
journalctl -u verus-stratum -f      # log
node scripts/cli.js miners          # console commands
```

The server keeps trying when the daemon is not reachable yet, so the start order at boot does not matter.

## Connecting the miners

Point each miner at the machine running the server. The user name is free text and only used to tell
the miners apart; with `<anything>.<name>` the part after the dot is what the `miners` command shows.
For ccminer:

```bash
./ccminer -a verus -o stratum+tcp://192.168.1.10:9999 -u solo.opi5-1 -p x -t 8
```

Give every board its own name. Miners with the same name are still listed separately as long as
their IP addresses differ.

## Notes

* All statistics live in memory and start from zero when the server is restarted. Only found blocks
  are written to disk (`blocks.log`).
* There is no authentication or TLS on the stratum port. Keep it on your local network.
* Solo mining pays nothing until one of your miners finds a block. `status` shows how long that takes
  on average with your current hashrate.

## Credits and license

Based on [s-nomp](https://github.com/s-nomp/s-nomp) / [VerusCoin s-nomp](https://github.com/VerusCoin/s-nomp)
(MIT), which is based on NOMP by Matthew Little.

`lib/stratum` is derived from [VerusCoin/node-stratum-pool](https://github.com/VerusCoin/node-stratum-pool),
which is licensed under the GPL version 2. Because that code is now part of this repository instead of an
external dependency, the server as a whole is distributed under the GPL version 2.

`native/verushash` is derived from [VerusCoin/verushash-node](https://github.com/VerusCoin/verushash-node)
(VerusHash by Michael Toutonghi, Haraka by kste, CLHash by Daniel Lemire and Owen Kaser), reduced to the
portable code path; see `native/verushash/LICENSE.verushash` and the headers of the source files.
