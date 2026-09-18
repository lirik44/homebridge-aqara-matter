/**
 * Aqara devices as HomeKit sees them.
 *
 * What a device becomes follows from what the catalogue says it can do, never from its model
 * string: anything with `OnOff` and `CurrentLevel` is a dimmable light, anything with
 * `ContactSensorState` is a door sensor. A model nobody has tried still arrives as the right
 * accessory, because it is described rather than special-cased.
 */

/** A battery below this is worth warning about in HomeKit. */
const LOW_BATTERY_PERCENT = 20;

/**
 * Builds the HomeKit services for one device, and keeps them in step with it.
 */
export class HomeKitAccessory {
  /**
   * @param {object} device The device object, shared with the Matter side.
   * @param {object} accessory The Homebridge platform accessory to furnish.
   * @param {object} api The Homebridge API.
   * @param {object} logger Where to say what happened.
   * @param {object} [config] What the user asked for.
   */
  constructor(device, accessory, api, logger, config = {}) {
    this.device = device;
    this.accessory = accessory;
    this.api = api;
    this.logger = logger;
    this.config = config;

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pushers = [];
  }

  /**
   * @returns {boolean} Whether this device has anything HomeKit can show.
   */
  build() {
    this.information();

    const built = this.light() || this.outlet() || this.sensors() || this.contact() || this.button();

    if (built) {
      this.battery();
      // Whatever changes the device - a controller, the hub, someone walking through a door -
      // HomeKit is told at once rather than when it next asks.
      this.device.on('changed', () => this.push());
    }

    return built;
  }

  /**
   * @returns {void}
   */
  information() {
    const service = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);

