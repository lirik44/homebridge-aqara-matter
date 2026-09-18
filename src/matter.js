/**
 * The same devices over Matter, alongside HomeKit rather than instead of it.
 *
 * Both halves drive the same device object, so neither ecosystem has its own idea of what a lamp
 * is doing. Two rules keep them still, and both were learned the hard way in this plugin's
 * siblings:
 *
 *   - A command asking for what the device is already doing is ignored. An echo always matches the
 *     device; a person's command does not.
 *   - So is a command arriving on the heels of this plugin's own report. Reporting one attribute
 *     makes a controller work out the others and send them back, and those arrive looking exactly
 *     like somebody pressing something.
 */

/** How long after a report anything arriving is taken for the controller keeping itself in step. */
const SETTLE_MS = 4000;

/** Matter levels run 1..254 where Aqara counts percent. */
const MATTER_LEVEL_MAX = 254;

/** What the Matter spec allows for a bridged device's name and serial number. */
const NAME_MAX = 32;

/**
 * One device, published over Matter.
 */
export class MatterTwin {
  /**
   * @param {object} device The device object, shared with the HomeKit side.
   * @param {object} api The Homebridge API.
   * @param {object} logger Where to say what happened.
   */
  constructor(device, api, logger) {
    this.device = device;
    this.api = api;
    this.logger = logger;
    this.uuid = null;
    this.reported = new Map();
    this.reportedAt = new Map();
  }

  /**
   * @param {object} api The Homebridge API.
   * @returns {boolean} Whether this Homebridge can publish over Matter at all.
   */
  static isAvailable(api) {
    return !!(api?.isMatterAvailable?.() && api?.isMatterEnabled?.() && api?.matter?.registerPlatformAccessories);
  }

  /**
   * @returns {boolean} Whether there is anything a Matter controller would render.
   */
  supported() {
    return !!this.deviceType();
  }

  /**
   * @returns {object|undefined} What to publish this device as. A device whose type no controller
   *   renders is not published at all: an accessory that cannot be drawn is one that does not
   *   appear, and it only confuses the app it appears in.
   */
  deviceType() {
    const types = this.api.matter?.deviceTypes ?? {};
    const device = this.device;

    if (device.can('OnOff') && device.can('CurrentLevel')) {
      return device.can('ColorTemperature') ? types.ColorTemperatureLight : types.DimmableLight;
    }
    if (device.can('OnOff')) {
      return types.OnOffLight;
    }
    if (device.can('ContactSensorState')) {
      return types.ContactSensor;
    }
    if (device.can('CurrentTemperature')) {
      return types.TemperatureSensor;
    }
    if (device.can('CurrentHumidity')) {
      return types.HumiditySensor;
    }

    return undefined;
  }

  /**
   * @returns {object} The cluster state as it stands.
   */
  state() {
    const device = this.device;
    const state = {};

    if (device.can('OnOff')) {
      state.onOff = { onOff: device.get('OnOff') === true };
    }

    if (device.can('CurrentLevel')) {
      state.levelControl = { currentLevel: this.toMatterLevel(device.get('CurrentLevel')) };
    }

    if (device.can('ColorTemperature')) {
      const spec = device.spec('ColorTemperature');
      state.colorControl = {
        colorTemperatureMireds: Math.round(Number(device.get('ColorTemperature')) || spec.min_value),
        colorTempPhysicalMinMireds: Math.round(spec.min_value),
        colorTempPhysicalMaxMireds: Math.round(spec.max_value),
        // Required of anything that reports a colour temperature at all, whether or not the lamp
        // couples the two; matter.js refuses the accessory without it.
        coupleColorTempToLevelMinMireds: Math.round(spec.min_value),
        colorMode: 2,
      };
    }

    if (device.can('ContactSensorState')) {
      // Aqara reports true for an open door; Matter's boolean state is true when the contact is
      // made, which is the other way round.
      state.booleanState = { stateValue: device.get('ContactSensorState') !== true };
    }

    if (device.can('CurrentTemperature')) {
      state.temperatureMeasurement = { measuredValue: Math.round((Number(device.get('CurrentTemperature')) || 0) * 100) };
    }

    if (device.can('CurrentHumidity')) {
      state.relativeHumidityMeasurement = { measuredValue: Math.round((Number(device.get('CurrentHumidity')) || 0) * 100) };
    }

    return state;
  }

