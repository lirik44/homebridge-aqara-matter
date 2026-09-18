import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { AqaraTunnel } from '../src/protocol/tunnel.js';
import { AqaraDevice } from '../src/device.js';
import { FakeHub } from './helpers/fake-hub.js';

/** A tunnel to a hub that behaves, torn down with the test. */
async function connected(options) {
  const hub = new FakeHub(options);
  const where = await hub.listen();
  const tunnel = new AqaraTunnel(where);
  tunnel.on('error', () => {});

  await tunnel.connect();
  return { hub, tunnel, where };
}

describe('talking to a hub', () => {
  it('runs the handshake and opens a session', async () => {
    const { hub, tunnel } = await connected();

    const answer = await tunnel.checkin('user-1', 'token-1');
    assert.equal(answer.data.code, 0, 'the hub accepted the session');
    assert.equal(answer.cmd, 'checkin_done');

    tunnel.close();
    await hub.close();
  });

  it('refuses a session without a token, as the hub does', async () => {
    const { hub, tunnel } = await connected();

    const answer = await tunnel.checkin('user-1', '');
    assert.equal(answer.data.code, 2);

    tunnel.close();
    await hub.close();
  });

  it('writes what a device asks it to', async () => {
    const { hub, tunnel } = await connected();
    await tunnel.checkin('user-1', 'token-1');

    await tunnel.write({ '2.132.32920': true }, 'lumi.lamp');
    assert.deepEqual(hub.written, [{ did: 'lumi.lamp', attrs: { '2.132.32920': true } }]);

    tunnel.close();
    await hub.close();
  });

  it('hears a report and passes it on', async () => {
    const { hub, tunnel } = await connected();
    await tunnel.checkin('user-1', 'token-1');

    const heard = new Promise(resolve => tunnel.on('message', resolve));
    hub.pushReport('lumi.lamp', { '2.133.32923': 42 });

    const message = await heard;
    assert.equal(message.cmd, 'report');
    assert.deepEqual(message.data.attrs, { '2.133.32923': 42 });

    tunnel.close();
    await hub.close();
  });

  it('gives up on a hub that completes the handshake and then says nothing', async () => {
    // Which is exactly what a hub with local control switched off does - there is no reply that
    // says so, and this is the shape of that silence.
    const { hub, tunnel } = await connected({ acceptSession: false });

    await assert.rejects(() => tunnel.checkin('user-1', 'token-1'), /did not answer/);

    tunnel.close();
    await hub.close();
  });
});

describe('a device driven through a hub', () => {
  it('turns a HomeKit-side change into a write, and a report back into state', async () => {
    const { hub, tunnel } = await connected();
    await tunnel.checkin('user-1', 'token-1');

    const device = new AqaraDevice({
      deviceId: 'lumi.lamp',
      model: 'lumi.light.agl004',
      name: 'Торшер',
      hub: { write: (deviceId, values) => tunnel.write(values, deviceId) },
    });

    tunnel.on('message', (message) => {
      if (message.cmd === 'report' && message.data.did === device.deviceId) {
        device.report(message.data.attrs);
      }
    });

    await device.set('CurrentLevel', 65);
    assert.deepEqual(hub.written.at(-1), { did: 'lumi.lamp', attrs: { '2.133.32923': 65 } });

    const changed = new Promise(resolve => device.once('changed', (code, value) => resolve([code, value])));
    hub.pushReport('lumi.lamp', { '2.132.32920': true });
    assert.deepEqual(await changed, ['OnOff', true]);

    tunnel.close();
    await hub.close();
  });
});
