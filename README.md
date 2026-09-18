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
| `src/protocol/tunnel.js` | The tunnel and the JSON session inside it: handshake, check-in, read, write, keepalive, and the reports a hub pushes. Runs against real hardware up to the check-in. |
| `src/protocol/discovery.js` | Finding hubs on the network. The port a hub advertises changes every time it reboots, so it is asked for rather than remembered. |
| `src/cloud/client.js` | The two things the cloud is for: signing in, and listing what the account owns. Works against live accounts. |
| `src/catalogue.js` | What each of some 380 models can do, read from the catalogue the Python project assembled - not rewritten. |
| `src/device.js` | One device object per device, shared by both ecosystems, so neither has its own idea of what a lamp is doing. |
| `src/homekit.js` | What a device becomes in HomeKit, decided by what it can do rather than by its model: lights (with adaptive lighting), contact sensors, thermometers, buttons. |
| `src/matter.js` | The same devices over Matter, with the two guards that keep the ecosystems still - ignore a command asking for what the device already does, and ignore one that followed this plugin's own report. |

`npm test` runs it all, including a fake hub that speaks the protocol, with no dependencies beyond
Node itself.

## What is not done

The hub has to accept the session. Both hubs tested so far complete the handshake and then ignore
the check-in, which is what a hub does when local control is switched off - the protocol has no
reply that says so. The Python original behaves identically against the same hardware, so this is
not a difference between the two implementations.
