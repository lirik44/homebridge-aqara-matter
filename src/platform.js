import { AqaraCloud } from './cloud/client.js';
import { AqaraTunnel } from './protocol/tunnel.js';
import { discoverHubs } from './protocol/discovery.js';
import { AqaraDevice } from './device.js';
import { HomeKitAccessory } from './homekit.js';
import { MatterTwin } from './matter.js';
import { size as catalogueSize } from './catalogue.js';

export const PLUGIN_NAME = 'homebridge-aqara-matter';
export const PLATFORM_NAME = 'AqaraLocal';

/** How long to wait before trying a hub again after it has refused or dropped us. */
const RETRY_MS = 60000;

/** Cameras and infrared remotes are driven by Aqara's servers, not by the hub, and cannot be local. */
const NOT_LOCAL = [/\.camera\./, /\.remote\./, /\.ir\./];

/**
 * The plugin.
 *
 * The cloud is used twice - to exchange the account for a token, and to list what it owns - and
 * then left alone; everything after that is the local tunnel to the hub, which pushes state
 * without being asked.
 */
export class AqaraPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;

    this.accessories = new Map();
    this.cachedMatter = [];
    this.devices = new Map();
    this.twins = new Map();
    this.tunnel = null;
    this.retryTimer = null;

    if (!this.config.email || !this.config.password) {
      this.log.error('An Aqara account is required: set email and password in the plugin settings.');
      return;
    }

    this.api?.on?.('didFinishLaunching', () => this.start());
    this.api?.on?.('shutdown', () => this.stop());
  }

  /**
   * Homebridge hands back what it restored from its caches through these.
   */
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory) {
    this.cachedMatter.push(accessory);
  }

  /**
   * @returns {Promise<void>} Resolves once the hub is up, or a retry has been scheduled.
   */
  async start() {
    try {
      this.log.debug(`Catalogue holds ${catalogueSize()} models`);

      const cloud = new AqaraCloud({ region: this.config.region ?? 'EU' });
      const session = await cloud.login(this.config.email, this.config.password);
      this.log.info('Signed in to the Aqara cloud');

      const inventory = await cloud.listDevices(session.token);
      const hub = await this.findHub(inventory);

      if (!hub) {
        this.log.error('No Aqara hub found. Set the hub id in the plugin settings, or check that the hub is on this network.');
        return;
      }

      await this.connect(hub, session, inventory);
    } catch (error) {
      this.log.error(`Could not start: ${error.message ?? error}`);
      this.retryLater();
    }
  }

  /**
   * @param {Array<object>} inventory Everything on the account.
   * @returns {Promise<{deviceId: string, host: string, port: number}|null>} Which hub to talk to.
   */
  async findHub(inventory) {
    const configured = this.config.hub ?? {};

    // A hub found on the network carries the port it is listening on right now, which is the only
    // way to know it: the port changes every time a hub reboots.
    const onNetwork = await discoverHubs({ timeoutMs: 4000 }).catch(() => []);
    const wanted = configured.deviceId
      ?? inventory.find(device => /\.gateway\./.test(device.model ?? ''))?.did;

    const found = onNetwork.find(candidate => candidate.deviceId === wanted) ?? onNetwork[0];

    if (found) {
      return found;
    }
    if (configured.host && configured.port && wanted) {
      return { deviceId: wanted, host: configured.host, port: Number(configured.port) };
    }

    return null;
  }

  /**
   * @param {object} hub Where the hub is.
   * @param {object} session The cloud session.
   * @param {Array<object>} inventory Everything on the account.
   * @returns {Promise<void>} Resolves once the session is up.
   */
  async connect(hub, session, inventory) {
    this.log.info(`Connecting to hub ${hub.deviceId} at ${hub.host}:${hub.port}`);

    const tunnel = new AqaraTunnel(hub);
    this.tunnel = tunnel;

    tunnel.on('message', message => this.onMessage(message));
    tunnel.on('error', error => this.log.debug(`Hub: ${error.message}`));
    tunnel.on('close', () => {
      this.log.warn('The hub closed the connection; trying again shortly');
      this.retryLater();
    });

    await tunnel.connect();

    const answer = await tunnel.checkin(session.userId, session.token).catch(() => null);
    if (!answer) {
      // The hub accepts the connection, runs the handshake, and then ignores the session. Every
      // hub that does this has local control switched off - the protocol has no way to say so.
      this.log.error('The hub did not accept the session. Enable LAN control for the hub in the Aqara app, then restart.');
      this.retryLater();
      return;
    }

    this.log.info('The hub accepted the session; devices are now local');
    this.publish(hub, inventory);
  }

  /**
   * Builds an accessory for everything on the hub worth having.
   *
   * @param {object} hub The hub.
   * @param {Array<object>} inventory Everything on the account.
   * @returns {void}
   */
  publish(hub, inventory) {
    const mine = inventory.filter(entry => entry.parentDeviceId === hub.deviceId && entry.did && entry.model);
    const wanted = mine.filter(entry => !NOT_LOCAL.some(pattern => pattern.test(entry.model)));

    for (const entry of wanted) {
      const device = new AqaraDevice({
        deviceId: entry.did,
        model: entry.model,
        name: entry.deviceName,
        hub: { write: (deviceId, values) => this.tunnel.write(values, deviceId) },
      });

      if (device.capabilities.size === 0) {
        this.log.info(`Skipping ${device.name}: nothing known about ${device.model}`);
        continue;
      }

      this.devices.set(entry.did, device);
      this.addToHomeKit(device);
      this.addToMatter(device);
    }

    this.log.info(`Published ${this.devices.size} device(s) from the hub`);
  }

  /**
   * @param {AqaraDevice} device The device to show HomeKit.
   * @returns {void}
   */
  addToHomeKit(device) {
    const uuid = this.api.hap.uuid.generate(`aqara-local-${device.deviceId}`);
    const accessory = this.accessories.get(uuid)
      ?? new this.api.platformAccessory(device.name, uuid);

    accessory.context.deviceId = device.deviceId;

    const built = new HomeKitAccessory(device, accessory, this.api, this.log, this.config).build();
    if (!built) {
      return;
    }

    if (this.accessories.has(uuid)) {
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /**
   * @param {AqaraDevice} device The device to publish over Matter.
   * @returns {void}
   */
  addToMatter(device) {
    if (this.config.enableMatter === false || !MatterTwin.isAvailable(this.api)) {
      return;
    }

    const twin = new MatterTwin(device, this.api, this.log);
    if (!twin.supported()) {
      return;
    }

    const uuid = this.api.matter.uuid.generate(`aqara-matter-${device.deviceId}`);
    this.twins.set(uuid, twin);

    this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [twin.descriptor(uuid)])
      .then(() => device.on('changed', () => twin.report()))
      .catch(error => this.log.warn(`Could not publish ${device.name} over Matter: ${error.message ?? error}`));
  }

  /**
   * @param {object} message Whatever the hub said without being asked.
   * @returns {void}
   */
  onMessage(message) {
    if (message?.cmd !== 'report') {
      return;
    }

    const data = message.data ?? {};
    const device = this.devices.get(data.did);

    if (!device) {
      return;
    }

    // A report carries values by wire path; the device turns those into the codes everything else
    // works in, and tells both ecosystems what changed.
    const attrs = data.attrs ?? data.values ?? {};
    const changed = device.report(attrs);

    if (changed.length > 0) {
      this.log.debug(`${device.name}: ${changed.join(', ')}`);
    }
  }

  /**
   * @returns {void}
   */
  retryLater() {
    if (this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  /**
   * @returns {void}
   */
  stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.tunnel?.close();
  }
}
