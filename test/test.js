/*
Self test, run with "npm test". No Verus daemon is needed.

 1. The compiled verushash module is checked against real VerusCoin mainnet blocks, which
    proves the build on this machine (x86, ARM, ...) produces correct hashes.
 2. The stratum server is run against a fake daemon that serves a real block template, and a
    small miner written in JavaScript connects, mines and submits shares and a block.
 */
var assert = require('assert');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');
var fs = require('fs');

var fixtures = require('./fixtures.json');

var vh = require('../build/Release/verushash.node');
var Stratum = require('../lib/stratum');
var merkle = require('../lib/stratum/merkleTree.js');
var BlockTemplate = require('../lib/stratum/blockTemplate.js');
var Stats = require('../lib/stats.js');
var Commands = require('../lib/commands.js');
var PoolLogger = require('../lib/logger.js');
var payout = require('../lib/stratum/payout.js');

var util = Stratum.util;

var passed = 0;
var check = function (description, fn) {
    fn();
    passed++;
    console.log('  ok - ' + description);
};


/* ---------------------------------------------------------------------------------------- */
console.log('verushash module');

check('hashes of real mainnet block headers match the block hashes', function () {
    fixtures.blocks.forEach(function (block) {
        var hash = vh.hash2b2(Buffer.from(block.header, 'hex'));
        assert.strictEqual(util.reverseBuffer(hash).toString('hex'), block.hash, 'block ' + block.height);
    });
});

check('hashing does not modify its input', function () {
    var header = Buffer.from(fixtures.blocks[1].header, 'hex');
    vh.hash2b2(header);
    assert.strictEqual(header.toString('hex'), fixtures.blocks[1].header);
});

check('a header with tampered merge mining data is rejected', function () {
    var header = Buffer.from(fixtures.blocks[1].header, 'hex');
    header[40] ^= 1; // merkle root no longer matches the pre header hash stored in the solution
    assert.strictEqual(vh.hash2b2(header).toString('hex'), 'ff'.repeat(32));
});

check('short and empty inputs are handled', function () {
    ['hash', 'hash2', 'hash2b', 'hash2b1', 'hash2b2'].forEach(function (name) {
        assert.strictEqual(vh[name](Buffer.alloc(0)).length, 32);
        assert.strictEqual(vh[name](Buffer.from('Test1234')).length, 32);
    });
    assert.throws(function () { vh.hash2b2('not a buffer'); }, TypeError);
});


/* ---------------------------------------------------------------------------------------- */
console.log('block assembly');

check('merkle roots of real blocks are reproduced', function () {
    fixtures.blocks.forEach(function (block) {
        var root = merkle.getRoot(
            {transactions: block.tx.slice(1).map(function (hash) { return {hash: hash}; })},
            util.reverseHex(block.tx[0])
        );
        assert.strictEqual(root, block.merkleroot, 'block ' + block.height);
    });
});

check('compact bits are converted to targets', function () {
    assert.strictEqual(util.bigIntFromBitsHex('1b064e15'), BigInt('0x' + fixtures.template.target));
    assert.strictEqual(util.bigIntFromBitsHex('1d00ffff'), BigInt('0xffff') << 208n);
});

check('variable length integers are canonical', function () {
    assert.strictEqual(util.varIntBuffer(1).toString('hex'), '01');
    assert.strictEqual(util.varIntBuffer(252).toString('hex'), 'fc');
    assert.strictEqual(util.varIntBuffer(253).toString('hex'), 'fdfd00');
    assert.strictEqual(util.varIntBuffer(0x1234).toString('hex'), 'fd3412');
    assert.strictEqual(util.varIntBuffer(0x12345).toString('hex'), 'fe45230100');
});

