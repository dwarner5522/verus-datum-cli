var events = require('events');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var blockTemplate = require('./blockTemplate.js');
var util = require('./util.js');

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;
    var templateErrorLogged = false;


    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitInfoLog = function (text) {
        _this.emit('log', 'info', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };


    this.start = function () {
        SetupVarDiff();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };


    this.stop = function () {
        clearInterval(blockPollingIntervalId);
        if (_this.stratumServer)
            _this.stratumServer.close();
    };


    function GetFirstJob(finishedCallback) {

        GetBlockTemplate(function (error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, retrying in 5 seconds');
                setTimeout(function () {
                    GetFirstJob(finishedCallback);
                }, 5000);
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            if (portWarnings.length > 0) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        var infoLines = ['Stratum server started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}',
            'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
            'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
            'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty,
            'Current Connect Peers:\t' + options.initStats.connections,
            'Network Difficulty:\t' + options.initStats.difficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', ')
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        emitInfoLog(infoLines.join('\n\t'));
    }


    function OnBlockchainSynced(syncedCallback) {

        var notSyncedLogged = false;

        var checkSynced = function () {
            _this.daemon.cmd('getblocktemplate', [], function (error) {
                // -10 is "daemon is downloading blocks", connection problems are also worth waiting out
                var synced = !error || (typeof error.code === 'number' && error.code !== -10 && error.code !== -9 && error.code !== -28);
                if (synced) {
                    syncedCallback();
                    return;
                }

                if (!notSyncedLogged) {
                    notSyncedLogged = true;
                    emitWarningLog('Daemon is not ready yet (' + (error.message || error.type) + ') - server will be started once it is synced');
                }
                setTimeout(checkSynced, 5000);
                generateProgress();
            });
        };
        checkSynced();


        var generateProgress = function () {

            _this.daemon.cmd('getinfo', [], function (error, info) {
                if (error || !info || !info.longestchain) return;
                var percent = (info.blocks / info.longestchain * 100).toFixed(2);
                emitWarningLog('Downloaded ' + percent + '% of blockchain (' + info.blocks + ' / ' + info.longestchain + ') from ' + info.connections + ' peers');
            });
        };

    }


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    function SubmitBlock(height, blockHex, callback) {

        var rpcCommand = 'submitblock';
        // if pbaas solution version is 7 or higher, use submitmergedblock
        let solution_ver = parseInt(util.reverseBuffer(Buffer.from(blockHex.substr(286,8), 'hex')).toString('hex'), 16);
        if (solution_ver > 6) {
            rpcCommand = 'submitmergedblock';
        }

        _this.daemon.cmd(rpcCommand,
            [blockHex],
            function (error, response) {
                if (error) {
                    emitErrorLog('rpc error with daemon when submitting block with ' + rpcCommand + ' ' +
                        JSON.stringify(error)
                    );
                    callback(false);
                    return;
                }
                else if (response === 'rejected') {
                    emitErrorLog('Daemon rejected a supposedly valid block');
                    callback(false);
                    return;
                }
                emitInfoLog('Submitted block using ' + rpcCommand + ' to daemon, response: ' + JSON.stringify(response));
                callback(true);
            }
        );
    }

    var jobManagerLastSubmitBlockHex = false;

    function SetupJobManager() {

        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[7] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHex) {
            var isValidShare = !shareData.error;
            var isValidBlock = !!blockHex;
            var emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
             If we calculated that the block solution was found,
             before we emit the share, lets submit the block,
             then check if it was accepted using RPC getblock
             */

            if (!isValidBlock)
                emitShare();
            else {
                if (jobManagerLastSubmitBlockHex === blockHex) {
                    emitWarningLog('Warning, ignored duplicate submit block');
                } else {
                    jobManagerLastSubmitBlockHex = blockHex;
                    SubmitBlock(shareData.height, blockHex, function (submitted) {
                        if (!submitted) {
                            // still a perfectly good share, just not a block
                            isValidBlock = false;
                            shareData.blockRejected = true;
                            emitShare();
                        } else if (!shareData.blockOnlyPBaaS) {
                            CheckBlockAccepted(shareData.blockHash, function (isAccepted, tx) {
                                isValidBlock = isAccepted === true;
                                if (isValidBlock === true) {
                                    shareData.txHash = tx;
                                } else {
                                    shareData.blockRejected = true;
                                    shareData.blockRejectReason = tx;
                                }
                                emitShare();
                                GetBlockTemplate(function (error, result, foundNewBlock) {
                                    if (foundNewBlock) {
                                        emitLog('Block notification via RPC after block submission');
                                    }
                                });
                            });
                        } else {
                            emitShare();
                        }
                    });
                }
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!options.daemon || !options.daemon.port) {
            emitErrorLog('No daemon has been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemon, function (severity, message) {
            _this.emit('log', severity, message);
        });

        _this.daemon.once('online', function () {
            finishedCallback();

        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect to daemon at ' + (options.daemon.host || '127.0.0.1') + ':' + options.daemon.port
                + ' (' + (error.message || JSON.stringify(error)) + ') - will keep retrying every 5 seconds');

        });

        _this.daemon.init();
    }


    function DetectCoinData(finishedCallback) {

        _this.daemon.cmd('getinfo', [], function (error, info) {
            if (error || !info) {
                emitErrorLog('Could not start pool, error with init RPC getinfo - ' + JSON.stringify(error) + ', retrying in 5 seconds');
                setTimeout(function () {
                    DetectCoinData(finishedCallback);
                }, 5000);
                return;
            }

            _this.daemon.cmd('getmininginfo', [], function (error, miningInfo) {
                if (error || !miningInfo) {
                    emitErrorLog('Could not start pool, error with init RPC getmininginfo - ' + JSON.stringify(error) + ', retrying in 5 seconds');
                    setTimeout(function () {
                        DetectCoinData(finishedCallback);
                    }, 5000);
                    return;
                }

                options.testnet = info.testnet;
                options.protocolVersion = info.protocolversion;

                options.initStats = {
                    connections: info.connections,
                    difficulty: info.difficulty,
                    networkHashRate: miningInfo.networkhashps
                };

                finishedCallback();
            });
        });
    }


    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('listenError', function (port, err) {
            emitErrorLog('Could not listen on stratum port ' + port + ': ' + err.message);
            _this.emit('fatal', err);

        }).on('broadcastTimeout', function () {
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetBlockTemplate(function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) {
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            _this.emit('minerConnected', client);

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                resultCallback(null,
                    extraNonce,
                    extraNonce
                );

                if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', function (params, resultCallback) {
                var result = _this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,
                    params.soln
                );

                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + String(message).substr(0, 200));

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connection timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function () {
                _this.emit('minerDisconnected', client);

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;
        var polling = false;

        blockPollingIntervalId = setInterval(function () {
            // never stack up requests when the daemon is slow to answer
            if (polling) return;
            polling = true;
            GetBlockTemplate(function (error, rpcData, newJob) {
                polling = false;
                if (newJob) { emitLog('Block update via RPC polling'); }
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(callback) {
        _this.daemon.cmd('getblocktemplate',
            [{"capabilities": ["coinbasetxn", "workid", "coinbase/append"]}],
            function (error, rpcData) {
                if (!error) {
                    var problem = blockTemplate.validate(rpcData);
                    if (problem)
                        error = {message: 'unusable block template: ' + problem};
                }
                if (error) {
                    // log the first failure only, the daemon may be gone for a while
                    if (!templateErrorLogged) {
                        templateErrorLogged = true;
                        emitErrorLog('getblocktemplate call failed with error ' + JSON.stringify(error));
                    }
                    callback(error);
                    return;
                }
                if (templateErrorLogged) {
                    templateErrorLogged = false;
                    emitInfoLog('getblocktemplate is working again');
                }

                var processedNewBlock = _this.jobManager.processTemplate(rpcData);
                callback(null, rpcData, processedNewBlock);
            }
        );
    }


    function CheckBlockAccepted(blockHash, callback) {
        _this.daemon.cmd('getblock',
            [blockHash],
            function (error, block) {
                if (!error && block && block.hash === blockHash) {
                    // check for invalid blocks with negative confirmations
                    if (block.confirmations >= 0) {
                        // accepted valid block!
                        callback(true, block.tx[0]);
                    } else {
                        // reject invalid block, due to confirmations
                        callback(false, {"confirmations": block.confirmations});
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, {"unknown": "check coin daemon logs"});
            }
        );
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        // * Note, on verus, we may get the same block hash because a PBaaS chain has changed
        //         so we need to generate a new block template to get the update ...
        if (typeof(_this.jobManager) !== 'undefined' &&
            typeof(_this.jobManager.currentJob) !== 'undefined') {
            GetBlockTemplate(function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            })
        }
    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
