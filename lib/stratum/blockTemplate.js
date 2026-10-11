var merkle = require('./merkleTree.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData
) {
    //private members
    var submits = new Set();

    //public members
    this.rpcData = rpcData;
    this.jobId = jobId;

    // get target info
    this.target = BigInt('0x' + rpcData.target);
    this.difficulty = parseFloat((util.diff1 / Number(this.target)).toFixed(9));
    this.merged_target = this.target;
    // pbaas minimal merged mining target
    if (this.rpcData.merged_bits) {
        this.merged_target = util.bigIntFromBitsHex(this.rpcData.merged_bits);
    } else if (this.rpcData.mergeminebits) {
        this.merged_target = util.bigIntFromBitsHex(this.rpcData.mergeminebits);
    }

    this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase

    // veruscoin daemon performs all coinbase transaction calculations to included any fee's from the fee pool
    // *Note, the block reward is paid to the address the verus daemon is setup with (-mineraddress, -pubkey, etc.)
    this.blockReward = this.rpcData.coinbasetxn.coinbasevalue;
    this.genTx = this.rpcData.coinbasetxn.data;
    this.genTxHash = util.reverseBuffer(Buffer.from(this.rpcData.coinbasetxn.hash, 'hex')).toString('hex');

    this.merkleRoot = merkle.getRoot(this.rpcData, this.genTxHash);

    // generate the merkle root
    this.prevHashReversed = util.reverseBuffer(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');
    if (rpcData.finalsaplingroothash)
    {
        this.finalSaplingRootHashReversed = util.reverseBuffer(Buffer.from(rpcData.finalsaplingroothash, 'hex')).toString('hex');
    }
    else
    {
        this.finalSaplingRootHashReversed = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
    }

    this.merkleRootReversed = util.reverseBuffer(Buffer.from(this.merkleRoot, 'hex')).toString('hex');
    // we can't do anything else until we have a submission

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
    this.serializeHeader = function(nTime, nonce){
        var header = Buffer.alloc(140);
        var position = 0;

        header.writeUInt32LE(this.rpcData.version, position += 0);
        header.write(this.prevHashReversed, position += 4, 32, 'hex');
        header.write(this.merkleRootReversed, position += 32, 32, 'hex');
        header.write(this.finalSaplingRootHashReversed, position += 32, 32, 'hex');
        header.write(nTime, position += 32, 4, 'hex');
        header.write(util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');
        if (!nonce && this.rpcData.nonce) {
            header.write(util.reverseBuffer(Buffer.from(this.rpcData.nonce, 'hex')).toString('hex'), position += 4, 32, 'hex');
        } else if (nonce) {
            header.write(nonce, position += 4, 32, 'hex');
        }
        return header;
    };

    // join the header and txs together
    this.serializeBlock = function(header, soln){

        var parts = [
            header,
            soln,
            util.varIntBuffer(this.txCount),
            Buffer.from(this.genTx, 'hex')
        ];

        this.rpcData.transactions.forEach(function (value) {
            parts.push(Buffer.from(value.data, 'hex'));
        });

        return Buffer.concat(parts);
    };

    // submit the block header
    this.registerSubmit = function(header, soln){
        var submission = (header + soln).toLowerCase();
        if (!submits.has(submission)){
            submits.add(submission);
            return true;
        }
        return false;
    };

    // used for mining.notify
    this.getJobParams = function(){
        let nbits = util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex'));
        if (!this.jobParams){
            this.jobParams = [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.finalSaplingRootHashReversed,
                util.packUInt32LE(this.rpcData.curtime).toString('hex'),
                nbits.toString('hex'),
                true
            ];
            // VerusHash V2.1 activation
            if (this.rpcData.solution !== undefined && typeof this.rpcData.solution === "string") {
                // trim trailing 0's
                let reservedSolutionSpace = this.rpcData.solution.replace(/[0]+$/, "");
                if ((reservedSolutionSpace.length % 2) == 1) {
                    reservedSolutionSpace += "0";
                }
                this.jobParams.push(reservedSolutionSpace);
            }
        }
        return this.jobParams;
    };
};

/**
 * Checks that a getblocktemplate response has everything needed to build a job.
 * Returns a description of the problem, or null when the template is usable.
**/
BlockTemplate.validate = function (rpcData) {
    if (!rpcData || typeof rpcData !== 'object')
        return 'empty response';
    var required = ['version', 'previousblockhash', 'bits', 'target', 'curtime', 'height', 'solution', 'transactions'];
    for (var i = 0; i < required.length; i++) {
        if (typeof rpcData[required[i]] === 'undefined')
            return 'missing field "' + required[i] + '"';
    }
    if (!rpcData.coinbasetxn || !rpcData.coinbasetxn.data || !rpcData.coinbasetxn.hash)
        return 'missing coinbasetxn (a Verus daemon with PBaaS active is required)';
    if (parseInt(rpcData.solution.substr(0, 2), 16) <= 6)
        return 'unsupported solution version ' + rpcData.solution.substr(0, 8);
    return null;
};
