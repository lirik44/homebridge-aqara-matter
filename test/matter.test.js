import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AqaraDevice } from '../src/device.js';
import { MatterTwin } from '../src/matter.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fakeApi() {
  const reported = [];
  return {
    reported,
    isMatterAvailable: () => true,
    isMatterEnabled: () => true,
    matter: {
      uuid: { generate: id => `uuid-${id}` },
      deviceTypes: {
        OnOffLight: 'OnOffLight', DimmableLight: 'DimmableLight', ColorTemperatureLight: 'ColorTemperatureLight',
        ContactSensor: 'ContactSensor', TemperatureSensor: 'TemperatureSensor', HumiditySensor: 'HumiditySensor',
      },
      registerPlatformAccessories: async () => {},
      updateAccessoryState: async (uuid, cluster, attributes) => reported.push({ cluster, attributes }),
    },
  };
}

function twinFor(model, name = 'Device') {
  const hub = { written: [], async write(deviceId, values) { this.written.push(values); } };
  const device = new AqaraDevice({ deviceId: 'lumi.x', model, name, hub });
  const api = fakeApi();
  const twin = new MatterTwin(device, api, silent);
  twin.descriptor('uuid-1');
  return { device, twin, api, hub };
}

/** A command out of nowhere, rather than one on the heels of a report. */
function settled(twin) {
  for (const cluster of twin.reportedAt.keys()) twin.reportedAt.set(cluster, Date.now() - 60000);
  return twin;
}

describe('what a device becomes over Matter', () => {
  it('is what it can do, not what it is called', () => {
    assert.equal(twinFor('lumi.light.agl004').twin.deviceType(), 'ColorTemperatureLight');
    assert.equal(twinFor('lumi.sensor_magnet.aq2').twin.deviceType(), 'ContactSensor');
    assert.equal(twinFor('lumi.sensor_ht.agl02').twin.deviceType(), 'TemperatureSensor');
  });

  it('is left unpublished when no controller would render it', () => {
    // A wireless button has no Matter device type any controller draws.
    assert.equal(twinFor('lumi.sensor_switch.v2').twin.supported(), false);
  });

  it('carries the attribute matter.js refuses a colour lamp without', () => {
    const { twin } = twinFor('lumi.light.agl004');
    assert.equal(twin.state().colorControl.coupleColorTempToLevelMinMireds, 153);
  });

  it('reports a door the way Matter words it', () => {
    const { device, twin } = twinFor('lumi.sensor_magnet.aq2');

    device.report({ '2.155.32990': true });
    assert.equal(twin.state().booleanState.stateValue, false, 'an open door is a contact not made');

    device.report({ '2.155.32990': false });
    assert.equal(twin.state().booleanState.stateValue, true);
  });

  it('reports temperature and humidity in the hundredths Matter counts in', () => {
    const { device, twin } = twinFor('lumi.sensor_ht.agl02');
    device.report({ '2.143.32952': 21.5, '3.144.32953': 48 });

    assert.equal(twin.state().temperatureMeasurement.measuredValue, 2150);
    assert.equal(twin.state().relativeHumidityMeasurement.measuredValue, 4800);
  });
});

describe('a command from a controller', () => {
  it('drives the lamp', async () => {
    const { twin, hub } = twinFor('lumi.light.agl004');
    const handlers = settled(twin).handlers();

    await handlers.onOff.on();
    await handlers.levelControl.moveToLevel({ level: 254 });
    await handlers.colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 300 });

    assert.deepEqual(hub.written, [{ '2.132.32920': true }, { '2.133.32923': 100 }, { '2.134.32927': 300 }]);
  });

  it('is ignored when it asks for what the lamp already does', async () => {
    const { device, twin, hub } = twinFor('lumi.light.agl004');
    device.report({ '2.132.32920': true });

    await settled(twin).handlers().onOff.on();
    assert.deepEqual(hub.written, []);
  });

  it('is ignored when it followed this plugin’s own report', async () => {
    // Reporting a level makes a controller work out the rest and send them back; obeyed, the two
    // ecosystems take turns telling each other what they were each just told.
    const { twin, hub } = twinFor('lumi.light.agl004');

    twin.report();
    await twin.handlers().levelControl.moveToLevel({ level: 200 });
    assert.deepEqual(hub.written, []);
  });
});

describe('reporting to the controllers', () => {
  it('sends what changed and nothing else', () => {
    const { device, twin, api } = twinFor('lumi.light.agl004');

    twin.report();
    assert.deepEqual(api.reported, [], 'nothing has changed since the accessory was built');

    device.report({ '2.133.32923': 50 });
    twin.report();

    assert.deepEqual(api.reported, [{ cluster: 'levelControl', attributes: { currentLevel: 127 } }]);
  });
});
