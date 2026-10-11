var events = require('events');
var crypto = require('crypto');

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');

var vh = require('../../build/Release/verushash.node');

// equihash 200,9 sized solution field, hex encoded with its 3 byte compact size prefix
const SOLUTION_LENGTH = 2694;
const SOLUTION_SLICE = 6;

const INVALID_HASH = Buffer.alloc(32, 0xff);

//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - updatedBlock(blockTemplate) - When the template for the current height changed (new transactions, PBaaS data, ...)
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    this.currentJob;
    this.validJobs = {};

    this.updateCurrentJob = function (rpcData) {
        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {
        // generate template for processing
        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData
        );
        // if any non-canonical data has changed, this is a new block template (even if the height didn't change)
        let cleanJob = typeof(_this.currentJob) === 'undefined';
        if (!cleanJob) {
            // if outdated block ignore ...
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;

            // check non-canonical data for changes and force clean job
            if (_this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed)
                cleanJob = true;
            if (_this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed)
                cleanJob = true;
            if (_this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed)
                cleanJob = true;
            if (_this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits)
                cleanJob = true;
            if (_this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution)
                cleanJob = true;
        }
        // if not a new clean block template
        if (!cleanJob) return false;

        let newBlock = !this.currentJob || (rpcData.height !== _this.currentJob.rpcData.height);
        if (!newBlock) {
            this.updateCurrentJob(rpcData);
            return false;
        }

        // accept new template
        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }

        if (typeof nTime !== 'string' || nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }

        let nTimeInt = parseInt(nTime.substr(6, 2) + nTime.substr(4, 2) + nTime.substr(2, 2) + nTime.substr(0, 2), 16)

        if (Number.isNaN(nTimeInt)) {
            return shareError([20, 'invalid ntime'])
        }

        if (nTimeInt != job.rpcData.curtime) {
            return shareError([20, 'ntime out of range'])
        }

        if (typeof nonce !== 'string' || nonce.length !== 64) {
            return shareError([20, 'incorrect size of nonce']);
        }

        if (typeof soln !== 'string' || soln.length !== SOLUTION_LENGTH) {
            return shareError([20, 'Error: Incorrect size of solution (' + String(soln).length + '), expected ' + SOLUTION_LENGTH]);
        }
        if (!util.isHexString(soln)) {
            return shareError([20, 'invalid hex in solution']);
        }
        if (soln.substr(SOLUTION_SLICE, 8) !== job.rpcData.solution.substr(0, 8)) {
            return shareError([20, 'invalid solution version (' + soln.substr(SOLUTION_SLICE, 8) + '), expected ' + job.rpcData.solution.substr(0, 8)]);
        }
        if (!util.isHexString(extraNonce2)) {
            return shareError([20, 'invalid hex in extraNonce2']);
        }
        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }

        // with pbaas active the block header nonce comes from the daemon, pool/miner can no longer manipulate it.
        // verify pool nonce presence in solution
        let solExtraData = soln.substr(-30);
        if (solExtraData.indexOf(extraNonce1) < 0) {
            return shareError([20, 'invalid solution, pool nonce missing']);
        }

        var headerBuffer = job.serializeHeader(nTime, undefined); // 140 bytes (doesn't contain soln)
        var solnBuffer = Buffer.from(soln, 'hex');
        var headerSolnBuffer = Buffer.concat([headerBuffer, solnBuffer]);
        var headerHash = vh.hash2b2(headerSolnBuffer);

        // the hasher returns all ff when the merge mining data in the solution doesn't belong to this header
        if (headerHash.equals(INVALID_HASH)) {
            return shareError([20, 'invalid solution, merge mining data does not match the job']);
        }

        var headerBigNum = util.bigIntFromBufferLE(headerHash);

        var blockHash;
        var blockHex;

        var shareDiff = util.diff1 / Number(headerBigNum);
        var blockDiffAdjusted = job.difficulty;

        // pbaas minimal merged mining target
        let isOnlyPBaaS = false;
        let target = job.target;
        if (job.merged_target) {
            target = job.merged_target;
        }

        //check if block candidate
        if (headerBigNum <= target) {
            blockHex = job.serializeBlock(headerBuffer, solnBuffer).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
            // check if pbaas only submission
            if (!(headerBigNum <= job.target))
                isOnlyPBaaS = true;
        } else {
            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }
            }
        }

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.blockReward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockOnlyPBaaS: isOnlyPBaaS
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
