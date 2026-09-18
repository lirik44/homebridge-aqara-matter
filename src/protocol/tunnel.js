import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';

import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  deriveDeviceKey,
  encodeFrame,
  MSG_TYPE_ECDH,
  MSG_TYPE_SESSION,
  MSG_TYPE_VERIFY,
  parseFrame,
} from './crypto.js';
import { fieldToBytes, bytesToField, KEY_BYTES, publicKeyFromPrivate, PUBKEY_BYTES, sharedSecret } from './ecc.js';

/**
 * The encrypted tunnel to an Aqara hub, and the JSON session that runs inside it.
 *
 * The hub advertises itself over mDNS as `_aqara-setup._tcp`; the port comes from there. What
 * follows is:
 *
 *   1. Both sides derive the device key from the hub's id - nothing is exchanged for it.
 *   2. We send our public key and a nonce, encrypted with that device key.
 *   3. The hub sends its public key back, and the first sixteen bytes of the shared secret become
 *      the session key.
 *   4. Each side proves it can run the session cipher.
 *   5. Everything after that is JSON, encrypted with the session key.
 *
 * The exchange is unauthenticated - a protocol limitation, not an oversight here - so the cloud
 * token is only ever sent once a session key is in place.
 */

/** Long enough for a hub that is busy, short enough that a dead one is noticed. */
const HANDSHAKE_TIMEOUT_MS = 10000;

/** How often to tell the hub we are still here. It closes a quiet connection. */
const KEEPALIVE_MS = 30000;

/** How long to wait for a reply to a request before giving up on it. */
const REQUEST_TIMEOUT_MS = 10000;

export class TunnelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelError';
  }
}

export class AqaraTunnel extends EventEmitter {
  /**
   * @param {object} options Where and who.
   * @param {string} options.host The hub's address.
   * @param {number} options.port The port it advertised over mDNS.
   * @param {string} options.deviceId The hub's device id, which the device key is derived from.
   */
  constructor({ host, port, deviceId }) {
    super();
    this.host = host;
    this.port = port;
    this.deviceId = deviceId;
    this.deviceKey = deriveDeviceKey(deviceId);
    this.sessionKey = null;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.frameWaiters = [];
    this.pending = new Map();
    this.seq = 0;
    this.keepaliveTimer = null;
  }