  /**
   * @returns {object} The handlers a controller's commands arrive at.
   */
  handlers() {
    const handlers = {};
    const device = this.device;

    if (device.can('OnOff')) {
      handlers.onOff = {
        on: async () => this.command('onOff', 'OnOff', true),
        off: async () => this.command('onOff', 'OnOff', false),
      };
    }

    if (device.can('CurrentLevel')) {
      const setLevel = async request => this.command('levelControl', 'CurrentLevel', this.fromMatterLevel(request?.level));
      handlers.levelControl = { moveToLevel: setLevel, moveToLevelWithOnOff: setLevel };
    }

    if (device.can('ColorTemperature')) {
      handlers.colorControl = {
        moveToColorTemperatureLogic: async request => this.command('colorControl', 'ColorTemperature', Math.round(Number(request?.colorTemperatureMireds))),
      };
    }

    return handlers;
  }

  /**
   * @param {string} uuid The accessory UUID to publish under.
   * @returns {object} The accessory descriptor Homebridge registers.
   */
  descriptor(uuid) {
    this.uuid = uuid;

    const state = this.state();
    for (const [cluster, attributes] of Object.entries(state)) {
      this.remember(cluster, attributes);
    }

    return {
      UUID: uuid,
      displayName: String(this.device.name).slice(0, NAME_MAX),
      deviceType: this.deviceType(),
      manufacturer: this.device.manufacturer,
      model: this.device.model,
      serialNumber: String(this.device.deviceId).slice(0, NAME_MAX),
      clusters: state,
      handlers: this.handlers(),
      context: { deviceId: this.device.deviceId },
    };
  }

  /**
   * Reports whatever has changed since the last time.
   *
   * @returns {void}
   */
  report() {
    const matter = this.api.matter;
    if (!this.uuid || typeof matter?.updateAccessoryState !== 'function') {
      return;
    }

    for (const [cluster, attributes] of Object.entries(this.state())) {
      const changed = {};
      const last = this.reported.get(cluster) ?? {};

      for (const [key, value] of Object.entries(attributes)) {
        if (last[key] !== value) {
          changed[key] = value;
        }
      }

      if (Object.keys(changed).length === 0) {
        continue;
      }

      this.remember(cluster, attributes);
      Promise.resolve(matter.updateAccessoryState(this.uuid, cluster, changed))
        .catch(error => this.logger.warn(`Could not report ${cluster} of ${this.device.name}: ${error.message ?? error}`));
      this.logger.debug(`Matter: ${this.device.name} ${cluster} = ${JSON.stringify(changed)}`);
    }
  }


  /*----------========== WHAT TO OBEY ==========----------*/

  /**
   * @param {string} cluster Which cluster the command arrived on.
   * @param {string} code The trait it asks for.
   * @param {*} value What it asks for.
   * @returns {Promise<object>} Whether it was done.
   */
  async command(cluster, code, value) {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return { success: false };
    }

    if (this.justReported(cluster)) {
      this.logger.debug(`Matter: ignoring ${code} on ${this.device.name}, it followed this plugin's own report`);
      return { success: true };
    }

    if (this.device.get(code) === value) {
      return { success: true };
    }

    return { success: await this.device.set(code, value) };
  }

  /**
   * @param {string} cluster A cluster.
   * @returns {boolean} Whether this plugin reported it a moment ago.
   */
  justReported(cluster) {
    return Date.now() - (this.reportedAt.get(cluster) ?? 0) < SETTLE_MS;
  }

  /**
   * @param {string} cluster A cluster.
   * @param {object} attributes What was reported for it.
   * @returns {void}
   */
  remember(cluster, attributes) {
    this.reported.set(cluster, { ...(this.reported.get(cluster) ?? {}), ...attributes });
    this.reportedAt.set(cluster, Date.now());
  }


  /*----------========== SCALES ==========----------*/

  /**
   * @param {number} percent 0..100.
   * @returns {number} 1..254. Level zero means off in Matter, so the dimmest lit value is one.
   */
  toMatterLevel(percent) {
    const level = Math.round((Number(percent) || 0) * (MATTER_LEVEL_MAX / 100));
    return Math.max(1, Math.min(MATTER_LEVEL_MAX, level));
  }

  /**
   * @param {number} level 1..254.
   * @returns {number} 0..100.
   */
  fromMatterLevel(level) {
    const percent = Math.round((Number(level) || 0) / (MATTER_LEVEL_MAX / 100));
    return Math.max(0, Math.min(100, percent));
  }
}
