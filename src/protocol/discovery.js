import { createSocket } from 'node:dgram';

/**
 * Finding Aqara hubs on the network, without a dependency and without the operating system's
 * cache in the way.
 *
 * Hubs advertise `_aqara-setup._tcp.local.` and put their device id in the TXT record. The port
 * they publish changes every time a hub reboots, so it is asked for when a connection is wanted
 * rather than remembered - a stale port is a connection refused.
 */

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_aqara-setup._tcp.local';

/** Record types, as the wire numbers them. */
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_A = 1;

/**
 * @param {string} name A name like `_aqara-setup._tcp.local`.
 * @returns {Buffer} It, as a DNS name: each label prefixed with its length, terminated by a zero.
 */
function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bytes = [];

  for (const part of parts) {
    bytes.push(part.length, ...Buffer.from(part, 'utf8'));
  }
  bytes.push(0);

  return Buffer.from(bytes);
}

/**
 * Reads a DNS name, following the compression pointers that make mDNS packets small.
 *
 * @param {Buffer} packet The whole packet, since a pointer may point anywhere in it.
 * @param {number} offset Where the name starts.
 * @returns {{name: string, offset: number}} The name, and where reading should carry on.
 */
function readName(packet, offset) {
  const labels = [];
  let cursor = offset;
  let after = null;

  for (;;) {
    if (cursor >= packet.length) {
      break;
    }

    const length = packet[cursor];

    if (length === 0) {
      cursor += 1;
      break;
    }

    // The top two bits set mean the rest is a pointer to where the name really lives.
    if ((length & 0xC0) === 0xC0) {
      const pointer = ((length & 0x3F) << 8) | packet[cursor + 1];
      after = cursor + 2;
      cursor = pointer;
      continue;
    }

    labels.push(packet.subarray(cursor + 1, cursor + 1 + length).toString('utf8'));
    cursor += 1 + length;
  }

  return { name: labels.join('.'), offset: after ?? cursor };
}

/**
 * @param {Buffer} packet A response packet.
 * @returns {Array<object>} Every record in it, answers and additionals alike.
 */
function parseRecords(packet) {
  if (packet.length < 12) {
    return [];
  }

  const counts = {
    questions: packet.readUInt16BE(4),
    answers: packet.readUInt16BE(6),
    authority: packet.readUInt16BE(8),
    additional: packet.readUInt16BE(10),
  };

  let offset = 12;

  for (let i = 0; i < counts.questions; i += 1) {
    offset = readName(packet, offset).offset + 4;
  }

  const records = [];
  const total = counts.answers + counts.authority + counts.additional;

  for (let i = 0; i < total && offset < packet.length; i += 1) {
    const { name, offset: afterName } = readName(packet, offset);
    if (afterName + 10 > packet.length) {
      break;
    }

    const type = packet.readUInt16BE(afterName);
    const dataLength = packet.readUInt16BE(afterName + 8);
    const dataAt = afterName + 10;
    const data = packet.subarray(dataAt, dataAt + dataLength);

    records.push({ name, type, data, dataAt, packet });
    offset = dataAt + dataLength;
  }

  return records;
}

/**
 * @param {Buffer} data A TXT record's bytes.
 * @returns {Record<string, string>} Its key/value pairs.
 */
function parseTxt(data) {
  const values = {};
  let offset = 0;

  while (offset < data.length) {
    const length = data[offset];
    const entry = data.subarray(offset + 1, offset + 1 + length).toString('utf8');
    const equals = entry.indexOf('=');

    if (equals > 0) {
      values[entry.slice(0, equals)] = entry.slice(equals + 1);
    }

    offset += 1 + length;
  }

  return values;
}

/**
 * Asks the network which Aqara hubs are about, and where.
 *
 * @param {object} [options] How long to listen, and on which interface.
 * @param {number} [options.timeoutMs] How long to collect answers for.
 * @returns {Promise<Array<{deviceId: string, host: string, port: number, name: string}>>} What
 *   answered, one entry per hub.
 */
export function discoverHubs({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const services = new Map();
    const addresses = new Map();

    const finish = () => {
      socket.close();

      const hubs = [];
      for (const service of services.values()) {
        // Everything on the local network answers on this socket; only the Aqara service counts.
        if (!service.name?.endsWith(`${SERVICE}`)) {
          continue;
        }
        const host = addresses.get(service.target) ?? service.target;
        if (service.deviceId && service.port) {
          hubs.push({ deviceId: service.deviceId, host, port: service.port, name: service.name });
        }
      }

      resolve(hubs);
    };

    socket.on('error', (error) => {
      socket.close();
      reject(error);
    });

    socket.on('message', (packet) => {
      for (const record of parseRecords(packet)) {
        if (record.type === TYPE_SRV) {
          const port = record.data.readUInt16BE(4);
          const { name: target } = readName(record.packet, record.dataAt + 6);
          const existing = services.get(record.name) ?? { name: record.name };
          services.set(record.name, { ...existing, port, target });
        }

        if (record.type === TYPE_TXT) {
          const txt = parseTxt(record.data);
          const existing = services.get(record.name) ?? { name: record.name };
          services.set(record.name, { ...existing, deviceId: txt.id });
        }

        if (record.type === TYPE_A && record.data.length === 4) {
          addresses.set(record.name, Array.from(record.data).join('.'));
        }
      }
    });

    // Bound to the mDNS port itself, with the address shared: hubs answer to the group, not to
    // whoever asked, so a socket on an ephemeral port hears nothing.
    socket.bind(MDNS_PORT, () => {
      socket.setBroadcast(true);
      try {
        socket.addMembership(MDNS_ADDRESS);
      } catch {
        // Already a member, or an interface that will not have it; the query still goes out.
      }

      const header = Buffer.alloc(12);
      header.writeUInt16BE(0, 0);
      header.writeUInt16BE(0, 2);
      header.writeUInt16BE(1, 4);

      // Ask for the service's pointers; hubs answer with the SRV, TXT and address records too.
      // The top bit of the class asks for the answer to come back to this socket rather than to
      // the multicast group, which is the only way to hear it without binding port 5353 - where
      // the operating system's own responder already sits.
      const question = Buffer.concat([encodeName(SERVICE), Buffer.from([0x00, TYPE_PTR, 0x00, 0x01])]);
      socket.send(Buffer.concat([header, question]), MDNS_PORT, MDNS_ADDRESS);

      setTimeout(finish, timeoutMs).unref?.();
    });
  });
}
