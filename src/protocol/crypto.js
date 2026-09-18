import { createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * LANLink cryptographic primitives.
 *
 * A port of the device-key derivation and wire-frame cipher from the Aqara LANLink integration for
 * Home Assistant, which in turn recovered them from the decompiled `liblanlink.so`. Every
 * operation is deterministic given the same inputs, and the tests use the captured wire vectors,
 * so a mistake here shows up as a failing test rather than a hub that refuses to talk.
 *
 * Wire frame:
 *     [0xFF] [0xFE] [2B type BE] [4B ciphertext length BE] [ciphertext] [2B CRC BE]
 *
 * The trailing CRC is CRC-16/CCITT over the ciphertext only, never the header.
 */

/** ECDH key exchange, encrypted with the device key. */
export const MSG_TYPE_ECDH = 0x2020;
/** Session key verification, encrypted with the device key. */
export const MSG_TYPE_VERIFY = 0x201B;
/** Session data - JSON - encrypted with the session key. */
export const MSG_TYPE_SESSION = 0x2021;

export const FRAME_MAGIC = Buffer.from([0xFF, 0xFE]);
export const FRAME_HEADER_LEN = 8;
export const FRAME_TRAILER_LEN = 2;

/**
 * A frame's declared length is four bytes wide, and a real hub never sends more than a few tens of
 * kilobytes. Refusing anything larger stops a buggy or malicious peer from making the read loop
 * buffer without end.
 */
export const MAX_FRAME_CT_LEN = 256 * 1024;

/**
 * @param {Buffer|Uint8Array} data The bytes to sum.
 * @returns {number} CRC-16/CCITT: polynomial 0x1021, initial value 0xFFFF, final XOR 0xFFFF.
 */
export function crc16Ccitt(data) {
  let crc = 0xFFFF;

  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }

  return crc ^ 0xFFFF;
}

/**
 * Derives the 16-byte AES device key from a device id.
 *
 * Both ends work it out independently from the same id, so nothing is exchanged. The passes look
 * arbitrary because they are: this is what the native library does, recovered instruction by
 * instruction, and it has to be reproduced exactly.
 *
 * @param {string} deviceId The device id, as the hub and the cloud spell it.
 * @returns {Buffer} The 16-byte key.
 */
export function deriveDeviceKey(deviceId) {
  const original = Buffer.from(deviceId, 'ascii');
  const length = original.length;
  const buf = Buffer.from(original);

  // Pass 1: XOR adjacent characters with the position-reversed tail. Reads from the snapshot
  // taken before the pass, writes into the working buffer.
  for (let i = 0; i < length - 1; i += 1) {
    buf[i] = ((original[i] ^ original[i + 1]) + buf[length - 1 - i]) & 0xFF;
  }

  // Pass 2: fold the first half, XOR'd with mid-shifted values, into the tail.
  const half = length >> 1;
  for (let i = 0; i < half; i += 1) {
    buf[length - 1 - i] = buf[i] ^ buf[i + half - 1];
  }

  // Pass 3: fold the buffer, read back to front, into six bytes.
  const key6 = Buffer.alloc(6);
  for (let i = 0; i < length; i += 1) {
    key6[i % 6] ^= buf[length - 1 - i];
  }

  // Pass 4: mix those six bytes further.
  for (let i = 0; i < 6; i += 1) {
    const idx = i % 6;
    key6[idx] = (key6[idx] + (key6[5 - idx] ^ key6[(i + 3) % 6])) & 0xFF;
  }

  // A CRC of the six bytes makes an eight-byte seed.
  const crc = crc16Ccitt(key6);
  const seed = Buffer.alloc(16);
  key6.copy(seed, 0);
  seed[6] = crc & 0xFF;
  seed[7] = (crc >> 8) & 0xFF;

  // Pass 5: the upper half is the lower half XOR'd with one byte of it, in reverse.
  const anchor = seed[7];
  for (let i = 0; i < 8; i += 1) {
    seed[15 - i] = seed[i] ^ anchor;
  }

  // Pass 6: chain-XOR the whole thing in place. The wrap at the last byte reads the first one
  // after it has already been changed - which is exactly why a read-then-write version of this
  // loop produces a different final byte, and a hub that will not talk to you.
  for (let i = 0; i < 16; i += 1) {
    const next = i === 15 ? 0 : i + 1;
    seed[i] = (seed[i] ^ seed[next]) & 0xFF;
  }

  return seed;
}

/**
 * @param {Buffer} key The 16-byte key, which is also the initialisation vector.
 * @param {Buffer|Uint8Array} plaintext What to encrypt.
 * @returns {Buffer} AES-128-CBC with PKCS7 padding.
 */
export function aesCbcEncrypt(key, plaintext) {
  const cipher = createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

/**
 * @param {Buffer} key The 16-byte key, which is also the initialisation vector.
 * @param {Buffer|Uint8Array} ciphertext What to decrypt.
 * @returns {Buffer} The plaintext, unpadded.
 */
export function aesCbcDecrypt(key, ciphertext) {
  const decipher = createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
}

/**
 * @param {number} type The message type.
 * @param {Buffer} ciphertext The encrypted payload.
 * @returns {Buffer} The frame as it goes on the wire.
 */
export function encodeFrame(type, ciphertext) {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt16BE(type, 2);
  header.writeUInt32BE(ciphertext.length, 4);

  const trailer = Buffer.alloc(FRAME_TRAILER_LEN);
  trailer.writeUInt16BE(crc16Ccitt(ciphertext), 0);

  return Buffer.concat([header, ciphertext, trailer]);
}

/**
 * Takes one frame off the head of a buffer.
 *
 * @param {Buffer} data Whatever has been read from the socket so far.
 * @returns {{frame: {type: number, ciphertext: Buffer}, rest: Buffer}|null} The frame and what
 *   follows it, or null when the frame is not all there yet.
 * @throws {Error} On a frame that can never be right: bad magic, an impossible length, a bad CRC.
 */
export function parseFrame(data) {
  if (data.length < FRAME_HEADER_LEN) {
    return null;
  }

  if (data[0] !== FRAME_MAGIC[0] || data[1] !== FRAME_MAGIC[1]) {
    throw new Error(`Bad magic: expected FF FE, got ${data.subarray(0, 2).toString('hex')}`);
  }

  const type = data.readUInt16BE(2);
  const ctLength = data.readUInt32BE(4);

  // Checked before deciding to wait for more, so a bogus length cannot make the caller buffer.
  if (ctLength > MAX_FRAME_CT_LEN) {
    throw new Error(`Frame ciphertext length ${ctLength} is too large (max ${MAX_FRAME_CT_LEN})`);
  }

  const total = FRAME_HEADER_LEN + ctLength + FRAME_TRAILER_LEN;
  if (data.length < total) {
    return null;
  }

  const ciphertext = data.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + ctLength);
  const trailer = data.readUInt16BE(FRAME_HEADER_LEN + ctLength);
  const expected = crc16Ccitt(ciphertext);

  if (trailer !== expected) {
    throw new Error(`Bad CRC: expected ${expected.toString(16)}, got ${trailer.toString(16)}`);
  }

  return { frame: { type, ciphertext: Buffer.from(ciphertext) }, rest: data.subarray(total) };
}
