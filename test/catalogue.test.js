import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { capabilities, identity, size } from '../src/catalogue.js';
import { AqaraDevice } from '../src/device.js';

describe('the catalogue', () => {
  it('came along with the plugin', () => {
    // Without it every device would be an unknown one; a few hundred models is the shipped size.
    assert.ok(size() > 300, `only ${size()} models found`);
  });

  it('knows a lamp by what it can do rather than by its name', () => {
    const lamp = capabilities('lumi.light.agl004');

    assert.equal(lamp.get('OnOff').path, '2.132.32920');
    assert.equal(lamp.get('CurrentLevel').spec.unit, '%');
    // Colour temperature is already in the mireds HomeKit counts in, 153 to 370.
    assert.equal(lamp.get('ColorTemperature').spec.min_value, 153);
    assert.equal(lamp.get('ColorTemperature').spec.max_value, 370);
  });

  it('knows a sensor, a contact and a button', () => {
    assert.ok(capabilities('lumi.sensor_ht.agl02').has('CurrentTemperature'));
    assert.ok(capabilities('lumi.sensor_ht.agl02').has('CurrentHumidity'));
    assert.ok(capabilities('lumi.sensor_magnet.aq2').has('ContactSensorState'));
    assert.ok(capabilities('lumi.sensor_switch.v2').has('ButtonEvent'));
  });

  it('gives a device a name when the user has not', () => {
    assert.equal(identity('lumi.light.acn132').name, 'LED Strip T1');
    assert.equal(identity('lumi.no.such.model').name, 'lumi.no.such.model');
  });
});

describe('a device', () => {
  const hub = {
    written: [],
    async write(deviceId, values) {
      this.written.push({ deviceId, values });
    },
  };

  function lamp() {
    hub.written = [];
    return new AqaraDevice({ deviceId: 'lumi.1', model: 'lumi.light.agl004', name: 'Торшер', hub });
  }

  it('knows what it can do from its model alone', () => {
    const device = lamp();

    assert.equal(device.can('OnOff'), true);
    assert.equal(device.can('ColorTemperature'), true);
    assert.equal(device.can('ContactSensorState'), false);
  });

  it('writes to the path the trait lives at, not to its name', async () => {
    const device = lamp();
    await device.set('CurrentLevel', 60);

    assert.deepEqual(hub.written, [{ deviceId: 'lumi.1', values: { '2.133.32923': 60 } }]);
    assert.equal(device.get('CurrentLevel'), 60, 'and shows it at once, rather than waiting to be told');
  });

  it('keeps a value within what the device accepts', async () => {
    const device = lamp();
    await device.set('ColorTemperature', 1000);

    assert.equal(hub.written[0].values['2.134.32927'], 370);
  });

  it('refuses what cannot be written', async () => {
    const sensor = new AqaraDevice({ deviceId: 'lumi.2', model: 'lumi.sensor_ht.agl02', hub });

    assert.equal(await sensor.set('CurrentTemperature', 20), false);
    assert.equal(await sensor.set('Nonsense', 1), false);
  });

  it('turns a report into trait codes, and says what changed', () => {
    const device = lamp();
    const changes = [];
    device.on('changed', (code, value) => changes.push([code, value]));

    const changed = device.report({ '2.132.32920': true, '2.133.32923': 40 });
    assert.deepEqual(changed, ['OnOff', 'CurrentLevel']);
    assert.deepEqual(changes, [['OnOff', true], ['CurrentLevel', 40]]);

    // The same values again are not news, and nobody is told twice.
    assert.deepEqual(device.report({ '2.132.32920': true }), []);
    assert.equal(changes.length, 2);
  });

  it('ignores a path it has no trait for', () => {
    const device = lamp();
    assert.deepEqual(device.report({ '9.9.9': 1 }), []);
  });
});
