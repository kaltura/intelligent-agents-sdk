/**
 * IntellectSecrets — the named-secret lifecycle for an intellect's
 * `config.secrets` dict (e.g. an OAuth `client_secret` an `api` tool references
 * via `{{secrets.X}}`). Genie host, ADMIN token. Only writable via this SDK
 * surface (insert/replace-only, WRITE-ONLY).
 *
 * Secrets are WRITE-ONLY: reads mask every value as `"***"`. On update, a value
 * equal to `"***"` is replaced server-side with the stored secret (the
 * server's merge-keep guard for secret writes), so a read-modify-write round
 * trip never clobbers a sibling secret. There is NO per-secret endpoint and NO
 * way to read a plaintext value back — every op here is a read-merge-write of
 * the FULL `config.secrets` dict against {@link Intellects#get}, then
 * `v1/intellect/update` (`secrets` lives in the intellect DTO).
 *
 * No-leak guarantee comes from the NAME-ONLY response contract of this class
 * (values are never returned), NOT from `redact()` — secret values live under
 * arbitrary keys that do not match any redact pattern. So this surface simply
 * never echoes a value.
 *
 * HONEST LIMIT: client-side encryption / BYOK / CMK is NOT buildable.
 * Secrets are encrypted at rest server-side; there is no public
 * key-wrap endpoint. This is a real backend capability gap, not a DX gap,
 * and this module does not pretend to encrypt client-side.
 */
import { KalturaError } from '../core/errors.js';
import { meta } from '../core/ids.js';
import { requireInt } from './intellect-body.js';
import { requireConfirm } from './agents.js';

/** The server-side mask + merge-keep sentinel. Sending it back PRESERVES the stored value. */
export const MASK = '***';

