var fs = require('fs');

var util = require('./stratum/util.js');

/*
This module keeps track of every miner that talks to the stratum server. Everything lives in
memory: per worker share counters plus the timestamps and difficulties of the shares from the
last hour, which is what the hashrate estimates are calculated from.
 */

var HISTORY_MS = 60 * 60 * 1000;            // shares are kept this long for hashrate calculation
var FORGET_OFFLINE_MS = 24 * 60 * 60 * 1000; // offline workers are dropped from the list after this

module.exports = function (options) {

    var _this = this;

    var hashrateWindowMs = (options.hashrateWindow || 300) * 1000;
    var blocksFile = options.blocksFile;

    var workers = {};

    this.startTime = Date.now();
    this.hashrateWindow = hashrateWindowMs / 1000;
    this.totals = {accepted: 0, rejected: 0, stale: 0, acceptedDiff: 0};
    this.blocks = [];

    // blocks found by earlier runs
    if (blocksFile && fs.existsSync(blocksFile)) {
        fs.readFileSync(blocksFile, {encoding: 'utf8'}).split('\n').forEach(function (line) {
            if (!line.trim()) return;
            try {
                _this.blocks.push(JSON.parse(line));
            } catch (e) {}
        });
    }


    // "RAddress.opi1" is shown as "opi1", a user name without a worker part is shown as is
    var displayName = this.displayName = function (workerName) {
        var parts = String(workerName).split('.');
        if (parts.length > 1 && parts[1] && parts[1] !== 'noname')
            return parts[1];
        return parts[0];
    };

    var getWorker = function (workerName, ip) {
        var key = workerName + '@' + ip;
        if (!workers[key]) {
            workers[key] = {
                key: key,
                worker: workerName,
                name: displayName(workerName),
                ip: ip,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                lastShare: 0,
                accepted: 0,
                rejected: 0,
                stale: 0,
                acceptedDiff: 0,
                bestShare: 0,
                lastError: null,
                shares: []      // [timestamp, difficulty] of accepted shares within HISTORY_MS
            };
        }
        return workers[key];
    };

    var prune = function (worker, now) {
        var cutoff = now - HISTORY_MS;
        var i = 0;
        while (i < worker.shares.length && worker.shares[i][0] < cutoff) i++;
        if (i > 0) worker.shares.splice(0, i);
    };

    // estimated hashes per second from the accepted shares of the last windowMs
    var hashrate = function (worker, windowMs, now) {
        var since = now - windowMs;
        var diffSum = 0;
        for (var i = worker.shares.length - 1; i >= 0 && worker.shares[i][0] >= since; i--)
            diffSum += worker.shares[i][1];
        // a worker that showed up less than a full window ago is averaged over the time it was around
        var elapsed = Math.min(windowMs, now - worker.firstSeen);
        if (elapsed < 1000) elapsed = 1000;
        return diffSum * util.hashesPerDiff / (elapsed / 1000);
    };


    // called when a miner authorizes so it is listed even before its first share
    this.minerSeen = function (workerName, ip) {
        getWorker(workerName, ip).lastSeen = Date.now();
    };

    this.recordShare = function (isValidShare, isValidBlock, data) {
        var now = Date.now();
        var worker = getWorker(data.worker, data.ip);
        worker.lastSeen = now;

        if (isValidShare) {
            worker.accepted++;
            worker.acceptedDiff += data.difficulty;
            worker.lastShare = now;
            worker.shares.push([now, data.difficulty]);
            prune(worker, now);
            var shareDiff = parseFloat(data.shareDiff);
            if (shareDiff > worker.bestShare) worker.bestShare = shareDiff;
            _this.totals.accepted++;
            _this.totals.acceptedDiff += data.difficulty;
        }
        else if (data.error === 'job not found') {
            worker.stale++;
            worker.lastError = data.error;
            _this.totals.stale++;
        }
        else {
            worker.rejected++;
            worker.lastError = data.error;
            _this.totals.rejected++;
        }

        if (isValidBlock) {
            var block = {
                time: now,
                height: data.height,
                hash: data.blockHash,
                worker: data.worker,
                ip: data.ip,
                reward: data.blockReward / 100000000,
                pbaasOnly: !!data.blockOnlyPBaaS
            };
            _this.blocks.push(block);
            if (blocksFile) {
                fs.appendFile(blocksFile, JSON.stringify(block) + '\n', function () {});
            }
        }
    };

    /*
     Returns one entry per known worker, combining the share statistics with the live stratum
     connections (the object returned by stratumServer.getStratumClients()).
     */
    this.getMiners = function (stratumClients) {
        var now = Date.now();
        var online = {};

        Object.keys(stratumClients || {}).forEach(function (id) {
            var client = stratumClients[id];
            var workerName = client.workerName || '(connecting)';
            var key = workerName + '@' + client.remoteAddress;
            if (!online[key]) {
                online[key] = {
                    worker: workerName,
                    ip: client.remoteAddress,
                    connections: 0,
                    connectedAt: client.connectedAt,
                    difficulty: client.difficulty,
                    userAgent: client.userAgent
                };
            }
            online[key].connections++;
            if (client.connectedAt < online[key].connectedAt)
                online[key].connectedAt = client.connectedAt;
            if (client.difficulty)
                online[key].difficulty = client.difficulty;
        });

        var miners = [];
        var seen = {};

        Object.keys(workers).forEach(function (key) {
            var worker = workers[key];
            var connection = online[key];
            if (!connection && now - worker.lastSeen > FORGET_OFFLINE_MS) {
                delete workers[key];
                return;
            }
            prune(worker, now);
            seen[key] = true;
            miners.push({
                name: worker.name,
                worker: worker.worker,
                ip: worker.ip,
                online: !!connection,
                connections: connection ? connection.connections : 0,
                connectedAt: connection ? connection.connectedAt : null,
                difficulty: connection ? connection.difficulty : null,
                userAgent: connection ? connection.userAgent : null,
                firstSeen: worker.firstSeen,
                lastSeen: worker.lastSeen,
                lastShare: worker.lastShare,
                accepted: worker.accepted,
                rejected: worker.rejected,
                stale: worker.stale,
                bestShare: worker.bestShare,
                lastError: worker.lastError,
                hashrate: hashrate(worker, hashrateWindowMs, now),
                hashrate1h: hashrate(worker, HISTORY_MS, now),
                hashrateAvg: worker.acceptedDiff * util.hashesPerDiff / (Math.max(now - worker.firstSeen, 1000) / 1000)
            });
        });

        // connections that have not authorized or submitted anything yet
        Object.keys(online).forEach(function (key) {
            if (seen[key]) return;
            var connection = online[key];
            miners.push({
                name: displayName(connection.worker),
                worker: connection.worker,
                ip: connection.ip,
                online: true,
                connections: connection.connections,
                connectedAt: connection.connectedAt,
                difficulty: connection.difficulty,
                userAgent: connection.userAgent,
                firstSeen: connection.connectedAt,
                lastSeen: now,
                lastShare: 0,
                accepted: 0,
                rejected: 0,
                stale: 0,
                bestShare: 0,
                lastError: null,
                hashrate: 0,
                hashrate1h: 0,
                hashrateAvg: 0
            });
        });

        miners.sort(function (a, b) {
            if (a.name !== b.name) return a.name < b.name ? -1 : 1;
            return a.ip < b.ip ? -1 : (a.ip > b.ip ? 1 : 0);
        });

        return miners;
    };

    this.getPoolHashrate = function (miners) {
        var total = {hashrate: 0, hashrate1h: 0, hashrateAvg: 0, online: 0, offline: 0};
        miners.forEach(function (miner) {
            total.hashrate += miner.hashrate;
            total.hashrate1h += miner.hashrate1h;
            if (miner.online) total.online++;
            else total.offline++;
        });
        total.hashrateAvg = _this.totals.acceptedDiff * util.hashesPerDiff / (Math.max(Date.now() - _this.startTime, 1000) / 1000);
        return total;
    };
};