    service
      .setCharacteristic(this.Characteristic.Manufacturer, this.device.manufacturer)
      .setCharacteristic(this.Characteristic.Model, this.device.model)
      .setCharacteristic(this.Characteristic.SerialNumber, this.device.deviceId);
  }


  /*----------========== WHAT A DEVICE BECOMES ==========----------*/

  /**
   * @returns {boolean} Whether this device is a light, and was built as one.
   */
  light() {
    if (!this.device.can('OnOff') || !this.device.can('CurrentLevel')) {
      return false;
    }

    const service = this.service(this.Service.Lightbulb);

    this.bind(service, this.Characteristic.On, 'OnOff', {
      read: value => value === true,
      write: value => !!value,
    });

    this.bind(service, this.Characteristic.Brightness, 'CurrentLevel', {
      read: value => Math.round(Number(value) || 0),
      write: value => Number(value),
    });

    if (this.device.can('ColorTemperature')) {
      const spec = this.device.spec('ColorTemperature');

      // Aqara counts colour temperature in mireds, which is what HomeKit counts in too.
      this.bind(service, this.Characteristic.ColorTemperature, 'ColorTemperature', {
        read: value => Math.round(Number(value) || spec.min_value),
        write: value => Math.round(Number(value)),
        props: { minValue: Math.round(spec.min_value), maxValue: Math.round(spec.max_value) },
      });

      this.adaptiveLighting(service);
    }

    return true;
  }

  /**
   * @returns {boolean} Whether this device is a plain switch, and was built as one.
   */
  outlet() {
    if (!this.device.can('OnOff')) {
      return false;
    }

    const service = this.service(this.Service.Switch);
    this.bind(service, this.Characteristic.On, 'OnOff', {
      read: value => value === true,
      write: value => !!value,
    });

    return true;
  }

  /**
   * @returns {boolean} Whether this device measures anything HomeKit shows.
   */
  sensors() {
    let built = false;

    if (this.device.can('CurrentTemperature')) {
      const service = this.service(this.Service.TemperatureSensor);
      this.bind(service, this.Characteristic.CurrentTemperature, 'CurrentTemperature', {
        read: value => Number(value) || 0,
      });
      built = true;
    }

    if (this.device.can('CurrentHumidity')) {
      const service = this.service(this.Service.HumiditySensor);
      this.bind(service, this.Characteristic.CurrentRelativeHumidity, 'CurrentHumidity', {
        read: value => Math.round(Number(value) || 0),
      });
      built = true;
    }

    // Pressure is measured by these sensors and has no HomeKit service at all; it is left to the
    // Matter side, where it does.
    return built;
  }

  /**
   * @returns {boolean} Whether this device is a contact sensor, and was built as one.
   */
  contact() {
    if (!this.device.can('ContactSensorState')) {
      return false;
    }

    const service = this.service(this.Service.ContactSensor);
    this.bind(service, this.Characteristic.ContactSensorState, 'ContactSensorState', {
      // Aqara reports true for an open door; HomeKit calls that "not detected".
      read: value => (value
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED),
    });

    return true;
  }

  /**
   * @returns {boolean} Whether this device is a button, and was built as one.
   */
  button() {
    if (!this.device.can('ButtonEvent')) {
      return false;
    }

    const service = this.service(this.Service.StatelessProgrammableSwitch);
    const characteristic = service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent);

    // A press is an event, not a state: nothing to read back, and nothing to push on a timer.
    this.device.on('changed', (code, value) => {
      if (code !== 'ButtonEvent') {
        return;
      }

      // Single, double and long, in that order, which is how both sides number them.
      const press = Number(value);
      if (press >= 0 && press <= 2) {
        characteristic.updateValue(press);
      }
    });

    return true;
  }

  /**
   * @returns {void}
   */
  battery() {
    if (!this.device.can('StateOfLowBat')) {
      return;
    }

    const service = this.service(this.Service.Battery);
    this.bind(service, this.Characteristic.StatusLowBattery, 'StateOfLowBat', {
      read: value => (Number(value) === 1
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL),
    });

    if (this.device.can('BatteryPercentage')) {
      this.bind(service, this.Characteristic.BatteryLevel, 'BatteryPercentage', {
        read: value => Math.max(0, Math.min(100, Math.round(Number(value) || 0))),
      });
    } else {
      // Without a percentage, HomeKit still wants one; the low-battery flag is all there is.
      service.getCharacteristic(this.Characteristic.BatteryLevel)
        .onGet(() => (Number(this.device.get('StateOfLowBat')) === 1 ? LOW_BATTERY_PERCENT : 100));
    }
  }

  /**
   * Lets HomeKit move a lamp's colour temperature through the day on its own.
   *
   * It asks nothing of the lamp beyond a dimmer and a colour temperature, which is exactly what
   * makes a lamp eligible.
   *
   * @param {object} service The lightbulb service.
   * @returns {void}
   */
  adaptiveLighting(service) {
    if (this.config.adaptiveLighting === false) {
      return;
    }

    const Controller = this.api.hap.AdaptiveLightingController;
    if (!Controller || typeof this.accessory.configureController !== 'function') {
      return;
    }

    try {
      this.accessory.configureController(new Controller(service));
      this.logger.debug(`Adaptive lighting enabled for ${this.device.name}`);
    } catch (error) {
      this.logger.warn(`Could not enable adaptive lighting for ${this.device.name}: ${error.message ?? error}`);
    }
  }


  /*----------========== PLUMBING ==========----------*/

  /**
   * @param {object} type A HAP service type.
   * @returns {object} That service on this accessory, added if it is not there yet.
   */
  service(type) {
    const existing = this.accessory.getService(type);
    if (existing) {
      return existing;
    }

    const added = this.accessory.addService(type, this.device.name);
    added.addOptionalCharacteristic?.(this.Characteristic.ConfiguredName);
    added.setCharacteristic?.(this.Characteristic.ConfiguredName, this.device.name);
    return added;
  }

  /**
   * Wires one characteristic to one trait, in both directions.
   *
   * @param {object} service The service it belongs to.
   * @param {object} type The characteristic.
   * @param {string} code The trait code behind it.
   * @param {object} how How to read it, and how to write it if it can be written.
   * @returns {void}
   */
  bind(service, type, code, how) {
    const characteristic = service.getCharacteristic(type);

    if (how.props) {
      characteristic.setProps?.(how.props);
    }

    const read = () => how.read(this.device.get(code));
    characteristic.onGet(read);

    if (how.write) {
      characteristic.onSet(async (value) => {
        await this.device.set(code, how.write(value));
      });
    }

    // Remembered so a change can be pushed rather than waited for.
    this.pushers.push(() => {
      const value = read();
      if (value !== undefined && value !== null) {
        characteristic.updateValue(value);
      }
    });
  }

  /**
   * @returns {void}
   */
  push() {
    for (const pusher of this.pushers) {
      try {
        pusher();
      } catch (error) {
        this.logger.debug(`Could not tell HomeKit about ${this.device.name}: ${error.message ?? error}`);
      }
    }
  }
}
