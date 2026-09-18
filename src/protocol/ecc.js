/**
 * Elliptic-curve arithmetic over the binary field the LANLink handshake uses.
 *
 * Aqara's library does not use a standard curve, so neither Node's crypto nor OpenSSL will do it
 * for us: the field is GF(2^163), where addition is XOR and multiplication is carry-less. The
 * parameters were recovered from the running library by the Home Assistant integration this is
 * ported from.
 *
 *     field       GF(2^163), reduction polynomial x^163 + x^7 + x^6 + x^3 + 1
 *     equation    y^2 + xy = x^3 + a*x^2 + b
 *     a           1
 *     b           0x020a601907b8c953ca1481eb10512f78744a3205fd
 *
 * On the wire a private key is 24 little-endian bytes and a public key is 48: little-endian x
 * followed by little-endian y. Everything in between is done on BigInt and only byte-swapped at
 * the edges.
 */

/** x^163 + x^7 + x^6 + x^3 + 1 */
const FIELD_POLY = (1n << 163n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | 1n;

const CURVE_B = 0x020A601907B8C953CA1481EB10512F78744A3205FDn;
const GEN_X = 0x03F0EBA16286A2D57EA0991168D4994637E8343E36n;
const GEN_Y = 0x00D51FBC6C71A0094FA2CDD545B11C5C0C797324F1n;
const CURVE_ORDER = 0x040000000000000000000292FE77E70C12A4234C33n;

/** A private key, and each coordinate of a public key, padded to this many bytes. */
export const KEY_BYTES = 24;
export const PUBKEY_BYTES = 48;

/** The point at infinity, the identity of the group. */
const INFINITY = { x: null, y: null };

/**
 * @param {bigint} value A field element.
 * @returns {number} How many bits it takes.
 */
function bitLength(value) {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * @param {bigint} value The field element.
 * @returns {Buffer} It, as 24 little-endian bytes.
 */
export function fieldToBytes(value) {
  const out = Buffer.alloc(KEY_BYTES);
  let rest = value;

  for (let i = 0; i < KEY_BYTES; i += 1) {
    out[i] = Number(rest & 0xFFn);
    rest >>= 8n;
  }

  return out;
}

/**
 * @param {Buffer} data 24 little-endian bytes.
 * @returns {bigint} The field element.
 */
export function bytesToField(data) {
  if (data.length !== KEY_BYTES) {
    throw new Error(`Expected ${KEY_BYTES} bytes, got ${data.length}`);
  }

  let value = 0n;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(data[i]);
  }
  return value;
}

/**
 * @param {bigint} x The x coordinate.
 * @param {bigint} y The y coordinate.
 * @returns {Buffer} The point, as the 48 bytes the library puts on the wire.
 */
export function pubkeyToBytes(x, y) {
  return Buffer.concat([fieldToBytes(x), fieldToBytes(y)]);
}

/**
 * @param {Buffer} data 48 bytes from the wire.
 * @returns {{x: bigint, y: bigint}} The point.
 */
export function bytesToPubkey(data) {
  if (data.length !== PUBKEY_BYTES) {
    throw new Error(`Expected ${PUBKEY_BYTES} bytes, got ${data.length}`);
  }

  return {
    x: bytesToField(data.subarray(0, KEY_BYTES)),
    y: bytesToField(data.subarray(KEY_BYTES)),
  };
}


/*----------========== THE FIELD ==========----------*/

/**
 * @param {bigint} a A polynomial over GF(2).
 * @param {bigint} b Another.
 * @returns {bigint} Their product, unreduced. Carry-less: there is nothing to carry in GF(2).
 */
function gfMul(a, b) {
  let result = 0n;
  let left = a;
  let right = b;

  while (right) {
    if (right & 1n) {
      result ^= left;
    }
    left <<= 1n;
    right >>= 1n;
  }

  return result;
}

/**
 * @param {bigint} value A polynomial.
 * @returns {bigint} It, reduced modulo the field polynomial.
 */
function gfMod(value) {
  const polyLength = bitLength(FIELD_POLY);
  let rest = value;

  while (bitLength(rest) >= polyLength) {
    rest ^= FIELD_POLY << BigInt(bitLength(rest) - polyLength);
  }

  return rest;
}

/**
 * @param {bigint} a A field element.
 * @param {bigint} b Another.
 * @returns {bigint} Their product in the field.
 */
function gfMulMod(a, b) {
  return gfMod(gfMul(a, b));
}

/**
 * @param {bigint} value A field element.
 * @returns {bigint} Its square. Squaring in GF(2) spreads the bits apart; no additions arise.
 */
function gfSqr(value) {
  let result = 0n;
  let rest = value;
  let i = 0n;

  while (rest) {
    if (rest & 1n) {
      result |= 1n << (2n * i);
    }
    rest >>= 1n;
    i += 1n;
  }

  return gfMod(result);
}

/**
 * @param {bigint} value A field element.
 * @returns {bigint} Its inverse, by the extended Euclidean algorithm over GF(2)[x].
 */
function gfInv(value) {
  if (value === 0n) {
    throw new Error('Cannot invert zero in GF(2^163)');
  }

  let u = value;
  let v = FIELD_POLY;
  let g1 = 1n;
  let g2 = 0n;

  while (u !== 1n) {
    let j = bitLength(u) - bitLength(v);

    if (j < 0) {
      [u, v] = [v, u];
      [g1, g2] = [g2, g1];
      j = -j;
    }

    u ^= v << BigInt(j);
    g1 ^= g2 << BigInt(j);
  }

  return gfMod(g1);
}


/*----------========== THE CURVE ==========----------*/

/**
 * @param {{x: bigint|null, y: bigint|null}} point The point to test.
 * @param {bigint} a The curve's a coefficient.
 * @returns {boolean} Whether it satisfies y^2 + xy = x^3 + a*x^2 + b.
 */
function isOnCurve(point, a = 1n) {
  if (point.x === null) {
    return true;
  }

  const left = gfSqr(point.y) ^ gfMulMod(point.x, point.y);
  const xSquared = gfSqr(point.x);
  const right = gfMulMod(xSquared, point.x) ^ gfMulMod(a, xSquared) ^ CURVE_B;

  return left === right;
}

/**
 * The a coefficient, settled by asking which value puts the library's own generator on the curve.
 * Only 0 and 1 are sensible for a binary curve.
 */
const CURVE_A = (() => {
  for (const candidate of [1n, 0n]) {
    if (isOnCurve({ x: GEN_X, y: GEN_Y }, candidate)) {
      return candidate;
    }
  }
  throw new Error('The captured generator lies on neither candidate curve');
})();

const GENERATOR = { x: GEN_X, y: GEN_Y };

/**
 * @param {{x: bigint|null, y: bigint|null}} point The point to double.
 * @returns {{x: bigint|null, y: bigint|null}} Twice it.
 */
function pointDouble(point) {
  if (point.x === null || point.x === 0n) {
    return INFINITY;
  }

  const lambda = point.x ^ gfMulMod(point.y, gfInv(point.x));
  const x = gfSqr(lambda) ^ lambda ^ CURVE_A;
  const y = gfSqr(point.x) ^ gfMulMod(lambda, x) ^ x;

  return { x, y };
}

/**
 * @param {{x: bigint|null, y: bigint|null}} p One point.
 * @param {{x: bigint|null, y: bigint|null}} q Another.
 * @returns {{x: bigint|null, y: bigint|null}} Their sum.
 */
function pointAdd(p, q) {
  if (p.x === null) {
    return q;
  }
  if (q.x === null) {
    return p;
  }

  if (p.x === q.x) {
    // In characteristic two the negative of (x, y) is (x, x + y), so equal x and unequal y means
    // the two cancel.
    return p.y === q.y ? pointDouble(p) : INFINITY;
  }

  const dx = p.x ^ q.x;
  const lambda = gfMulMod(p.y ^ q.y, gfInv(dx));
  const x = gfSqr(lambda) ^ lambda ^ dx ^ CURVE_A;
  const y = gfMulMod(lambda, p.x ^ x) ^ x ^ p.y;

  return { x, y };
}

/**
 * @param {bigint} k How many times to add the point to itself.
 * @param {{x: bigint|null, y: bigint|null}} point The point.
 * @returns {{x: bigint|null, y: bigint|null}} k times it, by double-and-add from the top bit down.
 */
function multiply(k, point) {
  let result = INFINITY;

  for (let i = bitLength(k) - 1; i >= 0; i -= 1) {
    result = pointDouble(result);
    if ((k >> BigInt(i)) & 1n) {
      result = pointAdd(result, point);
    }
  }

  return result;
}

/**
 * @param {bigint} k The scalar.
 * @param {{x: bigint|null, y: bigint|null}} point The point.
 * @returns {{x: bigint|null, y: bigint|null}} k times it, with the scalar taken modulo the group
 *   order first - which is what anything but a subgroup test wants.
 */
function scalarMultiply(k, point) {
  const scalar = ((k % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  if (scalar === 0n || point.x === null) {
    return INFINITY;
  }

  return multiply(scalar, point);
}


/*----------========== WHAT THE HANDSHAKE ASKS FOR ==========----------*/

/**
 * @param {Buffer} privBytes A 24-byte little-endian private key.
 * @returns {Buffer} The matching public key, 48 bytes.
 */
export function publicKeyFromPrivate(privBytes) {
  const point = scalarMultiply(bytesToField(privBytes), GENERATOR);

  if (point.x === null) {
    throw new Error('That private key produces the point at infinity');
  }

  return pubkeyToBytes(point.x, point.y);
}

/**
 * @param {{x: bigint, y: bigint}} point A peer's point.
 * @returns {boolean} Whether it lies in the prime-order subgroup the generator spans. The curve
 *   has cofactor two, so half its points do not, and multiplying by one of those would leak bits
 *   of our own key.
 */
function isInPrimeSubgroup(point) {
  return multiply(CURVE_ORDER, point).x === null;
}

/**
 * @param {Buffer} privBytes Our 24-byte private key.
 * @param {Buffer} peerPubBytes The peer's 48-byte public key.
 * @returns {Buffer} The x coordinate of our key times theirs, 24 little-endian bytes. The
 *   handshake takes the first sixteen of these as the session key.
 */
export function sharedSecret(privBytes, peerPubBytes) {
  const peer = bytesToPubkey(peerPubBytes);

  // Checked before the multiplication, never after: a peer sending a point off the curve or
  // outside the subgroup is trying to learn our private key one session at a time. A real hub
  // always sends a good point, so this costs interoperability nothing.
  if (peer.x === null) {
    throw new Error('The peer sent the point at infinity');
  }
  if (!isOnCurve(peer, CURVE_A)) {
    throw new Error('The peer sent a point that is not on the curve');
  }
  if (!isInPrimeSubgroup(peer)) {
    throw new Error('The peer sent a point outside the prime-order subgroup');
  }

  const shared = scalarMultiply(bytesToField(privBytes), peer);
  if (shared.x === null) {
    throw new Error('The shared secret is the point at infinity');
  }

  return fieldToBytes(shared.x);
}

export const curve = { FIELD_POLY, CURVE_A, CURVE_B, CURVE_ORDER, GENERATOR, INFINITY, isOnCurve, pointAdd, pointDouble, scalarMultiply };
