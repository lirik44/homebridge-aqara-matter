import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';

import {
  bytesToField,
  bytesToPubkey,
  curve,
  fieldToBytes,
  KEY_BYTES,
  publicKeyFromPrivate,
  PUBKEY_BYTES,
  sharedSecret,
} from '../src/protocol/ecc.js';

/** A private key the way the handshake makes one: 24 little-endian bytes inside the field. */
function privateKey(seed) {
  const bytes = seed ?? randomBytes(KEY_BYTES);
  const value = bytesToField(Buffer.from(bytes)) % (1n << 163n);
  return fieldToBytes(value === 0n ? 1n : value);
}

describe('the field and its serialisation', () => {
  it('carries a value there and back, little-endian as the library stores it', () => {
    const value = 0x03F0EBA16286A2D57EA0991168D4994637E8343E36n;
    const bytes = fieldToBytes(value);

    assert.equal(bytes.length, KEY_BYTES);
    assert.equal(bytes[0], 0x36, 'the low byte comes first');
    assert.equal(bytesToField(bytes), value);
  });

  it('refuses a buffer of the wrong size rather than reading rubbish', () => {
    assert.throws(() => bytesToField(Buffer.alloc(16)), /Expected 24 bytes/);
    assert.throws(() => bytesToPubkey(Buffer.alloc(24)), /Expected 48 bytes/);
  });
});

describe('the curve', () => {
  it('has the generator the library uses on it', () => {
    assert.equal(curve.isOnCurve(curve.GENERATOR, curve.CURVE_A), true);
  });

  it('settles on a = 1, which is what puts that generator there', () => {
    assert.equal(curve.CURVE_A, 1n);
    assert.equal(curve.isOnCurve(curve.GENERATOR, 0n), false);
  });

  it('keeps points on the curve through doubling and addition', () => {
    const twice = curve.pointDouble(curve.GENERATOR);
    const thrice = curve.pointAdd(twice, curve.GENERATOR);

    assert.equal(curve.isOnCurve(twice, curve.CURVE_A), true);
    assert.equal(curve.isOnCurve(thrice, curve.CURVE_A), true);
  });

  it('adds a point to its own negative and lands on infinity', () => {
    // In characteristic two the negative of (x, y) is (x, x + y).
    const negative = { x: curve.GENERATOR.x, y: curve.GENERATOR.x ^ curve.GENERATOR.y };
    assert.equal(curve.pointAdd(curve.GENERATOR, negative).x, null);
  });

  it('agrees with itself about what multiplication means', () => {
    const byFive = curve.scalarMultiply(5n, curve.GENERATOR);
    const byHand = curve.pointAdd(curve.pointDouble(curve.pointDouble(curve.GENERATOR)), curve.GENERATOR);

    assert.equal(byFive.x, byHand.x);
    assert.equal(byFive.y, byHand.y);
  });

  it('takes the group order to infinity, which is what makes it the order', () => {
    assert.equal(curve.scalarMultiply(curve.CURVE_ORDER, curve.GENERATOR).x, null);
  });
});

describe('the key exchange', () => {
  it('turns a private key into a public one of the size the wire expects', () => {
    const pub = publicKeyFromPrivate(privateKey());
    assert.equal(pub.length, PUBKEY_BYTES);

    const point = bytesToPubkey(pub);
    assert.equal(curve.isOnCurve(point, curve.CURVE_A), true);
  });

  it('has both sides arrive at the same secret, which is the whole point', () => {
    const ours = privateKey();
    const theirs = privateKey();

    const oursFromTheirs = sharedSecret(ours, publicKeyFromPrivate(theirs));
    const theirsFromOurs = sharedSecret(theirs, publicKeyFromPrivate(ours));

    assert.deepEqual(oursFromTheirs, theirsFromOurs);
    assert.equal(oursFromTheirs.length, KEY_BYTES);
    assert.notDeepEqual(oursFromTheirs, Buffer.alloc(KEY_BYTES));
  });

  it('gives a different secret to a different pair of keys', () => {
    const ours = privateKey();
    const first = sharedSecret(ours, publicKeyFromPrivate(privateKey()));
    const second = sharedSecret(ours, publicKeyFromPrivate(privateKey()));

    assert.notDeepEqual(first, second);
  });

  it('refuses a peer key that is not on the curve', () => {
    // A peer that can choose points off the curve can learn our private key a session at a time.
    const offCurve = Buffer.concat([fieldToBytes(2n), fieldToBytes(3n)]);
    assert.throws(() => sharedSecret(privateKey(), offCurve), /not on the curve/);
  });

  it('refuses the point at infinity', () => {
    assert.throws(() => sharedSecret(privateKey(), Buffer.alloc(PUBKEY_BYTES)), /not on the curve|infinity/);
  });
});

describe('against the implementation this was ported from', () => {
  // Run with the same two private keys, the Python original produces exactly these bytes. Anything
  // that changes them has changed the protocol, whatever the other tests say.
  const PRIV_A = fieldToBytes(0x0123456789ABCDEF0123456789ABCDEF01234567n);
  const PRIV_B = fieldToBytes(0x0FEDCBA9876543210FEDCBA987654321FEDCBA98n);

  const PUB_A = '4d7c1db9b1a77d2cdcf2428e6e674676ccc2ab08030000004d81fa94951edcf7bcfadf43ba54b18edf537a5706000000';
  const PUB_B = 'd2320579535b2f6fe59ec93a506804d485413a7501000000d93d32de924c4b1650938a5fe835889b1d5e794207000000';
  const SECRET = 'dd84cf4af3731516cee1f563ef241e440ca1481b05000000';

  it('derives the same public keys', () => {
    assert.equal(publicKeyFromPrivate(PRIV_A).toString('hex'), PUB_A);
    assert.equal(publicKeyFromPrivate(PRIV_B).toString('hex'), PUB_B);
  });

  it('arrives at the same shared secret, from either side', () => {
    assert.equal(sharedSecret(PRIV_A, Buffer.from(PUB_B, 'hex')).toString('hex'), SECRET);
    assert.equal(sharedSecret(PRIV_B, Buffer.from(PUB_A, 'hex')).toString('hex'), SECRET);
  });
});
