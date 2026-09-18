import { createServer } from 'node:net';
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
} from '../../src/protocol/crypto.js';
import { bytesToField, fieldToBytes, KEY_BYTES, publicKeyFromPrivate, PUBKEY_BYTES, sharedSecret } from '../../src/protocol/ecc.js';

/**
 * A hub, as far as the protocol is concerned.
 *
 * It runs the same handshake a real one does - derives the device key from its id, exchanges keys
 * over the curve, proves it holds the session key - and then answers check-in, reads, writes and
 * topology, and pushes reports when asked to. That makes it possible to build and test everything
 * above the wire without a hub that will talk to us.
 */
export class FakeHub {
  /**
   * @param {object} [options] What sort of hub to be.
   * @param {string} [options.deviceId] Its id, which the device key is derived from.
   * @param {boolean} [options.acceptSession] Whether to answer the check-in at all. A hub with
   *   local control switched off completes the handshake and then says nothing, which is the one
   *   failure worth being able to reproduce.
   */
  constructor({ deviceId = 'lumi3.testhub00000001', acceptSession = true } = {}) {
    this.deviceId = deviceId;
    this.deviceKey = deriveDeviceKey(deviceId);
    this.acceptSession = acceptSession;
    this.server = null;
    this.sockets = new Set();
    this.sessionKeys = new Map();
    this.written = [];
    this.devices = new Map();
  }

  /**
   * @returns {Promise<{host: string, port: number, deviceId: string}>} Where it is listening.
   */
  async listen() {
    this.server = createServer(socket => this.serve(socket));

    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();

    return { host: '127.0.0.1', port, deviceId: this.deviceId };
  }

  /**
   * @returns {Promise<void>} Resolves once it has stopped.
   */
  async close() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise(resolve => (this.server ? this.server.close(resolve) : resolve()));
    this.server = null;
  }

  /**
   * Pushes a report, the way a hub tells a controller that something changed.
   *
   * @param {string} deviceId Which device changed.
   * @param {Record<string, *>} attrs What it changed to, by wire path.
   * @returns {void}
   */
  pushReport(deviceId, attrs) {
    for (const socket of this.sockets) {
      const key = this.sessionKeys.get(socket);
      if (key) {
        this.send(socket, key, { seq: 0, type: 'device', cmd: 'report', data: { did: deviceId, attrs } });
      }
    }
  }


  /*----------========== THE WIRE ==========----------*/

  serve(socket) {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.sessionKeys.delete(socket);
    });
    socket.on('error', () => {});

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        let parsed;
        try {
          parsed = parseFrame(buffer);
        } catch {
          socket.destroy();
          return;
        }

        if (!parsed) {
          return;
        }

        buffer = parsed.rest;
        this.onFrame(socket, parsed.frame);
      }
    });
  }

  onFrame(socket, frame) {
    if (frame.type === MSG_TYPE_ECDH) {
      this.onKeyExchange(socket, frame);
      return;
    }

    if (frame.type === MSG_TYPE_VERIFY) {
      this.onVerify(socket, frame);
      return;
    }

    if (frame.type === MSG_TYPE_SESSION) {
      this.onSession(socket, frame);
    }
  }

  onKeyExchange(socket, frame) {
    const plaintext = aesCbcDecrypt(this.deviceKey, frame.ciphertext);
    const theirs = plaintext.subarray(2, 2 + PUBKEY_BYTES);

    let priv = bytesToField(randomBytes(KEY_BYTES)) % (1n << 163n);
    if (priv === 0n) {
      priv = 1n;
    }
    const privBytes = fieldToBytes(priv);

    this.sessionKeys.set(socket, sharedSecret(privBytes, theirs).subarray(0, 16));
    socket.write(encodeFrame(MSG_TYPE_ECDH, aesCbcEncrypt(this.deviceKey, Buffer.concat([
      Buffer.from([0x00, 0x30]),
      publicKeyFromPrivate(privBytes),
    ]))));
  }

  onVerify(socket, frame) {
    const key = this.sessionKeys.get(socket);
    const challenge = randomBytes(4);
    const first = aesCbcEncrypt(key, challenge);
    const second = aesCbcEncrypt(key, first);

    // The proof a real hub sends: its own challenge encrypted, and that encrypted again.
    socket.write(encodeFrame(MSG_TYPE_VERIFY, aesCbcEncrypt(this.deviceKey, Buffer.concat([
      Buffer.from([0x00, 0x10]), first,
      Buffer.from([0x00, 0x20]), second,
    ]))));
  }

  onSession(socket, frame) {
    const key = this.sessionKeys.get(socket);
    const message = JSON.parse(aesCbcDecrypt(key, frame.ciphertext).toString('utf8'));

    if (!this.acceptSession) {
      // What a hub with local control switched off does: nothing at all.
      return;
    }

    const answer = data => this.send(socket, key, { seq: message.seq, type: 'session', cmd: `${message.cmd}_done`, data });

    switch (message.cmd) {
      case 'checkin':
        answer({ code: message.data?.aid ? 0 : 2 });
        break;

      case 'keepalive':
        answer({ code: 0 });
        break;

      case 'write':
        this.written.push({ did: message.data?.did, attrs: message.data?.attrs });
        answer({ code: 0 });
        break;

      case 'read': {
        const known = this.devices.get(message.data?.did) ?? {};
        const attrs = {};
        for (const path of message.data?.attrs ?? []) {
          attrs[path] = known[path];
        }
        answer({ code: 0, attrs });
        break;
      }

      case 'topology':
        answer({ code: 0, devices: [...this.devices.keys()].map(did => ({ did })) });
        break;

      default:
        answer({ code: 0 });
    }
  }

  send(socket, key, message) {
    socket.write(encodeFrame(MSG_TYPE_SESSION, aesCbcEncrypt(key, Buffer.from(JSON.stringify(message, null, 2)))));
  }
}
