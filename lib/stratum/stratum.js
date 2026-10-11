var net = require('net');
var events = require('events');

var util = require('./util.js');

var SubscriptionCounter = function(poolId) {
    var count = 0;

    var padding = 'deadbeefcafebabe'
    padding = padding.substring(0, padding.length - poolId.length) + poolId

    return {
        next: function(){
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
**/
var StratumClient = function(options){
    var pendingDifficulty = null;
    //private members
    this.socket = options.socket;
    // IPv4 clients show up as ::ffff:a.b.c.d when listening on a dual stack socket
    this.remoteAddress = String(options.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    this.subscriptionId = options.subscriptionId;
    var banning = options.banning;
    var _this = this;
    this.connectedAt = Date.now();
    this.lastActivity = Date.now();
    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold){
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                _this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init(){
        setupSocket();
    };

    function handleMessage(message){
        switch(message.method){
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson({
                    id     : null,
                    result : [],
                    error  : true
                });
                break;
            case 'mining.extranonce.subscribe':
                sendJson({
                    id: message.id,
                    result: false,
                    error: [20, "Not supported.", null]
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubscribe(message){
        if (!_this.authorized) {
            _this.requestedSubscriptionBeforeAuth = true;
        }

        // miner software name/version, when the miner sends one
        if (Array.isArray(message.params) && typeof message.params[0] === 'string') {
            _this.userAgent = message.params[0].replace(/[^ -~]+/g, '').substr(0, 40);
        }

        _this.emit('subscription',
            {},
            function(error, extraNonce1, extraNonce1){
                if (error){
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;

                sendJson({
                    id: message.id,
                    result: [
                        null, //sessionId
                        extraNonce1
                    ],
                    error: null
                });
            });
    }

    function getSafeString(s) {
        return String(s).replace(/[^a-zA-Z0-9._\-]+/g, '');
    }

    function getSafeWorkerString(raw) {
        var s = getSafeString(raw).split(".");
        var addr = s[0];
        var wname = "noname";
        if (s.length > 1)
            wname = s[1];
        return addr+"."+wname;
    }

    function handleAuthorize(message) {

        var params = Array.isArray(message.params) ? message.params : [];

        _this.workerName = getSafeWorkerString(params[0]);
        _this.workerPass = params[1];

        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function(result) {
            _this.authorized = (!result.error && result.authorized);

            sendJson({
                id     : message.id,
                result : _this.authorized,
                error  : result.error
            });

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    function handleSubmit(message){
        var params = Array.isArray(message.params) ? message.params : [];

        if (!_this.workerName){
            _this.workerName = getSafeWorkerString(params[0]);
        }
        if (_this.authorized === false){
            sendJson({
                id    : message.id,
                result: null,
                error : [24, 'unauthorized worker', null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce1){
            sendJson({
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }
        // every field of a share is a string, anything else can not be a valid share
        for (var i = 1; i <= 4; i++) {
            if (typeof params[i] !== 'string') {
                sendJson({
                    id    : message.id,
                    result: null,
                    error : [20, 'malformed share', null]
                });
                considerBan(false);
                return;
            }
        }
        _this.emit('submit',
            {
                name        : _this.workerName,//message.params[0],
                jobId       : params[1],
                nTime       : params[2],
                extraNonce2 : params[3],
                soln        : params[4],
                nonce       : _this.extraNonce1 + params[3],
            },
            function(error, result){
                if (!considerBan(result)){
                    sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );

    }

    function sendJson(){
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        if (!options.socket.destroyed)
            options.socket.write(response);
    }

    function setupSocket(){
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        _this.emit('checkBan');

        socket.on('data', function(d){
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1){
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function(message){
                    if (message.trim().length < 1) return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch(e) {
                        _this.emit('malformedMessage', message);
                        socket.destroy();
                        return;
                    }
                    if (messageJson && typeof messageJson === 'object') {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function(){
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){
        if (difficulty === this.difficulty)
            return false;
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;

        //powLimit / difficulty
        var adjPow = util.diff1 / difficulty;
        var target = adjPow >= Math.pow(2, 256)
            ? 'f'.repeat(64)
            : Math.floor(adjPow).toString(16).padStart(64, '0');

        sendJson({
            id    : null,
            method: "mining.set_target",
            params: [target]
        });
        return true;
    };

    this.sendMiningJob = function(jobParams){

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000){
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }

        if (pendingDifficulty !== null){
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }
        sendJson({
            id    : null,
            method: "mining.notify",
            params: jobParams
        });

    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 *   - 'listenError'(port, error) - when a stratum port could not be opened
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn){

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter(options.poolId || '');
    var rebroadcastTimeout;
    var bannedIPs = {};
    var servers = [];


    function checkBan(client) {
        if (options.banning && options.banning.enabled) {
            if (client.remoteAddress in bannedIPs) {
                var bannedTime = bannedIPs[client.remoteAddress];
                var bannedTimeAgo = Date.now() - bannedTime;
                var timeLeft = bannedMS - bannedTimeAgo;
                if (timeLeft > 0) {
                    client.socket.destroy();
                    client.emit('kickedBannedIP', timeLeft / 1000 | 0);
                } else {
                    delete bannedIPs[client.remoteAddress];
                    client.emit('forgaveBannedIP');
                }
            }
        }
    }

    this.handleNewClient = function (socket){

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout
            }
        );

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function() {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function(){
            checkBan(client);
        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function(jobParams){
        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function(){
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled){
            setInterval(function(){
                for (var ip in bannedIPs){
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > bannedMS)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval).unref();
        }

        var ports = Object.keys(options.ports);
        var serversStarted = 0;
        ports.forEach(function (port) {
            var server = net.createServer({allowHalfOpen: false}, function(socket) {
                _this.handleNewClient(socket);
            });
            server.on('error', function (err) {
                _this.emit('listenError', port, err);
            });
            server.listen(parseInt(port), options.stratumHost || '0.0.0.0', function() {
                serversStarted++;
                if (serversStarted == ports.length)
                    _this.emit('started');
            });
            servers.push(server);
        });
    })();


    //public members

    this.addBannedIP = function(ipAddress){
        bannedIPs[ipAddress] = Date.now();
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.close = function () {
        clearTimeout(rebroadcastTimeout);
        servers.forEach(function (server) {
            server.close();
        });
        for (var clientId in stratumClients) {
            stratumClients[clientId].socket.destroy();
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
