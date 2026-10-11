const crypto = require('crypto')


// Share difficulty 1 target. Each unit of difficulty is 2^256 / diff1 = 8192 hashes of work.
exports.diff1 = parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
exports.hashesPerDiff = Math.pow(2, 256) / exports.diff1


exports.sha256 = buffer => {
    let hash1 = crypto.createHash('sha256')
    hash1.update(buffer)
    return hash1.digest()
}

exports.sha256d = buffer => {
    return exports.sha256(exports.sha256(buffer))
}

exports.reverseBuffer = buff => {
    let reversed = Buffer.alloc(buff.length)
    for (let i = buff.length - 1; i >= 0; i--) {
        reversed[buff.length - i - 1] = buff[i]
    }

    return reversed
}

exports.reverseHex = hex => {
    return exports.reverseBuffer(
        Buffer.from(hex, 'hex')
    ).toString('hex')
}

exports.isHexString = s => {
    return typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s)
}


/*
 Defined in bitcoin protocol here:
 https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer
 */
exports.varIntBuffer = n => {
    if (n < 0xfd) {
        return Buffer.from([n])
    } else if (n <= 0xffff) {
        let buff = Buffer.alloc(3)
        buff[0] = 0xfd
        buff.writeUInt16LE(n, 1)
        return buff
    } else {
        let buff = Buffer.alloc(5)
        buff[0] = 0xfe
        buff.writeUInt32LE(n, 1)
        return buff
    }
}


exports.packUInt32LE = num => {
    let buff = Buffer.alloc(4)
    buff.writeUInt32LE(num, 0)
    return buff
}

exports.packUInt32BE = num => {
    let buff = Buffer.alloc(4)
    buff.writeUInt32BE(num, 0)
    return buff
}

exports.packInt64LE = num => {
    let buff = Buffer.alloc(8)
    buff.writeUInt32LE(num % Math.pow(2, 32), 0)
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4)
    return buff
}


// Interprets a buffer as an unsigned integer
exports.bigIntFromBufferBE = buff => {
    return buff.length === 0 ? 0n : BigInt('0x' + buff.toString('hex'))
}

exports.bigIntFromBufferLE = buff => {
    return exports.bigIntFromBufferBE(exports.reverseBuffer(buff))
}

/*
 Used to convert getblocktemplate bits field into target if target is not included.
 More info: https://en.bitcoin.it/wiki/Target
 */
exports.bigIntFromBitsBuffer = bitsBuff => {
    let numBytes = bitsBuff.readUInt8(0)
    let bigBits = exports.bigIntFromBufferBE(bitsBuff.slice(1))
    let shift = 8 * (numBytes - 3)

    return shift >= 0 ? bigBits << BigInt(shift) : bigBits >> BigInt(-shift)
}

exports.bigIntFromBitsHex = bitsString => {
    return exports.bigIntFromBitsBuffer(
        Buffer.from(bitsString, 'hex')
    )
}


exports.getReadableHashRateString = hashrate => {
    let units = [' H/s', ' kH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s']
    let i = 0
    hashrate = Number(hashrate) || 0
    while (hashrate >= 1000 && i < units.length - 1) {
        hashrate = hashrate / 1000
        i++
    }

    return hashrate.toFixed(2) + units[i]
}