  /**
   * Connects and runs the handshake.
   *
   * @returns {Promise<void>} Resolves once the session key is in place.
   */
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const failed = (error) => reject(new TunnelError(`Could not reach ${this.host}:${this.port}: ${error.message}`));

      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => failed(new Error('timed out')));
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', failed);
        this.socket = socket;
        socket.on('data', chunk => this.onData(chunk));
        socket.on('error', error => this.emit('error', error));
        socket.on('close', () => this.onClose());
        resolve();
      });
    });

    await this.handshake();
  }

  /**
   * @returns {void}
   */
  close() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }


  /*----------========== THE HANDSHAKE ==========----------*/

  /**
   * @returns {Promise<void>} Resolves when both sides have proved they hold the session key.
   */
  async handshake() {
    // A private key is 24 little-endian bytes that fit in the field.
    let priv = bytesToField(randomBytes(KEY_BYTES)) % (1n << 163n);
    if (priv === 0n) {
      priv = 1n;
    }
    const privBytes = fieldToBytes(priv);

    const ours = publicKeyFromPrivate(privBytes);
    const nonce = randomBytes(16);
    await this.sendFrame(MSG_TYPE_ECDH, Buffer.concat([Buffer.from([0x00, 0x30]), ours, Buffer.from([0x00, 0x10]), nonce]), this.deviceKey);

    const offer = await this.nextFrame(MSG_TYPE_ECDH);
    const theirs = this.parseEcdhPayload(aesCbcDecrypt(this.deviceKey, offer.ciphertext));

    this.sessionKey = sharedSecret(privBytes, theirs).subarray(0, 16);

    // We prove it first: a four-byte challenge, and the same encrypted under the session key.
    const challenge = randomBytes(4);
    const encrypted = aesCbcEncrypt(this.sessionKey, challenge);
    await this.sendFrame(
      MSG_TYPE_VERIFY,
      Buffer.concat([Buffer.from([0x00, 0x04]), challenge, Buffer.from([0x00, 0x10]), encrypted]),
      this.deviceKey,
    );

    const proof = await this.nextFrame(MSG_TYPE_VERIFY);
    if (!this.hubProvedItself(aesCbcDecrypt(this.deviceKey, proof.ciphertext))) {
      throw new TunnelError('The hub failed to prove it holds the session key');
    }

    this.keepaliveTimer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
    this.keepaliveTimer.unref?.();
  }

  /**
   * @param {Buffer} plaintext A decrypted ECDH frame.
   * @returns {Buffer} The peer's 48-byte public key. The hub sends no nonce of its own.
   */
  parseEcdhPayload(plaintext) {
    if (plaintext.length < 2 + PUBKEY_BYTES) {
      throw new TunnelError('The hub sent a key exchange that is too short to hold a key');
    }
    if (plaintext[0] !== 0x00 || plaintext[1] !== 0x30) {
      throw new TunnelError(`Unexpected key exchange header: ${plaintext.subarray(0, 2).toString('hex')}`);
    }

    return plaintext.subarray(2, 2 + PUBKEY_BYTES);
  }

  /**
   * The hub's proof is `00 10 <enc1:16> 00 20 <enc2:32>`, where enc1 encrypts its own challenge
   * and enc2 encrypts enc1. Decrypting the second must give back the first.
   *
   * @param {Buffer} plaintext The decrypted verification frame.
   * @returns {boolean} Whether the hub can run the session cipher.
   */
  hubProvedItself(plaintext) {
    if (plaintext.length < 2 + 16 + 2 + 32) {
      return false;
    }

    const first = plaintext.subarray(2, 18);
    const second = plaintext.subarray(20, 52);

    try {
      return aesCbcDecrypt(this.sessionKey, second).equals(first);
    } catch {
      return false;
    }
  }


  /*----------========== THE SESSION ==========----------*/

  /**
   * Tells the hub who is asking. Nothing else works until this is done.
   *
   * @param {string} userId The cloud user id.
   * @param {string} token The cloud session token.
   * @returns {Promise<object>} The hub's answer.
   */
  async checkin(userId, token) {
    return this.request('checkin', { user: userId, did: this.deviceId, aid: token });
  }

  /**
   * @param {string[]} paths The resource paths to read, as `<endpoint>.<service>.<resource>`.
   * @param {string} [deviceId] Which device, when it is not the hub itself.
   * @returns {Promise<object>} What the hub answers.
   */
  async read(paths, deviceId = this.deviceId) {
    return this.request('read', { did: deviceId, attrs: paths });
  }

  /**
   * @param {Record<string, *>} values The resource paths to write, and what to write to them.
   * @param {string} [deviceId] Which device, when it is not the hub itself.
   * @returns {Promise<object>} What the hub answers.
   */
  async write(values, deviceId = this.deviceId) {
    return this.request('write', { did: deviceId, attrs: values });
  }

  /**
   * @returns {Promise<object>} Everything the hub has: itself and every device bound to it.
   */
  async topology() {
    return this.request('topology', {});
  }

  /**
   * @param {string} cmd The command.
   * @param {object} data Its payload.
   * @returns {Promise<object>} The hub's answer to this request, matched by sequence number.
   */
  async request(cmd, data) {
    if (!this.sessionKey) {
      throw new TunnelError('The tunnel is not open');
    }

    this.seq += 1;
    const seq = this.seq;
    const message = { seq, type: 'session', cmd, data };

    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TunnelError(`The hub did not answer ${cmd} within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(seq, { resolve, reject, timer });
    });

    try {
      // Indented, as the hub's own serialiser writes it: a compact body is refused in silence.
      await this.sendFrame(MSG_TYPE_SESSION, Buffer.from(JSON.stringify(message, null, 2)), this.sessionKey);
    } catch (error) {
      // Nothing will ever answer a request that never left, so settle it here rather than leave
      // its rejection to surface later with nobody listening.
      const waiting = this.pending.get(seq);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(seq);
        waiting.reject(error);
      }
    }

    return answer;
  }

  /**
   * @returns {void}
   */
  keepalive() {
    this.seq += 1;
    const message = { seq: this.seq, type: 'session', cmd: 'keepalive', data: { timestamp: Date.now() } };

    this.sendFrame(MSG_TYPE_SESSION, Buffer.from(JSON.stringify(message, null, 2)), this.sessionKey)
      .catch(error => this.emit('error', error));
  }


  /*----------========== THE WIRE ==========----------*/

  /**
   * @param {number} type The frame type.
   * @param {Buffer} plaintext What to say.
   * @param {Buffer} key Which key to say it with.
   * @returns {Promise<void>} Resolves once it is on the socket.
   */
  sendFrame(type, plaintext, key) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new TunnelError('The tunnel is closed'));
        return;
      }

      this.socket.write(encodeFrame(type, aesCbcEncrypt(key, plaintext)), error => (error ? reject(error) : resolve()));
    });
  }

  /**
   * @param {Buffer} chunk What arrived.
   * @returns {void}
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      let parsed;
      try {
        parsed = parseFrame(this.buffer);
      } catch (error) {
        this.emit('error', error);
        this.close();
        return;
      }

      if (!parsed) {
        return;
      }

      this.buffer = parsed.rest;
      this.onFrame(parsed.frame);
    }
  }

  /**
   * @param {{type: number, ciphertext: Buffer}} frame One decoded frame.
   * @returns {void}
   */
  onFrame(frame) {
    // Before the session key exists, frames belong to the handshake and are handed to whoever is
    // waiting for them; afterwards they are JSON and are dispatched by sequence number.
    if (frame.type !== MSG_TYPE_SESSION || !this.sessionKey) {
      const waiter = this.frameWaiters.shift();
      if (waiter) {
        waiter.resolve(frame);
      } else {
        this.frames.push(frame);
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(aesCbcDecrypt(this.sessionKey, frame.ciphertext).toString('utf8'));
    } catch (error) {
      this.emit('error', new TunnelError(`Could not read what the hub said: ${error.message}`));
      return;
    }

    const waiting = this.pending.get(message.seq);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(message.seq);
      waiting.resolve(message);
      return;
    }

    // Anything unasked for is the hub telling us something changed.
    this.emit('message', message);
  }

  /**
   * @param {number} type The frame type expected.
   * @returns {Promise<{type: number, ciphertext: Buffer}>} The next frame, handshake only.
   */
  nextFrame(type) {
    const queued = this.frames.shift();
    if (queued) {
      return Promise.resolve(this.expect(queued, type));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TunnelError('The hub went quiet during the handshake')), HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      this.frameWaiters.push({
        resolve: (frame) => {
          clearTimeout(timer);
          try {
            resolve(this.expect(frame, type));
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  /**
   * @param {{type: number}} frame A frame.
   * @param {number} type What it should be.
   * @returns {object} The frame, if it is.
   */
  expect(frame, type) {
    if (frame.type !== type) {
      throw new TunnelError(`Expected frame 0x${type.toString(16)}, got 0x${frame.type.toString(16)}`);
    }
    return frame;
  }

  /**
   * @returns {void}
   */
  onClose() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new TunnelError('The hub closed the connection'));
    }
    this.pending.clear();

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    this.emit('close');
  }
}
