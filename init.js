var fs = require('fs');
var path = require('path');

var PoolLogger = require('./lib/logger.js');
var CliListener = require('./lib/cliListener.js');
var Console = require('./lib/console.js');
var Commands = require('./lib/commands.js');
var Stats = require('./lib/stats.js');


var args = process.argv.slice(2);
var noConsole = args.indexOf('--no-console') !== -1;
var configPath = path.resolve(args.filter(function (arg) {
    return arg.indexOf('--') !== 0;
})[0] || path.join(__dirname, 'config.json'));

if (!fs.existsSync(configPath)){
    console.log(configPath + ' does not exist. Copy config_example.json to config.json and edit it, see README.md.');
    process.exit(1);
}

var config;
try {
    config = JSON.parse(fs.readFileSync(configPath, {encoding: 'utf8'}));
}
catch (e) {
    console.log('Could not parse ' + configPath + ': ' + e.message);
    process.exit(1);
}

var defaults = {
    logLevel: 'info',
    logColors: true,
    cliPort: 17117,
    cliHost: '127.0.0.1',
    stratumHost: '0.0.0.0',
    blockRefreshInterval: 1000,
    jobRebroadcastTimeout: 55,
    connectionTimeout: 600,
    hashrateWindow: 300,
    statusInterval: 600,
    banning: {enabled: false}
};
Object.keys(defaults).forEach(function (option) {
    if (!(option in config)) config[option] = defaults[option];
});
config.coin = {name: 'verus', symbol: 'vrsc', algorithm: 'verushash'};

var configErrors = [];
if (!config.daemon || !config.daemon.port)
    configErrors.push('"daemon" with at least a "port" is required');
if (!config.ports || typeof config.ports !== 'object' || Object.keys(config.ports).length === 0)
    configErrors.push('"ports" must contain at least one stratum port');
else {
    Object.keys(config.ports).forEach(function (port) {
        if (!(parseInt(port) > 0 && parseInt(port) < 65536))
            configErrors.push('"' + port + '" is not a valid stratum port');
        else if (!(config.ports[port].diff > 0))
            configErrors.push('stratum port ' + port + ' needs a "diff" greater than 0');
    });
}
if (config.payoutAddress) {
    try {
        require('./lib/stratum/payout.js').addressToScript(config.payoutAddress);
    }
    catch (e) {
        configErrors.push('"payoutAddress": ' + e.message);
    }
}
if (configErrors.length > 0) {
    console.log('Invalid configuration in ' + configPath + ':\n  ' + configErrors.join('\n  '));
    process.exit(1);
}

var Stratum;
try {
    Stratum = require('./lib/stratum');
}
catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || String(e.message).indexOf('verushash') === -1) throw e;
    console.log('The verushash module has not been built yet, run "npm install" in ' + __dirname + ' first.');
    process.exit(1);
}


var logger = new PoolLogger({
    logLevel: config.logLevel,
    // escape codes only make sense on a terminal, not in a log file or the systemd journal
    logColors: config.logColors && process.stdout.isTTY
});

var stats = new Stats({
    hashrateWindow: config.hashrateWindow,
    blocksFile: config.blocksFile ? path.resolve(path.dirname(configPath), config.blocksFile) : path.join(__dirname, 'blocks.log')
});


// Solo mining: every miner is welcome, the user name is only used to tell the miners apart
var authorizeFn = function (ip, port, workerName, password, callback) {
    stats.minerSeen(workerName, ip);
    logger.info('Stratum', 'Miner connected: ' + stats.displayName(workerName) + ' [' + ip + ']');
    callback({
        error: null,
        authorized: true,
        disconnect: false
    });
};

var pool = Stratum.createPool(config, authorizeFn);

pool.on('share', function(isValidShare, isValidBlock, data){

    stats.recordShare(isValidShare, isValidBlock, data);

    var miner = stats.displayName(data.worker) + ' [' + data.ip + ']';

    if (data.blockRejected)
        logger.error('Pool', 'We thought a block was found but it was rejected by the daemon: ' + data.blockHash + ' by ' + miner
            + (data.blockRejectReason ? ' ' + JSON.stringify(data.blockRejectReason) : ''));
    else if (isValidBlock) {
        if (!data.blockOnlyPBaaS)
            logger.info('Pool', '*** BLOCK FOUND *** ' + data.blockHash + ' at height ' + data.height + ' by ' + miner);
        else
            logger.info('Pool', 'PBaaS block found: ' + data.blockHash + ' by ' + miner);
    }

    if (isValidShare)
        logger.debug('Pool', 'Share accepted at diff ' + data.difficulty + '/' + data.shareDiff + ' by ' + miner);
    else
        logger.debug('Pool', 'Share rejected (' + data.error + ') from ' + miner);

}).on('difficultyUpdate', function(workerName, diff){
    logger.debug('Pool', 'Difficulty update to diff ' + diff + ' for ' + stats.displayName(workerName));
}).on('minerDisconnected', function(client){
    if (client.workerName)
        logger.info('Stratum', 'Miner disconnected: ' + stats.displayName(client.workerName) + ' [' + client.remoteAddress + ']');
}).on('log', function(severity, text) {
    logger[severity]('Pool', text);
}).on('fatal', function(){
    process.exit(1);
});


var cliListener;
var interactiveConsole;
var shuttingDown = false;

var shutdown = function () {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Master', 'Shutting down');
    pool.stop();
    if (cliListener) cliListener.close();
    if (interactiveConsole) interactiveConsole.close();
    // give replies and log lines a moment to be written
    setTimeout(function () {
        process.exit(0);
    }, 200);
};

var commands = new Commands({
    config: config,
    logger: logger,
    stats: stats,
    pool: pool,
    shutdown: shutdown
});

if (config.cliPort) {
    cliListener = new CliListener(config.cliHost, config.cliPort);
    cliListener.on('log', function(text){
        logger.debug('CLI', text);
    }).on('command', function(command, params, reply){
        commands.execute(command, params, reply);
    }).on('error', function(err){
        logger.warning('CLI', 'Could not listen on ' + config.cliHost + ':' + config.cliPort + ' (' + err.message
            + ') - scripts/cli.js and blocknotify will not work');
    });
    cliListener.start();
}

if (!noConsole && process.stdin.isTTY && process.stdout.isTTY)
    interactiveConsole = new Console(commands, logger, shutdown);

if (config.statusInterval > 0) {
    setInterval(function () {
        if (!pool.stratumServer) return;
        var miners = stats.getMiners(pool.stratumServer.getStratumClients());
        var total = stats.getPoolHashrate(miners);
        logger.info('Status', total.online + ' miner(s) online, ' + Stratum.util.getReadableHashRateString(total.hashrate)
            + ', ' + stats.totals.accepted + ' shares accepted, ' + stats.blocks.filter(function (block) {
                return block.time >= stats.startTime;
            }).length + ' block(s) found');
    }, config.statusInterval * 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', function (err) {
    logger.error('Master', 'Unexpected error, exiting: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});

logger.info('Master', 'Verus solo stratum server starting, config ' + configPath);
if (config.payoutAddress)
    logger.info('Master', 'Block rewards are paid to ' + config.payoutAddress);
else
    logger.warning('Master', 'No payoutAddress in the config - block rewards go to the address the daemon is set up with');
pool.start();
