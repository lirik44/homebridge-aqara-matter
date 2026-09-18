import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AqaraDevice } from '../src/device.js';
import { HomeKitAccessory } from '../src/homekit.js';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Enough of HAP to build services and see what was bound to them. */
function fakeApi() {
  const Characteristic = new Proxy({}, {
    get: (_t, name) => {
      if (name === 'ContactSensorState') return { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1, toString: () => 'ContactSensorState' };
      if (name === 'StatusLowBattery') return { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1, toString: () => 'StatusLowBattery' };
      return name;
    },
  });

  return {
    hap: {
      Service: new Proxy({}, { get: (_t, name) => name }),
      Characteristic,
      AdaptiveLightingController: class AdaptiveLightingController {
        constructor(service) { this.service = service; }
      },
    },
  };
}

function fakeAccessory() {
  const services = new Map();
  const controllers = [];

  const makeService = (type) => {
    const characteristics = new Map();
    return {
      type,
      characteristics,
      getCharacteristic(name) {
        const key = String(name);
        if (!characteristics.has(key)) {
          characteristics.set(key, {
            name: key, value: undefined, props: null,
            onGet(fn) { this.get = fn; return this; },
            onSet(fn) { this.set = fn; return this; },
            setProps(props) { this.props = props; return this; },
            updateValue(value) { this.value = value; return this; },
          });
        }
        return characteristics.get(key);
      },
      setCharacteristic(name, value) { this.getCharacteristic(name).updateValue(value); return this; },
      addOptionalCharacteristic() {},
    };
  };

  return {
    services,
    controllers,
    getService: type => services.get(String(type)),
    addService(type) {
      const service = makeService(String(type));
      services.set(String(type), service);
      return service;
    },
    configureController(controller) { controllers.push(controller); },
  };
}

function build(model, name, config) {
  const hub = { written: [], async write(deviceId, values) { this.written.push(values); } };
  const device = new AqaraDevice({ deviceId: 'lumi.x', model, name, hub });
  const accessory = fakeAccessory();
  const built = new HomeKitAccessory(device, accessory, fakeApi(), silent, config).build();
  return { device, accessory, hub, built };
}

describe('what a device becomes in HomeKit', () => {
  it('a lamp with a dimmer and a colour temperature is a lightbulb', () => {
    const { accessory, built } = build('lumi.light.agl004', 'Торшер');
    const bulb = accessory.getService('Lightbulb');

    assert.equal(built, true);
    assert.ok(bulb);
    assert.ok(bulb.characteristics.has('On'));
    assert.ok(bulb.characteristics.has('Brightness'));
    assert.deepEqual(bulb.getCharacteristic('ColorTemperature').props, { minValue: 153, maxValue: 370 });
  });

  it('a door sensor is a contact sensor, the right way round', () => {
    const { device, accessory, built } = build('lumi.sensor_magnet.aq2', 'Входная дверь');
    const contact = accessory.getService('ContactSensor').getCharacteristic('ContactSensorState');

    assert.equal(built, true);
    device.report({ '2.155.32990': true });
    // Aqara says true for an open door; HomeKit calls that "not detected".
    assert.equal(contact.get(), 1);

    device.report({ '2.155.32990': false });
    assert.equal(contact.get(), 0);
  });

  it('a climate sensor is a thermometer and a hygrometer', () => {
    const { device, accessory } = build('lumi.sensor_ht.agl02', 'Квартира');

    device.report({ '2.143.32952': 21.5, '3.144.32953': 48 });
    assert.equal(accessory.getService('TemperatureSensor').getCharacteristic('CurrentTemperature').get(), 21.5);
    assert.equal(accessory.getService('HumiditySensor').getCharacteristic('CurrentRelativeHumidity').get(), 48);
  });

  it('a wireless switch is a button, and each press is an event', () => {
    const { device, accessory } = build('lumi.sensor_switch.v2', 'Вход Кнопка');
    const event = accessory.getService('StatelessProgrammableSwitch').getCharacteristic('ProgrammableSwitchEvent');

    device.report({ '2.135.32928': 1 });
    assert.equal(event.value, 1, 'a double press');

    device.report({ '2.135.32928': 2 });
    assert.equal(event.value, 2, 'a long one');
  });
});

describe('driving a device from HomeKit', () => {
  it('sends what was asked for to the trait behind the characteristic', async () => {
    const { accessory, hub } = build('lumi.light.agl004', 'Торшер');
    const bulb = accessory.getService('Lightbulb');

    await bulb.getCharacteristic('On').set(true);
    await bulb.getCharacteristic('Brightness').set(40);
    await bulb.getCharacteristic('ColorTemperature').set(300);

    assert.deepEqual(hub.written, [{ '2.132.32920': true }, { '2.133.32923': 40 }, { '2.134.32927': 300 }]);
  });

  it('tells HomeKit at once when the hub reports a change', () => {
    const { device, accessory } = build('lumi.light.agl004', 'Торшер');
    const brightness = accessory.getService('Lightbulb').getCharacteristic('Brightness');

    device.report({ '2.133.32923': 70 });
    assert.equal(brightness.value, 70, 'pushed, rather than waiting to be asked');
  });
});

describe('adaptive lighting', () => {
  it('is offered to a lamp that has a dimmer and a colour temperature', () => {
    const { accessory } = build('lumi.light.agl004', 'Торшер');
    assert.equal(accessory.controllers.length, 1);
  });

  it('is left out where the config says so', () => {
    const { accessory } = build('lumi.light.agl004', 'Торшер', { adaptiveLighting: false });
    assert.equal(accessory.controllers.length, 0);
  });

  it('is not offered to a lamp with no colour temperature', () => {
    const { accessory } = build('lumi.sensor_ht.agl02', 'Квартира');
    assert.equal(accessory.controllers.length, 0);
  });
});
