var events = require('events');
var net = require('net');

/*
Small TCP server on localhost that lets scripts/cli.js (and the daemon's blocknotify) send
commands to the running server. One JSON object per connection, terminated by a newline:
    {"command": "miners", "params": []}
The text of the reply is written back and the connection is closed.
 */
var listener = module.exports = function listener(host, port){

    var _this = this;

    var emitLog = function(text){
        _this.emit('log', text);
    };


    this.start = function(){
        var server = net.createServer(function(c) {

            var data = '';
            c.setEncoding('utf8');
            c.on('data', function (d) {
                data += d;
                if (data.length > 65536) {
                    c.destroy();
                    return;
                }
                if (data.slice(-1) === '\n') {
                    var message;
                    try {
                        message = JSON.parse(data);
                    }
                    catch(e){
                        emitLog('CLI listener failed to parse message ' + data.substr(0, 200));
                        c.end('invalid command message\n');
                        return;
                    }
                    data = '';
                    if (!message || typeof message !== 'object') {
                        c.end('invalid command message\n');
                        return;
                    }
                    _this.emit('command', message.command, Array.isArray(message.params) ? message.params : [], function(reply){
                        if (!c.destroyed)
                            c.end(reply + '\n');
                    });
                }
            });
            c.on('error', function () {

            });

        });
        server.on('error', function (err) {
            _this.emit('error', err);
        });
        server.listen(port, host, function() {
            emitLog('CLI listening on ' + host + ':' + port);
        });
        _this.server = server;
    };

    this.close = function () {
        if (_this.server) _this.server.close();
    };

};

listener.prototype.__proto__ = events.EventEmitter.prototype;
