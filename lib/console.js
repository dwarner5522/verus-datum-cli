var readline = require('readline');

/*
Interactive console of the running server. Log lines are printed above the prompt so whatever
is being typed stays intact.
 */
module.exports = function (commands, logger, onClose) {

    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'verus> ',
        completer: function (line) {
            var hits = commands.names.filter(function (name) {
                return name.indexOf(line) === 0;
            });
            return [hits.length ? hits : commands.names, line];
        }
    });

    var closed = false;

    var print = function (text) {
        if (closed) {
            console.log(text);
            return;
        }
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(text);
        rl.prompt(true);
    };

    logger.output = print;

    rl.on('line', function (line) {
        var parts = line.trim().split(/\s+/).filter(function (part) {
            return part.length > 0;
        });
        if (parts.length === 0) {
            rl.prompt();
            return;
        }
        commands.execute(parts[0], parts.slice(1), function (reply) {
            print(reply);
        });
    });

    // Ctrl+C and Ctrl+D
    rl.on('close', function () {
        if (closed) return;
        closed = true;
        onClose();
    });

    this.close = function () {
        if (closed) return;
        closed = true;
        rl.close();
    };

    print('Type "help" for the list of commands.');
};
