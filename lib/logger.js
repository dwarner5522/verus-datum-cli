var severityValues = {
    'debug': 1,
    'info': 2,
    'warning': 3,
    'error': 4
};

var severityColors = {
    'debug': '\x1b[90m',
    'info': '\x1b[32m',
    'warning': '\x1b[33m',
    'error': '\x1b[31m'
};

function pad(n) {
    return n < 10 ? '0' + n : '' + n;
}

function timestamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}


var PoolLogger = function (configuration) {

    var _this = this;

    var logLevelInt = severityValues[configuration.logLevel] || severityValues.info;
    var logColors = configuration.logColors;

    // where finished log lines go, the interactive console replaces this to keep its prompt intact
    this.output = function (line) {
        console.log(line);
    };

    this.setLevel = function (level) {
        if (!(level in severityValues)) return false;
        logLevelInt = severityValues[level];
        return true;
    };

    this.getLevel = function () {
        return Object.keys(severityValues).filter(function (level) {
            return severityValues[level] === logLevelInt;
        })[0];
    };

    this.levels = Object.keys(severityValues);

    var log = function (severity, component, text) {

        if (severityValues[severity] < logLevelInt) return;

        var entryDesc = timestamp() + ' [' + severity + ']';
        if (logColors)
            entryDesc = severityColors[severity] + entryDesc + '\x1b[0m';

        _this.output(entryDesc + ' [' + component + '] ' + text);
    };

    // public

    Object.keys(severityValues).forEach(function (logType) {
        _this[logType] = function (component, text) {
            log(logType, component, text);
        };
    });
};

module.exports = PoolLogger;