check('a header built from a real block template carries valid merge mining data', function () {
    // the daemon stores a hash of previous block, merkle root, nonce, ... inside the solution,
    // so this only passes when the header is serialized exactly like the daemon expects it
    assert.strictEqual(BlockTemplate.validate(fixtures.template), null);
    var job = new BlockTemplate('1', fixtures.template);
    var header = job.serializeHeader(util.packUInt32LE(fixtures.template.curtime).toString('hex'));
    var solution = Buffer.from('fd4005' + fixtures.template.solution, 'hex');
    assert.strictEqual(header.length, 140);
    assert.strictEqual(solution.length, 1347);
    var hash = vh.hash2b2(Buffer.concat([header, solution]));
    assert.notStrictEqual(hash.toString('hex'), 'ff'.repeat(32));
});

check('merge-mined chains are read from the template', function () {
    var job = new BlockTemplate('1', fixtures.template);
    assert.strictEqual(job.mergedChains, 0);
    assert.strictEqual(job.mergedDifficulty, job.difficulty);

    // two PBaaS chains added by the daemon, the easier one at a tenth of the difficulty
    var template = JSON.parse(JSON.stringify(fixtures.template));
    template.solution = template.solution.substr(0, 10) + '03' + template.solution.substr(12);
    template.mergeminebits = '1b3f0cd2';
    job = new BlockTemplate('2', template);
    assert.strictEqual(job.mergedChains, 2);
    assert.ok(job.merged_target > job.target);
    assert.ok(Math.abs(job.difficulty / job.mergedDifficulty - 10) < 0.01);
});

check('unusable block templates are detected', function () {
    assert.ok(BlockTemplate.validate(null));
    assert.ok(BlockTemplate.validate({}));
    var template = JSON.parse(JSON.stringify(fixtures.template));
    delete template.coinbasetxn;
    assert.ok(/coinbasetxn/.test(BlockTemplate.validate(template)));
});


/* ---------------------------------------------------------------------------------------- */

console.log('payout address');

// the address of the key the coinbase of the template fixture pays to (as pay-to-pubkey)
var PAYOUT_ADDRESS = 'RD1F8kN86VdzSjTPnSAxSuDdT8ceeMyLsh';
var PAYOUT_SCRIPT = '76a91428dc6606e12dce6363cd4faa29267a4a4ed56b0a88ac';

// the template fixture with its reward paid to the given output script
var templatePaying = function (scriptHex) {
    var template = JSON.parse(JSON.stringify(fixtures.template));
    var outputs = payout.transactionOutputs(template.coinbasetxn.data);
    var oldScript = outputs[0].script.toString('hex');
    var data = template.coinbasetxn.data.replace(
        util.varIntBuffer(oldScript.length / 2).toString('hex') + oldScript,
        util.varIntBuffer(scriptHex.length / 2).toString('hex') + scriptHex);
    assert.notStrictEqual(data, template.coinbasetxn.data);
    template.coinbasetxn.data = data;
    template.coinbasetxn.hash = util.reverseBuffer(util.sha256d(Buffer.from(data, 'hex'))).toString('hex');
    return template;
};

check('an R-address is turned into its output script', function () {
    assert.strictEqual(payout.addressToScript(PAYOUT_ADDRESS).toString('hex'), PAYOUT_SCRIPT);
});

check('addresses with typing errors or of another kind are refused', function () {
    ['RD1F8kN86VdzSjTPnSAxSuDdT8ceeMyLsi', 'RD1F8kN86VdzSjTPnSAxSuDdT8ceeMyLs', '', null, 'mike@',
        'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'].forEach(function (address) {
        assert.throws(function () { payout.addressToScript(address); }, /R-address/, String(address));
    });
});

check('the outputs of a real coinbase transaction are read', function () {
    var outputs = payout.transactionOutputs(fixtures.template.coinbasetxn.data);
    assert.strictEqual(outputs.length, 2);
    assert.strictEqual(outputs[0].value, 300053839n);
    assert.strictEqual(outputs[0].script.length, 35);
    assert.strictEqual(outputs[1].value, 0n);
});