export class IntellectSecrets {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * List the NAMES of an intellect's secrets — values are NEVER returned (the
   * stored values are masked `"***"` on the wire and dropped here). READ.
   * @param {number} configId
   * @param {string} ks (admin)
   * @returns {Promise<{names:string[], _meta:object}>}
   */
  async listNames(configId, ks) {
    this._.assertAdmin(ks, 'secrets.listNames');
    requireInt(configId, 'secrets.listNames configId');
    const { secrets: map } = await this._read(configId, ks);
    return {
      names: Object.keys(map).sort(),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `intellect:${configId}` }),
    };
  }

  /**
   * Whether a secret with `name` exists (presence only — no value). READ.
   * @param {number} configId
   * @param {string} name
   * @param {string} ks (admin)
   * @returns {Promise<boolean>}
   */
  async has(configId, name, ks) {
    this._.assertAdmin(ks, 'secrets.has');
    requireInt(configId, 'secrets.has configId');
    requireName(name, 'secrets.has name');
    const { secrets: map } = await this._read(configId, ks);
    return Object.prototype.hasOwnProperty.call(map, name);
  }

  /**
   * Set / replace one or more secrets. WRITE — idempotent. Read-merge-writes the
   * FULL `config.secrets` dict: existing secrets are re-sent as `"***"` (so the
   * merge-keep guard preserves them) and the supplied `{name:value}` pairs
   * overwrite/insert. A literal `"***"` value is REJECTED (it is the keep
   * sentinel, not a storable value); empty/blank values are rejected too.
   * @param {number} configId
   * @param {Record<string,string>} entries `{name: plaintextValue}`
   * @param {string} ks (admin)
   * @returns {Promise<{names:string[], set:string[], _meta:object}>}
   */
  async set(configId, entries, ks) {
    this._.assertAdmin(ks, 'secrets.set');
    requireInt(configId, 'secrets.set configId');
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
      throw badRequest('secrets.set', 'entries must be a non-empty { name: value } object.');
    }
    const incoming = Object.keys(entries).sort();
    for (const name of incoming) {
      requireName(name, `secrets.set name "${name}"`);
      const v = entries[name];
      if (typeof v !== 'string' || v.length === 0) {
        throw badRequest('secrets.set', `value for "${name}" must be a non-empty string.`);
      }
      if (v === MASK) {
        throw badRequest('secrets.set', `cannot store the literal "${MASK}" for "${name}" — it is the merge-keep sentinel, not a value.`);
      }
    }
    const { secrets: existing, type } = await this._read(configId, ks);
    const next = maskExisting(existing); // every prior secret as "***" → server keeps it
    for (const name of incoming) next[name] = entries[name];
    await this._write(configId, type, next, ks);
    return {
      names: Object.keys(next).sort(),
      set: incoming,
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `intellect:${configId}` }),
    };
  }

  /**
   * Remove ONE secret by name without clobbering the others. WRITE —
   * DESTRUCTIVE (unrecoverable — the plaintext cannot be read back to restore).
   * Read-merge-writes the full dict minus `name`; surviving secrets are re-sent
   * as `"***"`. Guards `not_found` if the name is absent.
   * @param {number} configId
   * @param {string} name
   * @param {string} ks (admin)
   * @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{names:string[], removed:string, _meta:object}>}
   */
  async delete(configId, name, ks, confirm) {
    this._.assertAdmin(ks, 'secrets.delete');
    requireInt(configId, 'secrets.delete configId');
    requireName(name, 'secrets.delete name');
    requireConfirm(confirm, 'secrets.delete', name);
    const { secrets: existing, type } = await this._read(configId, ks);
    if (!Object.prototype.hasOwnProperty.call(existing, name)) {
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/not_found', title: 'not found', code: 'not_found', detail: `secrets.delete: no secret named "${name}" on intellect ${configId}.` });
    }
    const next = maskExisting(existing);
    delete next[name];
    await this._write(configId, type, next, ks);
    return {
      names: Object.keys(next).sort(),
      removed: name,
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `intellect:${configId}` }),
    };
  }

  /**
   * Replace the ENTIRE secrets dict with the supplied set (any name not present
   * here is dropped). WRITE — DESTRUCTIVE. Same value rules as {@link set}
   * (no literal `"***"`, no empty). Unlike `set`, prior secrets are NOT
   * preserved — they are removed unless re-supplied.
   * @param {number} configId
   * @param {Record<string,string>} entries `{name: plaintextValue}` (may be empty to clear all)
   * @param {string} ks (admin)
   * @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{names:string[], _meta:object}>}
   */
  async replaceAll(configId, entries, ks, confirm) {
    this._.assertAdmin(ks, 'secrets.replaceAll');
    requireInt(configId, 'secrets.replaceAll configId');
    requireConfirm(confirm, 'secrets.replaceAll', `intellect:${configId}`);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw badRequest('secrets.replaceAll', 'entries must be a { name: value } object (may be empty to clear all).');
    }
    /** @type {Record<string,string>} */
    const next = {};
    for (const name of Object.keys(entries).sort()) {
      requireName(name, `secrets.replaceAll name "${name}"`);
      const v = entries[name];
      if (typeof v !== 'string' || v.length === 0) {
        throw badRequest('secrets.replaceAll', `value for "${name}" must be a non-empty string.`);
      }
      if (v === MASK) {
        throw badRequest('secrets.replaceAll', `cannot store the literal "${MASK}" for "${name}".`);
      }
      next[name] = v;
    }
    const { type } = await this._read(configId, ks);
    await this._write(configId, type, next, ks);
    return {
      names: Object.keys(next).sort(),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `intellect:${configId}` }),
    };
  }

  /**
   * Fetch the intellect and cross-check that every `{{secrets.X}}` reference in
   * its tools / prompts resolves to a known secret name, and report
   * dead (unused) secrets. READ — no state change.
   * WARNS, never throws (an OAuth bootstrap may add the secret in a later call).
   * @param {number} configId
   * @param {string} ks (admin)
   * @returns {Promise<{ok:boolean, unresolved:{ref:string,where:string}[], unused:string[], references:{name:string,where:string}[], _meta:object}>}
   */
  async validate(configId, ks) {
    this._.assertAdmin(ks, 'secrets.validate');
    requireInt(configId, 'secrets.validate configId');
    const dto = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data;
    const config = dto?.config && typeof dto.config === 'object' ? dto.config : dto;
    const secretNames = Object.keys((config && config.secrets) || {});
    const report = validateSecretRefs({
      secretNames,
      tools: config?.tools,
      prompts: config?.prompts,
    });
    return {
      ...report,
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `intellect:${configId}` }),
    };
  }

  /**
   * Read the masked secrets dict + the `type` discriminator from the intellect
   * DTO in ONE call (the discriminator is required by `intellect/update`, so we
   * never guess it — omitting it → HTTP 422). @param {number} configId @param {string} ks
   * @returns {Promise<{secrets:Record<string,string>, type:unknown}>}
   */
  async _read(configId, ks) {
    const dto = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data;
    const config = dto?.config && typeof dto.config === 'object' ? dto.config : dto;
    const map = config && typeof config.secrets === 'object' && config.secrets ? config.secrets : {};
    const type = dto?.type ?? dto?.config?.type ?? 'internal';
    return { secrets: /** @type {Record<string,string>} */ ({ ...map }), type };
  }

  /** Write the full secrets dict via intellect/update (requires {id,type}). @param {number} configId @param {unknown} type @param {Record<string,string>} secrets @param {string} ks */
  async _write(configId, type, secrets, ks) {
    return (await this._.genie('v1/intellect/update', { id: configId, type, secrets }, ks)).data;
  }
}

/**
 * Re-send every prior secret as the merge-keep sentinel so the server preserves
 * it. Exported so other read-merge-write callers of `secrets` (e.g.
 * `IntellectConfig#setSecrets`) share this exact mask loop rather than
 * reimplementing it. @param {Record<string,string>} existing
 */
