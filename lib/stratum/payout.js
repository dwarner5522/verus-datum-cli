var util = require('./util.js');

/*
Where the block reward goes. The Verus daemon builds the coinbase transaction, and with a
"miningdistribution" in the getblocktemplate request it pays the reward to the address given
there instead of to its own wallet. The daemon caches block templates though, so a template may
have been built for someone else's request. Every template is therefore checked here before any
miner gets to work on it.

Only transparent R-addresses are supported.
 */

var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
var PUBKEY_ADDRESS_VERSION = 60;   // Verus and Verus testnet, addresses starting with R


var base58Decode = function (text) {
    var value = 0n;
    for (var i = 0; i < text.length; i++) {
        var digit = BASE58.indexOf(text[i]);
        if (digit === -1) return null;
        value = value * 58n + BigInt(digit);
    }
    var hex = value === 0n ? '' : value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros++;
    return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
};

// Returns the output script that pays the given R-address, throws if it is not a valid one.
exports.addressToScript = function (address) {
    if (typeof address !== 'string' || !/^R[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))
        throw new Error('"' + address + '" is not a Verus R-address');
    var decoded = base58Decode(address);
    if (!decoded || decoded.length !== 25 || decoded[0] !== PUBKEY_ADDRESS_VERSION ||
        !util.sha256d(decoded.slice(0, 21)).slice(0, 4).equals(decoded.slice(21)))
        throw new Error('"' + address + '" is not a valid Verus R-address, check it for typing errors');
    return Buffer.concat([Buffer.from('76a914', 'hex'), decoded.slice(1, 21), Buffer.from('88ac', 'hex')]);
};

// Returns the outputs of a serialized transaction as [{value: BigInt, script: Buffer}]
exports.transactionOutputs = function (txHex) {
    var tx = Buffer.from(txHex, 'hex');
    var offset = 0;

    var need = function (bytes) {
        if (offset + bytes > tx.length) throw new Error('transaction is truncated');
    };
    var varInt = function () {
        need(1);
        var first = tx[offset++];
        if (first < 0xfd) return first;
        var size = first === 0xfd ? 2 : (first === 0xfe ? 4 : 8);
        need(size);
        var value = size === 8 ? Number(tx.readBigUInt64LE(offset)) : tx.readUIntLE(offset, size);
        offset += size;
        return value;
    };

    need(4);
    var overwintered = (tx.readUInt32LE(offset) & 0x80000000) !== 0;
    offset += overwintered ? 8 : 4;   // header, and the version group id of overwintered transactions

    var inputs = varInt();
    for (var i = 0; i < inputs; i++) {
        offset += 36;                     // previous output
        var inputScriptLength = varInt();
        offset += inputScriptLength + 4;  // script and sequence
    }

    var outputs = [];
    var count = varInt();
    for (var o = 0; o < count; o++) {
        need(8);
        var value = tx.readBigUInt64LE(offset);
        offset += 8;
        var scriptLength = varInt();
        need(scriptLength);
        outputs.push({value: value, script: tx.slice(offset, offset + scriptLength)});
        offset += scriptLength;
    }
    return outputs;
};

/*
 Checks that everything a coinbase transaction pays out goes to the given script. Outputs
 without a value (the daemon adds one for its fee pool) are ignored. Returns null when the
 transaction is fine, otherwise a text saying what is wrong.
 */
exports.verifyCoinbase = function (txHex, script) {
    var outputs;
    try {
        outputs = exports.transactionOutputs(txHex);
    } catch (e) {
        return 'could not read the coinbase transaction (' + e.message + ')';
    }
    var paying = outputs.filter(function (output) { return output.value > 0n; });
    if (paying.length === 0)
        return 'the coinbase transaction does not pay anything';
    var elsewhere = paying.filter(function (output) { return !output.script.equals(script); });
    if (elsewhere.length > 0)
        return elsewhere.length + ' of ' + paying.length + ' coinbase output(s) pay a different address';
    return null;
};
