# homebridge-aqara-matter

Aqara devices in Apple HomeKit and, alongside it, in Matter - driven locally over the
reverse-engineered LANLink protocol, with no cloud round-trip in steady state.

**This is work in progress.** The protocol core is ported and tested; the hub connection, the
HomeKit accessories and the Matter twins follow.

## Where this comes from

The protocol work is not mine. It was reverse-engineered by the
[Aqara LANLink integration for Home Assistant](https://github.com/lirik44/homebridge-aqara-matter),
whose Python source is kept in this repository under `custom_components/` as the reference this
port is checked against - including its device catalogue of some 380 models, which is read as-is
rather than rewritten.

## What is done

| | |
| --- | --- |
| `src/protocol/crypto.js` | Device-key derivation, AES-128-CBC with the key as its own IV, CRC-16, and the wire frame codec. Checked against the captured vectors from the original. |
| `src/protocol/ecc.js` | The handshake's key exchange over GF(2^163) - a curve neither Node nor OpenSSL will do, so the field arithmetic is here on BigInt. Checked byte-for-byte against the Python original. |

`npm test` runs it all, with no dependencies beyond Node itself.
