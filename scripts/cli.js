#!/usr/bin/env node
/*
Sends a command to the running stratum server and prints the reply.

    node scripts/cli.js miners
    node scripts/cli.js hashrate
    node scripts/cli.js help

Options: -host=<address> -port=<port> (defaults are taken from config.json)
 */
var net = require('net');
var fs = require('fs');
var path = require('path');

var defaultPort = 17117;
var defaultHost = '127.0.0.1';

try {
    var config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), {encoding: 'utf8'}));
    if (config.cliPort) defaultPort = config.cliPort;
    if (config.cliHost && config.cliHost !== '0.0.0.0') defaultHost = config.cliHost;
} catch (e) {}

var args = process.argv.slice(2);
var params = [];
var options = {};

for(var i = 0; i < args.length; i++){
    if (args[i].indexOf('-') === 0 && args[i].indexOf('=') !== -1){
        var s = args[i].replace(/^-+/, '').split('=');
        options[s[0]] = s[1];
    }
    else
        params.push(args[i]);
}

var command = params.shift() || 'help';
var host = options.host || defaultHost;
var port = options.port || defaultPort;


var client = net.connect(port, host, function () {
    client.write(JSON.stringify({
        command: command,
        params: params,
        options: options
    }) + '\n');
}).on('error', function(error){
    if (error.code === 'ECONNREFUSED')
        console.log('Could not connect to the stratum server at ' + host + ':' + port + ' - is it running?');
    else
        console.log('Socket error ' + JSON.stringify(error));
    process.exitCode = 1;
}).on('data', function(data) {
    process.stdout.write(data.toString());
}).on('close', function () {
});
