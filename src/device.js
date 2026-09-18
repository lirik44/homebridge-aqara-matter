import { EventEmitter } from 'node:events';

import { capabilities, identity } from './catalogue.js';

/**
 * One Aqara device, as both halves of this plugin see it.
 *
 * There is exactly one of these per physical device, and everything - HomeKit, Matter, the reports
 * pushed by the hub - reads and writes through it. That is deliberate: two ecosystems each keeping
 * their own idea of what a lamp is doing end up arguing, and the argument is visible to whoever
 * lives in the house.
 *
 * State is kept by trait code rather than by wire path, because a code is what everything else
 * cares about: `OnOff`, `CurrentLevel`, `CurrentTemperature`.
 */
export class AqaraDevice extends EventEmitter {
  /**
   * @param {object} options What the cloud and the catalogue say about it.
   * @param {string} options.deviceId The device id, as the hub knows it.
   * @param {string} options.model Its model string.
   * @param {string} [options.name] What the user called it.
   * @param {object} [options.hub] Who to ask to read and write it.
   */
  constructor({ deviceId, model, name, hub }) {
    super();
    this.deviceId = deviceId;
    this.model = model;
    this.hub = hub ?? null;

    const known = identity(model);
    this.name = name || known.name;
    this.manufacturer = known.manufacturer;
    this.capabilities = capabilities(model);

    /** The last value seen for each trait code. */
    this.state = new Map();
    /** Reachability: a device the hub has not mentioned yet is not known to be anything. */
    this.reachable = true;
  }

  /**
   * @param {string} code A trait code.
   * @returns {boolean} Whether this device has it at all.
   */
  can(code) {
    return this.capabilities.has(code);
  }

  /**
   * @param {string} code A trait code.
   * @returns {*} Its last known value, or undefined when nothing has said yet.
   */
  get(code) {
    return this.state.get(code);
  }

  /**
   * @param {string} code A trait code.
   * @returns {object|undefined} What the catalogue says about it: type, range, unit, whether it
   *   can be written.
   */
  spec(code) {
    return this.capabilities.get(code)?.spec;
  }

  /**
   * Asks the device to change, and remembers the answer.
   *
   * @param {string} code A trait code.
   * @param {*} value What to set it to.
   * @returns {Promise<boolean>} Whether the hub accepted it.
   */
  async set(code, value) {
    const trait = this.capabilities.get(code);

    if (!trait) {
      return false;
    }
    // Writable is stated, never assumed: a sensor's reading carries no such flag, and asking a
    // thermometer to be twenty degrees is not a request the hub should be troubled with.
    if (trait.spec.writable !== true) {
      return false;
    }
    if (!this.hub) {
      return false;
    }

    const clamped = this.clamp(trait.spec, value);
    await this.hub.write(this.deviceId, { [trait.path]: clamped });

    // Remembered without waiting for the report: the hub will confirm, and until it does the
    // controllers should show what was asked for rather than what was true a moment ago.
    this.record(code, clamped);
    return true;
  }

  /**
   * Takes in what the hub says about this device.
   *
   * @param {Record<string, *>} values Values by wire path, as a report carries them.
   * @returns {string[]} The trait codes that changed.
   */
  report(values) {
    const changed = [];

    for (const [path, value] of Object.entries(values ?? {})) {
      const code = this.codeFor(path);
      if (code && this.record(code, value)) {
        changed.push(code);
      }
    }

    return changed;
  }

  /**
   * @param {string} path A wire path.
   * @returns {string|undefined} The trait code it belongs to.
   */
  codeFor(path) {
    for (const [code, trait] of this.capabilities) {
      if (trait.path === path) {
        return code;
      }
    }

    return undefined;
  }

  /**
   * @param {string} code A trait code.
   * @param {*} value Its new value.
   * @returns {boolean} Whether this is news.
   */
  record(code, value) {
    if (this.state.get(code) === value) {
      return false;
    }

    this.state.set(code, value);
    // One announcement, heard by every ecosystem this device is published to.
    this.emit('changed', code, value);
    return true;
  }

  /**
   * @param {object} spec What the catalogue says a trait accepts.
   * @param {*} value What someone asked for.
   * @returns {*} It, within what the device will take.
   */
  clamp(spec, value) {
    if (typeof value !== 'number') {
      return value;
    }

    const low = typeof spec.min_value === 'number' ? spec.min_value : -Infinity;
    const high = typeof spec.max_value === 'number' ? spec.max_value : Infinity;
    const within = Math.max(low, Math.min(high, value));

    return spec.data_type === 'int' || spec.data_type === 'enum' ? Math.round(within) : within;
  }
}
