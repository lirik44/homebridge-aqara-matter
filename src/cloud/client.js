import { createHash, publicEncrypt, randomUUID, constants as cryptoConstants } from 'node:crypto';

/**
 * The Aqara cloud, as their app talks to it.
 *
 * Used for exactly two things, and then left alone: exchanging an account for a session token, and
 * listing what the account owns. Everything after that goes over the local tunnel, so a broken
 * internet connection stops nothing but the first minute after a restart.
 */

/** Which server, and which of the app's signing identities, each region uses. */
export const AREAS = {
  CN: { server: 'https://aiot-rpc.aqara.cn', appId: '94549908487478b220992a70', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
  EU: { server: 'https://rpc-ger.aqara.com', appId: '7be1984f0556276133336839', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
  RU: { server: 'https://rpc-ru.aqara.com', appId: '94549908487478b220992a70', appKey: 'euGhPe2rcmxwculATNj45eEtnd50zp0I' },
  KR: { server: 'https://rpc-kr.aqara.com', appId: '94549908487478b220992a70', appKey: 'euGhPe2rcmxwculATNj45eEtnd50zp0I' },
  JP: { server: 'https://rpc-kr.aqara.com', appId: '94549908487478b220992a70', appKey: 'euGhPe2rcmxwculATNj45eEtnd50zp0I' },
  US: { server: 'https://aiot-rpc-usa.aqara.com', appId: '7be1984f0556276133336839', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
  AU: { server: 'https://rpc-au.aqara.com', appId: '7be1984f0556276133336839', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
  OTHER: { server: 'https://aiot-rpc-usa.aqara.com', appId: '7be1984f0556276133336839', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
};

/**
 * The three signing identities in use across the regions. Which one a given account needs does not
 * always follow its region, so a rejected signature is retried with the others once.
 */
const SIGNING_IDENTITIES = [
  { appId: '7be1984f0556276133336839', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
  { appId: '94549908487478b220992a70', appKey: 'euGhPe2rcmxwculATNj45eEtnd50zp0I' },
  { appId: '94549908487478b220992a70', appKey: 'Jddz01kIORDYrBzqGYgpUXKBnIHfW8E3' },
];

/** The app encrypts the password hash with this before sending it; the server holds the other half. */
const AQARA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCG46slB57013JJs4Vvj5cVyMpR
9b+B2F+YJU6qhBEYbiEmIdWpFPpOuBikDs2FcPS19MiWq1IrmxJtkICGurqImRUt
4lP688IWlEmqHfSxSRf2+aH0cH8VWZ2OaZn5DWSIHIPBF2kxM71q8stmoYiV0oZs
rZzBHsMuBwA4LQdxBwIDAQAB
-----END PUBLIC KEY-----`;

const PATHS = {
  login: '/app/v1.0/lumi/user/login',
  deviceList: '/app/v1.0/lumi/app/position/device/query',
};

/** The reply code that means "your signature is wrong", which is worth one retry with another identity. */
const CODE_BAD_SIGN = '106';

/** What the app calls itself. The server is picky about the shape, not the contents. */
const CLIENT_HEADERS = {
  'User-Agent': 'okhttp/4.12.0',
  'App-Version': '6.1.6',
  'Sys-Type': '1',
  'Lang': 'en',
  'Phone-Model': 'Homebridge##Server',
};

export class AqaraCloudError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AqaraCloudError';
    this.code = code;
  }
}

export class AqaraCloud {
  /**
   * @param {object} options How to reach the cloud.
   * @param {string} [options.region] The account's region, as the app shows it.
   * @param {string} [options.phoneId] A stable identifier for this installation.
   * @param {number} [options.timeoutMs] How long to wait for a reply.
   */
  constructor({ region = 'EU', phoneId, timeoutMs = 20000 } = {}) {
    this.region = String(region).toUpperCase();
    this.area = AREAS[this.region] ?? AREAS.OTHER;
    this.appId = this.area.appId;
    this.appKey = this.area.appKey;
    this.phoneId = phoneId ?? randomUUID().toUpperCase();
    this.timeoutMs = timeoutMs;
    this.identityProbed = false;
  }

  /**
   * Exchanges an account for a session token.
   *
   * The password never leaves as itself: what goes is its MD5, encrypted with the public key the
   * app carries. The token is what everything afterwards uses.
   *
   * @param {string} email The account.
   * @param {string} password Its password.
   * @returns {Promise<{userId: string, token: string, result: object}>} The session.
   */
  async login(email, password) {
    // The server checks the signature against the body exactly as sent, and the app's serialiser
    // puts a space after every colon and comma. Built by hand rather than by JSON.stringify,
    // which puts none: a tighter body signs to something the server refuses.
    const body = `{"account": ${JSON.stringify(email)}, "encryptType": 2, "password": ${JSON.stringify(this.encryptPassword(password))}}`;

    const payload = await this.signedRequest('POST', `${this.area.server}${PATHS.login}`, { signSource: body, body });
    const result = payload.result ?? {};

    if (!result.userId || !result.token) {
      throw new AqaraCloudError(`Login returned no token (keys: ${Object.keys(result).sort().join(', ')})`, payload.code);
    }

    return { userId: result.userId, token: result.token, result };
  }

  /**
   * @param {string} token A session token.
   * @returns {Promise<Array<object>>} Every device on the account, hubs and their children alike.
   */
  async listDevices(token) {
    // The signature covers the query string, alphabetically ordered and not percent-encoded.
    const query = 'size=300&startIndex=0';
    const payload = await this.signedRequest('GET', `${this.area.server}${PATHS.deviceList}?${query}`, { signSource: query, token });
    const devices = payload.result?.devices;

    if (!Array.isArray(devices)) {
      throw new AqaraCloudError('Device list reply carried no devices', payload.code);
    }

    return devices;
  }


  /*----------========== THE SIGNATURE ==========----------*/

  /**
   * @param {string} password The account password.
   * @returns {string} Its MD5, encrypted with the app's public key, base64 encoded.
   */
  encryptPassword(password) {
    const md5 = createHash('md5').update(password).digest('hex');
    return publicEncrypt(
      { key: AQARA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(md5),
    ).toString('base64');
  }

  /**
   * @param {string} nonce The request's nonce.
   * @param {string} time The moment, in milliseconds.
   * @param {string} signSource The body for a POST, the query string for a GET.
   * @param {string} [token] The session token, once there is one.
   * @returns {string} The signature the server checks.
   */
  sign(nonce, time, signSource, token) {
    const source = token
      ? `Appid=${this.appId}&Nonce=${nonce}&Time=${time}&Token=${token}&${signSource}&${this.appKey}`
      : `Appid=${this.appId}&Nonce=${nonce}&Time=${time}&${signSource}&${this.appKey}`;

    // Never log `source`: it carries both the session token and the shared signing key.
    return createHash('md5').update(source).digest('hex');
  }

  /**
   * @param {string} signSource What the signature covers.
   * @param {string} [token] The session token, once there is one.
   * @returns {Record<string, string>} The headers for one request.
   */
  buildHeaders(signSource, token) {
    const nonce = createHash('md5').update(randomUUID()).digest('hex');
    const time = String(Date.now());

    const headers = {
      ...CLIENT_HEADERS,
      PhoneId: this.phoneId,
      Area: this.region,
      Appid: this.appId,
      Nonce: nonce,
      Time: time,
      'Content-Type': 'application/json',
      Sign: this.sign(nonce, time, signSource, token),
    };

    if (token) {
      headers.Token = token;
    }

    return headers;
  }

  /**
   * Signs a request, sends it, and tries the other signing identities once if this one is refused.
   *
   * @param {string} method The HTTP method.
   * @param {string} url Where to.
   * @param {object} options The request.
   * @returns {Promise<object>} The parsed reply.
   */
  async signedRequest(method, url, { signSource, body, token } = {}) {
    let payload = await this.request(method, url, this.buildHeaders(signSource, token), body);

    if (String(payload.code) !== CODE_BAD_SIGN || this.identityProbed) {
      this.raiseIfError(payload);
      return payload;
    }

    // Which identity an account answers to does not always follow its region, and the reply says
    // only "invalid sign". Try the others once, and keep whichever works.
    this.identityProbed = true;
    for (const identity of SIGNING_IDENTITIES) {
      if (identity.appId === this.appId && identity.appKey === this.appKey) {
        continue;
      }

      this.appId = identity.appId;
      this.appKey = identity.appKey;
      payload = await this.request(method, url, this.buildHeaders(signSource, token), body);

      if (String(payload.code) !== CODE_BAD_SIGN) {
        this.raiseIfError(payload);
        return payload;
      }
    }

    this.raiseIfError(payload);
    return payload;
  }

  /**
   * @param {string} method The HTTP method.
   * @param {string} url Where to.
   * @param {Record<string, string>} headers The signed headers.
   * @param {string} [body] The body, for a POST.
   * @returns {Promise<object>} The parsed reply.
   */
  async request(method, url, headers, body) {
    let response;

    try {
      response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new AqaraCloudError(`The Aqara cloud could not be reached: ${error.message}`);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new AqaraCloudError(`The Aqara cloud answered ${response.status}: ${text.slice(0, 200)}`, String(response.status));
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new AqaraCloudError(`The Aqara cloud answered something that is not JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * @param {object} payload A reply.
   * @returns {void}
   * @throws {AqaraCloudError} When the reply carries an error code, with what the server said.
   */
  raiseIfError(payload) {
    const code = String(payload?.code ?? '');

    if (code === '0') {
      return;
    }

    throw new AqaraCloudError(`The Aqara cloud refused the request: ${payload?.message ?? 'no reason given'} (code ${code})`, code);
  }
}