check('a coinbase is only accepted when all of its value goes to the payout address', function () {
    var script = Buffer.from(PAYOUT_SCRIPT, 'hex');
    // the fixture pays the daemon's own wallet key
    assert.ok(/different address/.test(payout.verifyCoinbase(fixtures.template.coinbasetxn.data, script)));
    assert.strictEqual(payout.verifyCoinbase(templatePaying(PAYOUT_SCRIPT).coinbasetxn.data, script), null);
    assert.ok(/different address/.test(payout.verifyCoinbase(
        templatePaying('76a914' + '11'.repeat(20) + '88ac').coinbasetxn.data, script)));
    assert.ok(/could not read/.test(payout.verifyCoinbase(fixtures.template.coinbasetxn.data.slice(0, 120), script)));
    assert.ok(/could not read/.test(payout.verifyCoinbase('', script)));
});


/* ---------------------------------------------------------------------------------------- */

// Fake Verus daemon, just enough JSON-RPC for the server to run
var FakeDaemon = function () {
    var _this = this;

    this.template = JSON.parse(JSON.stringify(fixtures.template));
    this.submitted = [];
    this.calls = {};
    this.online = true;

    var methods = {
        getinfo: function () {
            return {testnet: false, protocolversion: 170010, connections: 8, difficulty: 2402763754011.23,
                blocks: _this.template.height - 1, longestchain: _this.template.height - 1, VRSCversion: 'test'};
        },
        getmininginfo: function () {
            return {networkhashps: 631222660445, difficulty: 2402763754011.23};
        },
        getblocktemplate: function (params) {
            _this.templateRequest = params[0];
            return _this.template;
        },
        submitmergedblock: function (params) {
            _this.submitted.push(params[0]);
            return null;
        },
        getblock: function (params) {
            return {hash: params[0], confirmations: 1, tx: ['aa'.repeat(32)]};
        }
    };

    var server = http.createServer(function (req, res) {
        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            if (!_this.online) {
                req.socket.destroy();
                return;
            }
            var request = JSON.parse(body);
            _this.calls[request.method] = (_this.calls[request.method] || 0) + 1;
            var response = methods[request.method]
                ? {result: methods[request.method](request.params), error: null, id: request.id}
                : {result: null, error: {code: -32601, message: 'Method not found'}, id: request.id};
            res.end(JSON.stringify(response));
        });
    });

    this.start = function (callback) {
        server.listen(0, '127.0.0.1', function () {
            _this.port = server.address().port;
            callback();
        });
    };
    this.close = function () {
        server.close();
    };
};

// Minimal stratum miner that hashes with the same module as the server
var TestMiner = function (port, workerName) {
    var _this = this;
    var socket = net.connect(port, '127.0.0.1');
    var buffer = '';
    var nextId = 1;
    var pending = {};
    var counter = 0;

    this.job = null;
    this.target = null;
    this.extraNonce1 = null;
    this.onJob = null;

    socket.setEncoding('utf8');
    socket.on('data', function (data) {
        buffer += data;
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function (line) {
            if (!line) return;
            var message = JSON.parse(line);
            if (message.method === 'mining.set_target')
                _this.target = BigInt('0x' + message.params[0]);
            else if (message.method === 'mining.notify') {
                _this.job = message.params;
                if (_this.onJob) _this.onJob(message.params);
            }
            else if (message.id !== null && pending[message.id]) {
                var callback = pending[message.id];
                delete pending[message.id];
                callback(message);
            }
        });
    });
    socket.on('error', function () {});

    var send = function (method, params, callback) {
        var id = nextId++;
        pending[id] = callback;
        socket.write(JSON.stringify({id: id, method: method, params: params}) + '\n');
    };

    this.connect = function (callback) {
        send('mining.subscribe', ['test-miner/1.0', null, '127.0.0.1', port], function (reply) {
            _this.extraNonce1 = reply.result[1];
            send('mining.authorize', [workerName, 'x'], function (reply) {
                callback(reply.result);
            });
        });
    };

    // grinds until a hash meets the share target, like a real miner would
    this.mine = function () {
        var job = _this.job;
        var solution = Buffer.alloc(1347);
        Buffer.from('fd4005' + job[8], 'hex').copy(solution);
        Buffer.from(_this.extraNonce1, 'hex').copy(solution, 1347 - 15);

        // miners hash the header with the fields the daemon fills in later set to zero
        var cleared = Buffer.alloc(140 + 1347);
        Buffer.from(job[1], 'hex').copy(cleared, 0);        // version
        Buffer.from(job[5], 'hex').copy(cleared, 100);      // time
        solution.copy(cleared, 140);
        cleared.fill(0, 143 + 8, 143 + 8 + 64);             // MMR roots inside the solution

        for (var tries = 0; tries < 200000; tries++) {
            counter++;
            solution.writeUInt32LE(counter, 1347 - 8);
            cleared.writeUInt32LE(counter, 140 + 1347 - 8);
            var hash = util.bigIntFromBufferLE(vh.hash2b2(cleared));
            if (hash <= _this.target) {
                return {
                    params: [workerName, job[0], job[5], 'ab'.repeat(28), solution.toString('hex')],
                    hash: hash
                };
            }
        }
        throw new Error('no share found');
    };

    this.submit = function (share, callback) {
        send('mining.submit', share.params, callback);
    };

    this.sendRaw = function (text) {
        socket.write(text);
    };

    this.close = function () {
        socket.destroy();
    };
};

