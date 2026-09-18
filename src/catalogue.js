import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What each Aqara model can do, read from the catalogue the Home Assistant integration assembled.
 *
 * Every model is a folder holding a `data.json`: a display name, a manufacturer, and a set of
 * traits keyed by their wire path (`<endpoint>.<service>.<resource>`). Each trait carries a code
 * saying what it is - `OnOff`, `CurrentLevel`, `CurrentTemperature`, `ContactSensorState` - along
 * with its type, its range and its unit.
 *
 * That code is what the rest of this plugin works from, which is why a device nobody has ever
 * tried still produces the right accessory: it is described, not special-cased.
 */

const CATALOGUE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'custom_components',
  'aqara_lanlink',
  'device',
  'models',
);

/** Loaded on first use and kept: 380-odd small files, read once. */
let index = null;

/**
 * @returns {Map<string, object>} Every model in the catalogue, by its model string.
 */
function load() {
  if (index) {
    return index;
  }

  index = new Map();

  for (const entry of readdirSync(CATALOGUE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    let data;
    try {
      data = JSON.parse(readFileSync(join(CATALOGUE_DIR, entry.name, 'data.json'), 'utf8'));
    } catch {
      // A folder without readable data describes nothing; the others still do.
      continue;
    }

    // A package answers to its own model string and to every model bundled with it.
    for (const model of [data.model, ...(data.models ?? []), ...(data.bundle_ids ?? [])]) {
      if (typeof model === 'string' && model) {
        index.set(model, data);
      }
    }
  }

  return index;
}

/**
 * @param {string} model An Aqara model string, as the cloud spells it.
 * @returns {object|null} What the catalogue knows about it.
 */
export function describe(model) {
  return load().get(model) ?? null;
}

/**
 * The traits of a model, as the rest of the plugin wants them: keyed by what they are rather than
 * by where they live.
 *
 * @param {string} model An Aqara model string.
 * @returns {Map<string, {path: string, spec: object}>} Trait code to its path and description.
 *   Where a model carries the same code more than once - a two-button switch, say - the first is
 *   kept and the rest are reachable through {@link traitsOf}.
 */
export function capabilities(model) {
  const found = new Map();

  for (const [path, spec] of traitsOf(model)) {
    const code = spec.trait_code;
    if (code && !found.has(code)) {
      found.set(code, { path, spec });
    }
  }

  return found;
}

/**
 * @param {string} model An Aqara model string.
 * @returns {Array<[string, object]>} Every trait of the model, as path and description.
 */
export function traitsOf(model) {
  const data = describe(model);
  return data?.traits ? Object.entries(data.traits) : [];
}

/**
 * @param {string} model An Aqara model string.
 * @returns {{name: string, manufacturer: string}} What to call a device of this model when the
 *   user has not named it.
 */
export function identity(model) {
  const data = describe(model);

  return {
    name: data?.display_name ?? model,
    manufacturer: data?.manufacturer ?? 'Aqara',
  };
}

/**
 * @returns {number} How many models the catalogue describes. Useful in a log line, and as a check
 *   that the catalogue came along with the plugin.
 */
export function size() {
  return load().size;
}
