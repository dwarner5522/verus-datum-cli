var util = require('./stratum/util.js');

/*
Implements the commands of the command line interface. The same commands are available on the
interactive console of the running server and remotely through scripts/cli.js.
 */

var formatHashrate = util.getReadableHashRateString;

function formatNumber(n) {
    n = Number(n) || 0;
    if (n !== 0 && Math.abs(n) < 1) return String(parseFloat(n.toPrecision(3)));
    var units = ['', ' k', ' M', ' G', ' T', ' P'];
    var i = 0;
    while (Math.abs(n) >= 1000 && i < units.length - 1) {
        n = n / 1000;
        i++;
    }
    return (i === 0 ? String(Math.round(n * 100) / 100) : n.toFixed(2)) + units[i];
}

function formatDuration(ms) {
    if (!isFinite(ms)) return 'never';
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + 'h ' + (minutes % 60) + 'm';
    var days = Math.floor(hours / 24);
    if (days < 730) return days + 'd ' + (hours % 24) + 'h';
    return (days / 365.25).toFixed(1) + ' years';
}

function formatAgo(timestamp, now) {
    if (!timestamp) return 'never';
    return formatDuration(now - timestamp) + ' ago';
}

function formatTime(timestamp) {
    var d = new Date(timestamp);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// plain text table, columns given as [title, alignRight]
function table(columns, rows) {
    var widths = columns.map(function (column, i) {
        return rows.reduce(function (width, row) {
            return Math.max(width, String(row[i]).length);
        }, column[0].length);
    });
    var line = function (cells) {
        return cells.map(function (cell, i) {
            cell = String(cell);
            var padding = ' '.repeat(widths[i] - cell.length);
            return columns[i][1] ? padding + cell : cell + padding;
        }).join('  ').replace(/\s+$/, '');
    };
    return [line(columns.map(function (column) { return column[0]; }))]
        .concat(rows.map(line))
        .join('\n');
}


module.exports = function (context) {

    var config = context.config;
    var logger = context.logger;
    var stats = context.stats;
    var pool = context.pool;

    var windowLabel = Math.round(stats.hashrateWindow / 60 * 10) / 10 + 'm';

    var getMiners = function () {
        var clients = pool.stratumServer ? pool.stratumServer.getStratumClients() : {};
        return stats.getMiners(clients);
    };

    var summary = function (miners) {
        var total = stats.getPoolHashrate(miners);
        return total.online + ' miner' + (total.online === 1 ? '' : 's') + ' online' +
            (total.offline ? ', ' + total.offline + ' offline' : '') +
            ' - total hashrate ' + formatHashrate(total.hashrate) + ' (' + windowLabel + '), ' +
            formatHashrate(total.hashrate1h) + ' (1h)';
    };


    var commands = {};

    commands.help = {
        description: 'show this list of commands',
        run: function (params, reply) {
            var names = Object.keys(commands).filter(function (name) {
                return !commands[name].hidden;
            });
            var width = names.reduce(function (w, name) {
                return Math.max(w, (name + ' ' + (commands[name].usage || '')).length);
            }, 0);
            reply(names.map(function (name) {
                var left = (name + ' ' + (commands[name].usage || ''));
                return '  ' + left + ' '.repeat(width - left.length) + '   ' + commands[name].description;
            }).join('\n'));
        }
    };

    commands.miners = {
        description: 'list the miners that are connected, with their hashrates and share counts',
        run: function (params, reply) {
            var now = Date.now();
            var miners = getMiners();
            if (miners.length === 0) {
                reply('No miners have connected yet.');
                return;
            }
            var rows = miners.map(function (miner) {
                return [
                    miner.name,
                    miner.ip,
                    miner.online ? (miner.connections > 1 ? 'online x' + miner.connections : 'online') : 'OFFLINE',
                    miner.online ? formatDuration(now - miner.connectedAt) : '-',
                    miner.difficulty ? formatNumber(miner.difficulty) : '-',
                    formatHashrate(miner.hashrate),
                    formatHashrate(miner.hashrate1h),
                    miner.accepted,
                    miner.rejected,
                    miner.stale,
                    formatAgo(miner.lastShare, now)
                ];
            });
            reply(table([
                ['WORKER'], ['IP'], ['STATUS'], ['CONNECTED', true], ['DIFF', true],
                ['RATE ' + windowLabel, true], ['RATE 1h', true],
                ['ACCEPTED', true], ['REJECTED', true], ['STALE', true], ['LAST SHARE', true]
            ], rows) + '\n\n' + summary(miners));
        }
    };

    commands.hashrate = {
        description: 'show the hashrate of the whole pool and of each miner',
        run: function (params, reply) {
            var miners = getMiners();
            var total = stats.getPoolHashrate(miners);
            var rows = miners.map(function (miner) {
                return [
                    miner.name,
                    miner.ip,
                    miner.online ? 'online' : 'OFFLINE',
                    formatHashrate(miner.hashrate),
                    formatHashrate(miner.hashrate1h),
                    formatHashrate(miner.hashrateAvg),
                    miner.bestShare ? formatNumber(miner.bestShare) : '-'
                ];
            });
            rows.push(['TOTAL', '', '', formatHashrate(total.hashrate), formatHashrate(total.hashrate1h), formatHashrate(total.hashrateAvg), '']);

            var text = table([
                ['WORKER'], ['IP'], ['STATUS'],
                ['RATE ' + windowLabel, true], ['RATE 1h', true], ['RATE AVG', true], ['BEST SHARE', true]
            ], rows);

            var job = pool.jobManager && pool.jobManager.currentJob;
            if (job)
                text += '\n\nA share of difficulty ' + formatNumber(job.difficulty) + ' or more solves the current block.';
            text += '\nHashrates are estimated from accepted shares, so they fluctuate and need a few minutes to settle.';
            reply(text);
        }
    };

    commands.status = {
        description: 'show the state of the server, the daemon and the network',
        run: function (params, reply) {
            var now = Date.now();
            var miners = getMiners();
            var total = stats.getPoolHashrate(miners);
            var job = pool.jobManager && pool.jobManager.currentJob;
            var daemonAddress = (config.daemon.host || '127.0.0.1') + ':' + config.daemon.port;

            var finish = function (info, miningInfo, daemonError) {
                var lines = [];
                var add = function (label, value) {
                    lines.push((label + ':').padEnd(22) + value);
                };

                add('Server uptime', formatDuration(now - stats.startTime));
                add('Stratum', pool.stratumServer
                    ? 'listening on port ' + Object.keys(config.ports).join(', ')
                    : 'NOT STARTED - waiting for the daemon');
                if (daemonError)
                    add('Daemon', daemonAddress + ' UNREACHABLE (' + (daemonError.message || daemonError.type || JSON.stringify(daemonError)) + ')');
                else {
                    add('Daemon', daemonAddress + ', ' + (info.testnet ? 'testnet' : 'mainnet') + ', ' + info.connections + ' peers, version ' + (info.VRSCversion || info.version));
                    add('Chain height', info.blocks + (info.longestchain && info.longestchain > info.blocks ? ' (syncing, longest chain ' + info.longestchain + ')' : ''));
                    add('Network difficulty', formatNumber(info.difficulty));
                    if (miningInfo)
                        add('Network hashrate', formatHashrate(miningInfo.networkhashps));
                }
                if (pool.payout && pool.payout.address)
                    add('Block rewards', 'paid to ' + pool.payout.address + (pool.payout.verified
                        ? ' (checked in the current block template)'
                        : (pool.payout.error ? ' - NOT MINING: ' + pool.payout.error : ' (not checked yet)')));
                else
                    add('Block rewards', 'paid to the address the daemon is set up with (no payoutAddress in the config)');
                if (job)
                    add('Current job', 'height ' + job.rpcData.height + ', ' + (job.rpcData.transactions.length + 1) + ' transaction' + (job.rpcData.transactions.length ? 's' : '') + ', block reward ' + (job.blockReward / 100000000) + ' ' + config.coin.symbol.toUpperCase());
                add('Miners', total.online + ' online' + (total.offline ? ', ' + total.offline + ' offline' : ''));
                add('Pool hashrate', formatHashrate(total.hashrate) + ' (' + windowLabel + '), ' + formatHashrate(total.hashrate1h) + ' (1h), ' + formatHashrate(total.hashrateAvg) + ' (since start)');
                add('Shares', stats.totals.accepted + ' accepted, ' + stats.totals.rejected + ' rejected, ' + stats.totals.stale + ' stale');

                var sessionBlocks = stats.blocks.filter(function (block) {
                    return block.time >= stats.startTime;
                }).length;
                add('Blocks found', sessionBlocks + ' since start, ' + stats.blocks.length + ' in total');

                if (job) {
                    var rate = total.hashrate || total.hashrate1h;
                    var hashesPerBlock = Math.pow(2, 256) / Number(job.target);
                    add('Time to find block', rate > 0
                        ? 'about ' + formatDuration(hashesPerBlock / rate * 1000) + ' on average at the current hashrate and difficulty'
                        : 'unknown (no hashrate yet)');
                }
                reply(lines.join('\n'));
            };

            pool.daemon.cmd('getinfo', [], function (error, info) {
                if (error || !info) {
                    finish(null, null, error || {message: 'empty response'});
                    return;
                }
                pool.daemon.cmd('getmininginfo', [], function (error, miningInfo) {
                    finish(info, error ? null : miningInfo, null);
                }, 5);
            }, 5);
        }
    };

    commands.json = {
        description: 'everything the other commands show, as one JSON object for scripts and dashboards',
        run: function (params, reply) {
            var now = Date.now();
            var miners = getMiners();
            var total = stats.getPoolHashrate(miners);
            var job = pool.jobManager && pool.jobManager.currentJob;

            var finish = function (info, miningInfo, daemonError) {
                var rate = total.hashrate || total.hashrate1h;
                var hashesPerBlock = job ? Math.pow(2, 256) / Number(job.target) : null;
                reply(JSON.stringify({
                    time: now,
                    startTime: stats.startTime,
                    hashrateWindow: stats.hashrateWindow,
                    stratum: {
                        listening: !!pool.stratumServer,
                        ports: Object.keys(config.ports).map(Number)
                    },
                    daemon: daemonError ? {
                        reachable: false,
                        error: daemonError.message || daemonError.type || JSON.stringify(daemonError)
                    } : {
                        reachable: true,
                        testnet: !!info.testnet,
                        version: info.VRSCversion || info.version,
                        connections: info.connections,
                        blocks: info.blocks,
                        longestChain: info.longestchain,
                        difficulty: info.difficulty,
                        networkHashrate: miningInfo ? miningInfo.networkhashps : null
                    },
                    payout: pool.payout || {address: null},
                    job: job ? {
                        height: job.rpcData.height,
                        transactions: job.rpcData.transactions.length + 1,
                        reward: job.blockReward / 100000000,
                        difficulty: job.difficulty,
                        hashesPerBlock: hashesPerBlock,
                        secondsPerBlock: rate > 0 ? hashesPerBlock / rate : null
                    } : null,
                    hashrate: {current: total.hashrate, hour: total.hashrate1h, average: total.hashrateAvg},
                    miners: {online: total.online, offline: total.offline, list: miners},
                    shares: stats.totals,
                    blocks: stats.blocks.slice(-50)
                }));
            };

            if (!pool.daemon) {
                finish(null, null, {message: 'not connected yet'});
                return;
            }
            pool.daemon.cmd('getinfo', [], function (error, info) {
                if (error || !info) {
                    finish(null, null, error || {message: 'empty response'});
                    return;
                }
                pool.daemon.cmd('getmininginfo', [], function (error, miningInfo) {
                    finish(info, error ? null : miningInfo, null);
                }, 5);
            }, 5);
        }
    };

    commands.blocks = {
        description: 'list the blocks this server has found',
        run: function (params, reply) {
            if (stats.blocks.length === 0) {
                reply('No blocks found yet.');
                return;
            }
            var rows = stats.blocks.slice(-50).map(function (block) {
                return [
                    formatTime(block.time),
                    block.height,
                    stats.displayName(block.worker),
                    block.pbaasOnly ? 'PBaaS only' : block.reward + ' ' + config.coin.symbol.toUpperCase(),
                    block.hash
                ];
            });
            reply(table([['FOUND'], ['HEIGHT', true], ['WORKER'], ['REWARD'], ['HASH']], rows));
        }
    };

    commands.loglevel = {
        usage: '[level]',
        description: 'show or change how much is logged (' + logger.levels.join(', ') + ')',
        run: function (params, reply) {
            if (!params[0]) {
                reply('Log level is ' + logger.getLevel());
                return;
            }
            if (!logger.setLevel(params[0])) {
                reply('Unknown log level "' + params[0] + '", use one of: ' + logger.levels.join(', '));
                return;
            }
            reply('Log level set to ' + params[0]);
        }
    };

    commands.blocknotify = {
        usage: '<hash>',
        description: 'tell the server the daemon has a new block (for the daemon\'s -blocknotify option)',
        run: function (params, reply) {
            // s-nomp style "blocknotify <coin> <hash>" is accepted as well
            pool.processBlockNotify(params[params.length - 1], 'blocknotify script');
            reply('Pool notified');
        }
    };

    commands.stop = {
        description: 'shut the server down',
        run: function (params, reply) {
            reply('Shutting down');
            context.shutdown();
        }
    };


    this.names = Object.keys(commands);

    this.execute = function (command, params, reply) {
        command = String(command || '').toLowerCase();
        if (command === 'workers') command = 'miners';
        if (command === 'quit' || command === 'exit') command = 'stop';
        if (!Object.prototype.hasOwnProperty.call(commands, command)) {
            reply('Unrecognized command "' + command + '", type "help" for the list of commands');
            return;
        }
        try {
            commands[command].run(params || [], reply);
        } catch (e) {
            reply('Command failed: ' + e.message);
        }
    };
};
