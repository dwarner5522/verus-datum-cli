var http = require('http');
var events = require('events');

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an object containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
 **/

function DaemonInterface(daemon, logger) {

    //private members
    var _this = this;
    logger = logger || function (severity, message) {
            console.log(severity + ': ' + message);
        };

    var requestId = 0;


    /**
     * timeout in seconds
     */
    function performHttpRequest(jsonData, callback, timeout) {
        if (!timeout) {
            timeout = 60
        }

        // make sure the callback only ever fires once per request
        var finished = false;
        var finish = function (error, result) {
            if (finished) return;
            finished = true;
            callback(error, result);
        };

        var options = {
            hostname: (typeof(daemon.host) === 'undefined' ? '127.0.0.1' : daemon.host),
            port: daemon.port,
            method: 'POST',
            auth: daemon.user + ':' + daemon.password,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonData)
            }
        };

        var parseJson = function (res, data) {
            var dataJson;

            if (res.statusCode === 401) {
                finish({type: 'unauthorized', message: 'Unauthorized RPC access - invalid RPC username or password'}, null);
                return;
            }

            try {
                dataJson = JSON.parse(data);
            }
            catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ":0");
                    parseJson(res, data);
                    return;
                }
                finish({type: 'parse error', message: 'Could not parse rpc data from daemon (http status ' + res.statusCode + ')'}, null);
                return;
            }
            finish(null, dataJson);
        };

        var req = http.request(options, function (res) {
            var data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                parseJson(res, data);
            });
        });

        req.setTimeout(timeout * 1000, function () {
            req.destroy(new Error('request timed out after ' + timeout + ' seconds'));
        });

        req.on('error', function (e) {
            if (e.code === 'ECONNREFUSED')
                finish({type: 'offline', message: e.message}, null);
            else
                finish({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }


    /* Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to the daemon.
     The callback is fired once with (error, result) where error is either a transport
     error or the error object returned by the daemon. */
    function cmd(method, params, callback, timeout) {

        var requestJson = JSON.stringify({
            jsonrpc: '1.0',
            method: method,
            params: params,
            id: ++requestId
        });

        performHttpRequest(requestJson, function (error, response) {
            if (error)
                callback(error, null);
            else if (response.error)
                callback(response.error, null);
            else
                callback(null, response.result);
        }, timeout);
    }


    /* Fires 'online' as soon as the daemon answers, retrying for as long as it takes so the
     server can be started before (or survive a restart of) the daemon. */
    function init() {
        var warned = false;
        var check = function () {
            cmd('getinfo', [], function (error) {
                // -28 is "still warming up" (loading block index, verifying, ...)
                if (!error) {
                    _this.emit('online');
                    return;
                }
                if (!warned) {
                    warned = true;
                    _this.emit('connectionFailed', error);
                }
                setTimeout(check, 5000);
            }, 15);
        };
        check();
    }


    //public members

    this.init = init;
    this.cmd = cmd;
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;
