import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  crc16Ccitt,
  deriveDeviceKey,
  encodeFrame,
  MSG_TYPE_ECDH,
  MSG_TYPE_SESSION,
  parseFrame,
} from '../src/protocol/crypto.js';

// The vectors the Home Assistant integration validated against captured traffic. A port that
// disagrees with these is a port a hub will not talk to.
const HUB_DEVICE_ID = 'lumi1.TESTHUB00001';
const HUB_DEVICE_KEY = Buffer.from('c86f4f36ef88e0f0e088ef364f6fc891', 'hex');

describe('crc-16/ccitt', () => {
  it('is zero over nothing', () => {
    assert.equal(crc16Ccitt(Buffer.alloc(0)), 0x0000);
  });

  it('matches the canonical check value, inverted as this variant inverts it', () => {
    // CRC-16/CCITT-FALSE answers 0x29B1 for "123456789"; the library's final XOR with 0xFFFF
    // makes that 0xD64E, and the hub checks every frame against this one.
    assert.equal(crc16Ccitt(Buffer.from('123456789')), 0x29B1 ^ 0xFFFF);
  });
});

describe('the device key', () => {
  it('is what the native library derives from the same id', () => {
    assert.deepEqual(deriveDeviceKey(HUB_DEVICE_ID), HUB_DEVICE_KEY);
  });

  it('is sixteen bytes, whatever the id', () => {
    assert.equal(deriveDeviceKey('lumi1.TESTDEV000002').length, 16);
    assert.equal(deriveDeviceKey('lumi1.54EF44FFFE1234AB').length, 16);
  });

  it('is the same every time', () => {
    assert.deepEqual(deriveDeviceKey(HUB_DEVICE_ID), deriveDeviceKey(HUB_DEVICE_ID));
  });
});

describe('the session cipher', () => {
  it('comes back out the way it went in', () => {
    const plaintext = Buffer.from('hello, aqara lanlink!');
    const ciphertext = aesCbcEncrypt(HUB_DEVICE_KEY, plaintext);

    assert.equal(ciphertext.length % 16, 0);
    assert.deepEqual(aesCbcDecrypt(HUB_DEVICE_KEY, ciphertext), plaintext);
  });

  it('pads a full block with a whole block, as PKCS7 does', () => {
    const plaintext = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    assert.equal(aesCbcEncrypt(HUB_DEVICE_KEY, plaintext).length, 32);
  });
});

describe('a wire frame', () => {
  it('goes out and comes back the same', () => {
    const ciphertext = aesCbcEncrypt(HUB_DEVICE_KEY, Buffer.from('{"seq":1}'));
    const wire = encodeFrame(MSG_TYPE_SESSION, ciphertext);

    assert.equal(wire.subarray(0, 2).toString('hex'), 'fffe');
    assert.equal(wire.readUInt16BE(2), MSG_TYPE_SESSION);
    assert.equal(wire.readUInt32BE(4), ciphertext.length);

    const { frame, rest } = parseFrame(wire);
    assert.equal(frame.type, MSG_TYPE_SESSION);
    assert.deepEqual(frame.ciphertext, ciphertext);
    assert.equal(rest.length, 0);
  });

  it('waits rather than guessing when the frame is only half here', () => {
    const wire = encodeFrame(MSG_TYPE_ECDH, aesCbcEncrypt(HUB_DEVICE_KEY, Buffer.from('half')));

    assert.equal(parseFrame(wire.subarray(0, 4)), null);
    assert.equal(parseFrame(wire.subarray(0, wire.length - 1)), null);
    assert.notEqual(parseFrame(wire), null);
  });

  it('hands back what follows it, so a read loop can carry on', () => {
    const first = encodeFrame(MSG_TYPE_SESSION, aesCbcEncrypt(HUB_DEVICE_KEY, Buffer.from('one')));
    const second = encodeFrame(MSG_TYPE_SESSION, aesCbcEncrypt(HUB_DEVICE_KEY, Buffer.from('two')));

    const { rest } = parseFrame(Buffer.concat([first, second]));
    assert.deepEqual(rest, second);
  });

  it('refuses a frame that can never be right', () => {
    const wire = encodeFrame(MSG_TYPE_SESSION, aesCbcEncrypt(HUB_DEVICE_KEY, Buffer.from('x')));

    const badMagic = Buffer.from(wire);
    badMagic[0] = 0x00;
    assert.throws(() => parseFrame(badMagic), /Bad magic/);

    const badCrc = Buffer.from(wire);
    badCrc[badCrc.length - 1] ^= 0xFF;
    assert.throws(() => parseFrame(badCrc), /Bad CRC/);

    // Four bytes of length, and a peer that claims four gigabytes.
    const huge = Buffer.from(wire);
    huge.writeUInt32BE(0x7FFFFFFF, 4);
    assert.throws(() => parseFrame(huge), /too large/);
  });
});