export function maskExisting(existing) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const k of Object.keys(existing)) out[k] = MASK;
  return out;
}

/** @param {unknown} name @param {string} where */
function requireName(name, where) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw badRequest(where, 'secret name must be a non-empty string.');
  }
}

/** @param {string} where @param {string} detail */
function badRequest(where, detail) {
  return new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where}: ${detail}` });
}

// CANONICAL form is `{{secrets.X}}`: a secret is rendered server-side into the
// prompt template at converse time under the `secrets` namespace, so
// `{{secrets.X}}` resolves and `{{variables.secrets.X}}` does NOT (it renders
// as empty/literal). The matcher captures the OPTIONAL `variables.` prefix
// (group 1) so a mistyped ref is FLAGGED as `badPrefix`, never silently
// normalized to the bare name and treated as resolved. Docs/placeholders must
// use `{{secrets.X}}`.
const REF_RE = /\{\{\s*(variables\.)?secrets\.([A-Za-z0-9_\-.]+)\s*\}\}/g;

/**
 * Pure: scan a tool/prompt config tree for secret references and
 * cross-check them against the set of known secret names. WARNS via the
 * returned report — never throws. Accepts either:
 *
 *   validateSecretRefs({ secretNames, tools?, prompts? })
 *   validateSecretRefs(toolConfig, secretNames)   // task convenience overload
 *
 * Canonical reference is `{{secrets.X}}` (rendered server-side into the prompt
 * template at converse time, under the `secrets` namespace). The
 * non-resolving `{{variables.secrets.X}}` prefix is detected and reported as a
 * `badPrefix` entry (and forces `ok:false`) REGARDLESS of whether `X` is a known
 * secret — because that form renders empty at runtime, so referencing even an
 * existing secret with the prefix is a real (silent-at-runtime) defect.
 *
 * @param {{secretNames?:string[], tools?:unknown, prompts?:unknown}|unknown} arg1
 * @param {string[]} [secretNamesArg]  Used only with the (toolConfig, secretNames) overload.
 * @returns {{ok:boolean, unresolved:{ref:string,where:string}[], badPrefix:{ref:string,where:string,note:string}[], unused:string[], references:{name:string,where:string,prefixed:boolean}[]}}
 */
export function validateSecretRefs(arg1, secretNamesArg) {
  /** @type {string[]} */ let secretNames;
  /** @type {Record<string,unknown>} */ let sources;
  if (Array.isArray(secretNamesArg)) {
    // Overload: (toolConfig, secretNames) — scan the single config under `tools`.
    secretNames = secretNamesArg;
    sources = { tools: arg1 };
  } else {
    const o = (arg1 && typeof arg1 === 'object') ? /** @type {Record<string,unknown>} */ (arg1) : {};
    secretNames = Array.isArray(o.secretNames) ? /** @type {string[]} */ (o.secretNames) : [];
    sources = { tools: o.tools, prompts: o.prompts };
  }
  const known = new Set(secretNames);

  /** @type {{name:string,where:string,prefixed:boolean}[]} */ const references = [];
  for (const [where, node] of Object.entries(sources)) {
    if (node === undefined || node === null) continue;
    for (const ref of scanRefs(node)) references.push({ name: ref.name, where, prefixed: ref.prefixed });
  }

  // A `variables.` prefix never resolves at the backend → always a defect.
  const badPrefix = references
    .filter((r) => r.prefixed)
    .map((r) => ({ ref: r.name, where: r.where, note: 'non-resolving {{variables.secrets.X}} prefix — use {{secrets.X}} (renders empty at runtime)' }));
  // Unknown-name refs are unresolved. (Prefixed refs are reported under badPrefix, not here,
  // even when the bare name is known — so the two warning classes do not double-count.)
  const unresolved = references
    .filter((r) => !r.prefixed && !known.has(r.name))
    .map((r) => ({ ref: r.name, where: r.where }));
  const referenced = new Set(references.filter((r) => !r.prefixed).map((r) => r.name));
  const unused = secretNames.filter((n) => !referenced.has(n)).sort();

  return { ok: unresolved.length === 0 && badPrefix.length === 0, unresolved, badPrefix, unused, references };
}

/** Walk any JSON-ish value, collecting every secret-reference {name, prefixed} found in string leaves. @param {unknown} node @returns {{name:string,prefixed:boolean}[]} */
function scanRefs(node) {
  /** @type {{name:string,prefixed:boolean}[]} */ const out = [];
  /** @param {unknown} v */
  const walk = (v) => {
    if (typeof v === 'string') {
      REF_RE.lastIndex = 0;
      let m;
      while ((m = REF_RE.exec(v)) !== null) out.push({ name: m[2], prefixed: !!m[1] });
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(node);
  return out;
}