var freePort = function (callback) {
    var server = net.createServer();
    server.listen(0, '127.0.0.1', function () {
        var port = server.address().port;
        server.close(function () {
            callback(port);
        });
    });
};


var runServerTest = function (done) {
    console.log('stratum server');

    var daemon = new FakeDaemon();
    var blocksFile = path.join(os.tmpdir(), 'verus-stratum-test-blocks-' + process.pid + '.log');
    var pool, stats, commands, config;
    var shares = [];
    var logLines = [];

    var run = function (command, params) {
        var output;
        commands.execute(command, params || [], function (text) { output = text; });
        return output;
    };

    var finish = function () {
        pool.stop();
        daemon.close();
        try { fs.unlinkSync(blocksFile); } catch (e) {}
        done();
    };

    daemon.start(function () {
        freePort(function (stratumPort) {

            config = {
                coin: {name: 'verus', symbol: 'vrsc', algorithm: 'verushash'},
                daemon: {host: '127.0.0.1', port: daemon.port, user: 'u', password: 'p'},
                stratumHost: '127.0.0.1',
                ports: {},
                blockRefreshInterval: 100,
                jobRebroadcastTimeout: 55,
                connectionTimeout: 600,
                banning: {enabled: false}
            };
            // difficulty this low makes roughly every eighth hash a share
            config.ports[stratumPort] = {diff: 0.001};

            var logger = new PoolLogger({logLevel: 'debug', logColors: false});
            logger.output = function (line) { logLines.push(line); };
            stats = new Stats({hashrateWindow: 300, blocksFile: blocksFile});

            pool = Stratum.createPool(config, function (ip, port, workerName, password, callback) {
                stats.minerSeen(workerName, ip);
                callback({error: null, authorized: true, disconnect: false});
            });
            pool.on('share', function (isValidShare, isValidBlock, data) {
                stats.recordShare(isValidShare, isValidBlock, data);
                shares.push({valid: isValidShare, block: isValidBlock, data: data});
            }).on('log', function (severity, text) {
                logger[severity]('Pool', text);
            });
            commands = new Commands({config: config, logger: logger, stats: stats, pool: pool, shutdown: function () {}});

            pool.on('started', function () {
                var miner = new TestMiner(stratumPort, 'RTestAddress.opi5-1');
                var second = new TestMiner(stratumPort, 'opi_zero');

                miner.connect(function (authorized) {
                    check('a miner can subscribe and authorize', function () {
                        assert.strictEqual(authorized, true);
                        assert.strictEqual(miner.extraNonce1.length, 8);
                    });
                    check('the miner receives a target and a job', function () {
                        assert.strictEqual(miner.target, BigInt(Math.floor(util.diff1 / 0.001)));
                        assert.strictEqual(miner.job.length, 9);
                        assert.strictEqual(miner.job[2], util.reverseHex(fixtures.template.previousblockhash));
                        assert.strictEqual(miner.job[7], true);
                    });

                    var share = miner.mine();
                    miner.submit(share, function (reply) {
                        check('a valid share is accepted', function () {
                            assert.strictEqual(reply.error, null);
                            assert.strictEqual(reply.result, true);
                            assert.strictEqual(shares.length, 1);
                            assert.strictEqual(shares[0].valid, true);
                            assert.strictEqual(shares[0].block, false);
                            assert.strictEqual(shares[0].data.worker, 'RTestAddress.opi5-1');
                        });

                        miner.submit(share, function (reply) {
                            check('the same share is rejected the second time', function () {
                                assert.strictEqual(reply.result, null);
                                assert.strictEqual(reply.error[1], 'duplicate share');
                            });

                            var bad = miner.mine();
                            // without the pool nonce a solution could be reused by another miner
                            var soln = Buffer.from(bad.params[4], 'hex');
                            soln.fill(0, 1347 - 15, 1347 - 8);
                            bad.params[4] = soln.toString('hex');
                            miner.submit(bad, function (reply) {
                                check('a share without the pool nonce is rejected', function () {
                                    assert.strictEqual(reply.result, null);
                                    assert.ok(/pool nonce missing/.test(reply.error[1]));
                                });

                                var low = miner.mine();
                                var lowSoln = Buffer.from(low.params[4], 'hex');
                                // find a nonce whose hash does not meet the target
                                var template = new BlockTemplate('x', fixtures.template);
                                var header = template.serializeHeader(low.params[2]);
                                for (var n = 1; ; n++) {
                                    lowSoln.writeUInt32LE(0x7f000000 + n, 1347 - 8);
                                    if (util.bigIntFromBufferLE(vh.hash2b2(Buffer.concat([header, lowSoln]))) > miner.target * 2n) break;
                                }
                                low.params[4] = lowSoln.toString('hex');
                                miner.submit(low, function (reply) {
                                    check('a share that does not meet the target is rejected', function () {
                                        assert.strictEqual(reply.result, null);
                                        assert.ok(/low difficulty/.test(reply.error[1]));
                                    });

                                    var stale = miner.mine();
                                    stale.params[1] = 'deadbeef';
                                    miner.submit(stale, function (reply) {
                                        check('a share for an unknown job is rejected', function () {
                                            assert.strictEqual(reply.error[1], 'job not found');
                                        });
                                        miner.submit({params: ['x', 5, null, {}, []]}, function (reply) {
                                            check('a malformed share is rejected without breaking the server', function () {
                                                assert.strictEqual(reply.error[1], 'malformed share');
                                            });
                                            secondMiner();
                                        });
                                    });
                                });
                            });
                        });
                    });
                });

                var secondMiner = function () {
                    second.connect(function () {
                        var pendingShares = 5;
                        var submitNext = function () {
                            second.submit(second.mine(), function (reply) {
                                assert.strictEqual(reply.result, true);
                                if (--pendingShares > 0) submitNext();
                                else cliChecks();
                            });
                        };
                        submitNext();
                    });
                };

                var cliChecks = function () {
                    check('the miners command lists both miners with their shares', function () {
                        var output = run('miners');
                        var lines = output.split('\n');
                        var first = lines.filter(function (line) { return /^opi5-1\s/.test(line); })[0];
                        var other = lines.filter(function (line) { return /^opi_zero\s/.test(line); })[0];
                        assert.ok(first, output);
                        assert.ok(other, output);
                        assert.ok(/127\.0\.0\.1\s+online/.test(first), first);
                        // accepted, rejected, stale
                        assert.ok(/\s1\s+3\s+1\s/.test(first), first);
                        assert.ok(/\s5\s+0\s+0\s/.test(other), other);
                        assert.ok(/2 miners online/.test(output), output);
                    });

                    check('hashrates are calculated from the accepted shares', function () {
                        var miners = stats.getMiners(pool.stratumServer.getStratumClients());
                        var other = miners.filter(function (m) { return m.name === 'opi_zero'; })[0];
                        // 5 shares of difficulty 0.001, 8192 hashes per unit of difficulty
                        var elapsed = Math.max(Date.now() - other.firstSeen, 1000) / 1000;
                        var expected = 5 * 0.001 * 8192 / elapsed;
                        assert.ok(Math.abs(other.hashrate - expected) / expected < 0.2, other.hashrate + ' vs ' + expected);
                        assert.ok(other.bestShare >= 0.001 * 0.99);
                        assert.strictEqual(Math.round(util.hashesPerDiff), 8192);
                        var output = run('hashrate');
                        assert.ok(/TOTAL/.test(output) && /H\/s/.test(output), output);
                    });

                    var statusOutput;
                    commands.execute('status', [], function (text) {
                        statusOutput = text;
                        check('the status command reports daemon and pool state', function () {
                            assert.ok(/mainnet, 8 peers/.test(statusOutput), statusOutput);
                            assert.ok(/631\.22 GH\/s/.test(statusOutput), statusOutput);
                            assert.ok(/2 online/.test(statusOutput), statusOutput);
                            assert.ok(/6 accepted, 3 rejected, 1 stale/.test(statusOutput), statusOutput);
                            assert.ok(/height 4263939/.test(statusOutput), statusOutput);
                        });
                        check('other commands answer', function () {
                            assert.ok(/miners/.test(run('help')));
                            assert.ok(/No blocks found/.test(run('blocks')));
                            assert.ok(/Unrecognized/.test(run('nonsense')));
                            assert.ok(/Log level set to warning/.test(run('loglevel', ['warning'])));
                            assert.ok(/Unknown log level/.test(run('loglevel', ['loud'])));
                            run('loglevel', ['debug']);
                        });
                        disconnectCheck();
                    });
                };

                var disconnectCheck = function () {
                    second.close();
                    setTimeout(function () {
                        check('a miner that disconnects is shown as offline', function () {
                            var output = run('miners');
                            var other = output.split('\n').filter(function (line) { return /^opi_zero\s/.test(line); })[0];
                            assert.ok(/OFFLINE/.test(other), output);
                            assert.ok(/1 miner online, 1 offline/.test(output), output);
                        });
                        newJobCheck();
                    }, 100);
                };

                var newJobCheck = function () {
                    // transactions changed: same height, new merkle root -> job update without restart
                    var template = JSON.parse(JSON.stringify(fixtures.template));
                    template.transactions = [];
                    template.curtime += 5;
                    // any hash is a block from now on
                    template.target = 'f'.repeat(64);
                    template.bits = '2100ffff';
                    delete template.mergeminebits;
                    miner.onJob = function (job) {
                        miner.onJob = null;
                        check('miners get an updated job when the block template changes', function () {
                            assert.strictEqual(job[7], false);
                            assert.notStrictEqual(job[3], util.reverseHex(new BlockTemplate('x', fixtures.template).merkleRoot));
                        });
                        blockCheck();
                    };
                    daemon.template = template;
                };

                var blockCheck = function () {
                    // the prehash inside the solution belongs to the original template, so mine on
                    // the cleared header exactly like a miner and let the pool do the same
                    var share = miner.mine();
                    miner.submit(share, function (reply) {
                        check('a share for a job whose merge mining data does not match is rejected', function () {
                            assert.strictEqual(reply.result, null);
                            assert.ok(/merge mining data/.test(reply.error[1]));
                            assert.strictEqual(daemon.submitted.length, 0);
                        });

                        // now a template that is consistent again but with a target any share meets
                        var template = JSON.parse(JSON.stringify(fixtures.template));
                        template.target = 'f'.repeat(64);
                        delete template.mergeminebits;
                        template.height += 1;
                        miner.onJob = function (job) {
                            miner.onJob = null;
                            check('miners get a clean job for a new block height', function () {
                                assert.strictEqual(job[7], true);
                            });
                            var winning = miner.mine();
                            miner.submit(winning, function (reply) {
                                // the share event fires after the daemon confirmed the block
                                setTimeout(function () {
                                    check('a share that meets the network target is submitted as a block', function () {
                                        assert.strictEqual(reply.result, true);
                                        assert.strictEqual(daemon.submitted.length, 1);
                                        var last = shares[shares.length - 1];
                                        assert.strictEqual(last.block, true);
                                        assert.strictEqual(last.data.height, template.height);
                                    });
                                    check('the submitted block is serialized correctly', function () {
                                        var block = Buffer.from(daemon.submitted[0], 'hex');
                                        var job = new BlockTemplate('x', template);
                                        // header
                                        assert.strictEqual(block.readUInt32LE(0), template.version);
                                        assert.strictEqual(block.slice(4, 36).toString('hex'), util.reverseHex(template.previousblockhash));
                                        assert.strictEqual(block.slice(36, 68).toString('hex'), util.reverseHex(job.merkleRoot));
                                        assert.strictEqual(block.slice(68, 100).toString('hex'), util.reverseHex(template.finalsaplingroothash));
                                        assert.strictEqual(block.readUInt32LE(100), template.curtime);
                                        assert.strictEqual(block.slice(104, 108).toString('hex'), util.reverseHex(template.bits));
                                        assert.strictEqual(block.slice(108, 140).toString('hex'), util.reverseHex(template.nonce));
                                        // solution as sent by the miner
                                        assert.strictEqual(block.slice(140, 1487).toString('hex'), winning.params[4]);
                                        // transaction count, coinbase and the other transactions
                                        assert.strictEqual(block[1487], template.transactions.length + 1);
                                        var txs = template.coinbasetxn.data + template.transactions.map(function (tx) { return tx.data; }).join('');
                                        assert.strictEqual(block.slice(1488).toString('hex'), txs);
                                        // and its hash is what the pool reported
                                        var hash = util.reverseBuffer(vh.hash2b2(block.slice(0, 1487))).toString('hex');
                                        assert.strictEqual(hash, shares[shares.length - 1].data.blockHash);
                                    });
                                    check('the found block shows up in the blocks command and the blocks file', function () {
                                        var output = run('blocks');
                                        assert.ok(output.indexOf(shares[shares.length - 1].data.blockHash) !== -1, output);
                                        assert.ok(/opi5-1/.test(output), output);
                                        assert.ok(/3 VRSC/.test(output), output);
                                        var saved = new Stats({blocksFile: blocksFile});
                                        assert.strictEqual(saved.blocks.length, 1);
                                        assert.strictEqual(saved.blocks[0].height, template.height);
                                    });
                                    robustnessCheck();
                                }, 200);
                            });
                        };
                        daemon.template = template;
                    });
                };

                var robustnessCheck = function () {
                    var garbage = new TestMiner(stratumPort, 'garbage');
                    garbage.sendRaw('this is not json\n');
                    garbage.sendRaw('{"id":1,"method":"mining.submit","params":null}\n');
                    var silent = new TestMiner(stratumPort, 'silent');
                    silent.sendRaw('{"id":1,"method":"mining.authorize"}\n[1,2,3]\n"text"\n{"id":2,"method":"mining.submit","params":["a","b","c","d","e"]}\n');
                    daemon.online = false;
                    setTimeout(function () {
                        daemon.online = true;
                        setTimeout(function () {
                            var share = miner.mine();
                            miner.submit(share, function (reply) {
                                check('the server survives garbage input and a daemon outage', function () {
                                    assert.strictEqual(reply.result, true);
                                    assert.ok(logLines.some(function (line) { return /getblocktemplate call failed/.test(line); }));
                                    assert.ok(logLines.some(function (line) { return /working again/.test(line); }));
                                    assert.ok(logLines.some(function (line) { return /Malformed message/.test(line); }));
                                });
                                miner.close();
                                silent.close();
                                finish();
                            });
                        }, 400);
                    }, 400);
                };
            });

            pool.start();
        });
    });
};

