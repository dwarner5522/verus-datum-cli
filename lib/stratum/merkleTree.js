var util = require('./util.js');


// Standard bitcoin style merkle root over transaction ids given in RPC (display) byte order
function calcRoot(hashes) {
    var level = hashes.map(function (hash) {
        return util.reverseBuffer(Buffer.from(hash, 'hex'));
    });
    while (level.length > 1) {
        var next = [];
        for (var i = 0; i < level.length; i += 2) {
            var left = level[i];
            // an odd node is paired with itself
            var right = (i + 1 < level.length) ? level[i + 1] : left;
            next.push(util.sha256d(Buffer.concat([left, right])));
        }
        level = next;
    }
    return util.reverseBuffer(level[0]).toString('hex');
}

exports.getRoot = function (rpcData, generateTxRaw) {
    var hashes = [util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex')];
    rpcData.transactions.forEach(function (value) {
        hashes.push(value.hash);
    });
    if (hashes.length === 1) {
        return hashes[0];
    }
    return calcRoot(hashes);
};