// A server with a payout address: asks the daemon to pay it and refuses work that pays elsewhere
var runPayoutTest = function (done) {
    console.log('stratum server with a payout address');

    var daemon = new FakeDaemon();
    var logLines = [];
    var started = false;

    daemon.start(function () {
        freePort(function (stratumPort) {
            var config = {
                coin: {name: 'verus', symbol: 'vrsc', algorithm: 'verushash'},
                daemon: {host: '127.0.0.1', port: daemon.port, user: 'u', password: 'p'},
                payoutAddress: PAYOUT_ADDRESS,
                stratumHost: '127.0.0.1',
                ports: {},
                blockRefreshInterval: 100,
                jobRebroadcastTimeout: 55,
                connectionTimeout: 600,
                banning: {enabled: false}
            };
            config.ports[stratumPort] = {diff: 0.001};

            var logger = new PoolLogger({logLevel: 'debug', logColors: false});
            logger.output = function (line) { logLines.push(line); };
            var stats = new Stats({hashrateWindow: 300});
            var pool = Stratum.createPool(config, function (ip, port, workerName, password, callback) {
                callback({error: null, authorized: true, disconnect: false});
            });
            var commands = new Commands({config: config, logger: logger, stats: stats, pool: pool, shutdown: function () {}});
            var json = function (callback) {
                commands.execute('json', [], function (text) { callback(JSON.parse(text)); });
            };

            pool.on('log', function (severity, text) {
                logger[severity]('Pool', text);
            }).on('started', function () {
                started = true;
                check('work is handed out once the template pays the payout address', function () {
                    assert.strictEqual(pool.payout.verified, true);
                    assert.strictEqual(pool.payout.error, null);
                });
                var miner = new TestMiner(stratumPort, 'solo.opi5-1');
                miner.connect(function () {
                    // a template that pays elsewhere again (the daemon caches them) must not replace the job
                    var goodJobId = miner.job[0];
                    var bad = templatePaying('76a914' + '22'.repeat(20) + '88ac');
                    bad.height++;
                    bad.previousblockhash = 'ab'.repeat(32);
                    daemon.template = bad;
                    setTimeout(function () {
                        check('a later template that pays elsewhere is not handed out', function () {
                            assert.strictEqual(pool.payout.verified, false);
                            assert.strictEqual(pool.jobManager.currentJob.rpcData.height, fixtures.template.height);
                            assert.strictEqual(miner.job[0], goodJobId);
                        });
                        json(function (state) {
                            check('the json command reports the whole state', function () {
                                assert.strictEqual(state.payout.address, PAYOUT_ADDRESS);
                                assert.strictEqual(state.payout.verified, false);
                                assert.ok(/different address/.test(state.payout.error));
                                assert.strictEqual(state.stratum.listening, true);
                                assert.deepStrictEqual(state.stratum.ports, [stratumPort]);
                                assert.strictEqual(state.daemon.reachable, true);
                                assert.strictEqual(state.daemon.networkHashrate, 631222660445);
                                assert.strictEqual(state.job.height, fixtures.template.height);
                                assert.strictEqual(state.job.reward, 3);
                                assert.strictEqual(state.miners.online, 1);
                                assert.strictEqual(state.miners.list[0].name, 'opi5-1');
                                assert.ok(Array.isArray(state.blocks));
                            });
                            miner.close();
                            pool.stop();
                            daemon.close();
                            done();
                        });
                    }, 400);
                });
            });

            pool.start();

            // the fake daemon starts out with the fixture, which pays its own wallet
            setTimeout(function () {
                check('the daemon is asked to pay the payout address', function () {
                    var expected = {};
                    expected[PAYOUT_ADDRESS] = 1;
                    assert.deepStrictEqual(daemon.templateRequest.miningdistribution, expected);
                });
                check('no work is handed out while the template pays a different address', function () {
                    assert.strictEqual(started, false);
                    assert.strictEqual(pool.stratumServer, undefined);
                    assert.strictEqual(pool.payout.verified, false);
                    assert.ok(/different address/.test(pool.payout.error));
                    assert.ok(logLines.some(function (line) { return /does not pay RD1F8k/.test(line); }));
                });
                daemon.template = templatePaying(PAYOUT_SCRIPT);
            }, 600);
        });
    });
};

var timeout = setTimeout(function () {
    console.log('FAILED - test timed out');
    process.exit(1);
}, 90000);

runServerTest(function () {
    runPayoutTest(function () {
        clearTimeout(timeout);
        console.log('\nAll ' + passed + ' checks passed');
        process.exit(0);
    });
});
