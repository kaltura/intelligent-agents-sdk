/**
 * Capabilities — the typed `AssistantCapability` set + the pure 3-level resolver
 * the SDK uses to make capability policy auditable BEFORE any turn.
 *
 * This file is PURE (zero I/O, zero deps): the const tables, the validators, and
 * the resolver. The wire methods (`getCapabilities`/`setCapability`/
 * `setCapabilities`/`resolveCapabilities`) live on `Intellects` and reuse
 * `mergeCapabilityWrite` from here for the safe read-merge-write; that write is
 * needed because `capabilities` is a **full-replace sub-dict** — a partial dict
 * sent to `v1/intellect/update` DROPS the sibling capabilities it omits (NOT
 * because update "replaces the intellect": update is a `model_fields_set` PATCH
 * that PRESERVES omitted top-level fields; it is `capabilities` itself that is
 * replaced wholesale). See API-REFERENCE.md § Configure an Intellect.
 *
 * Source of truth: the backend's `AssistantCapability` enum and default-value
 * table, resolved with 3-level priority (env → partner_config → per-request)
 * and a DISABLED veto that always wins regardless of layer.
 *
 * HONEST LIMIT: no public endpoint enumerates AssistantCapability or per-partner settings. CAPABILITIES is a hand-transcribed snapshot of the backend's defaults.
 * {@link CAPABILITIES} and {@link CAPABILITY_DEFAULTS} are a hand-transcribed
 * SNAPSHOT of the backend's defaults, GUARDED by the `check-docs.mjs` W7 assertion that
 * this enum equals the API-REFERENCE.md capability catalogue. The DISABLED
 * veto plus the request/partner_config layers are authoritative (resolved by the
 * server the same way); the `env` layer this module ships is a best-effort
 * documented prediction, not a live per-partner read.
 */
import { KalturaError } from '../core/errors.js';
import { meta } from '../core/ids.js';

/**
 * The 15 `AssistantCapability` names, frozen, in the backend's declaration order.
 * Hand-transcribed snapshot — see the HONEST LIMIT note above.
 *
 * `think_process` is deliberately ABSENT: it appears in some GenUI experience
 * configs but is NOT an AssistantCapability — sending it in a capabilities map 500s
 * intellect creation live (verified 2026-08). {@link assertCapability} therefore
 * rejects it BEFORE any network call, same as any other unknown name.
 * @type {readonly string[]}
 */
export const CAPABILITIES = Object.freeze([
  'use_knowledge_base',
  'use_content_search',
  'use_get_entry_content',
  'generate_followup_questions',
  'include_sources',
  'use_related_files',
  'video_gallery',
  'external_video',
  'show_link',
  'avatar',
  'avatar_filler',
  'avatar_show_content',
  'kaltura_genie_experiences',
  'use_web_search',
  'screen_share_analysis',
]);

/**
 * The `CapabilityState` enum. `disabled` is a HARD override — a stored or
 * env/partner_config `disabled` vetoes any per-request `on`. (The SDK-side
 * refusal in `setCapability` when re-enabling a stored `disabled` is a
 * CONVENIENCE GUARD, not an API constraint — the API would accept flipping a
 * stored `disabled` to `on`; the server-side veto applies only to per-REQUEST
 * overrides. Use `force:true` to bypass the SDK guard.)
 * @type {Readonly<{ON:'on', OFF:'off', DISABLED:'disabled'}>}
 */
export const CAPABILITY_STATE = Object.freeze({ ON: 'on', OFF: 'off', DISABLED: 'disabled' });

const VALID_STATES = Object.freeze([CAPABILITY_STATE.ON, CAPABILITY_STATE.OFF, CAPABILITY_STATE.DISABLED]);
const CAPABILITY_SET = new Set(CAPABILITIES);

/**
 * The OFF-by-default capabilities (the backend's `DEFAULT_CAPABILITY_VALUES`):
 * `avatar`, `avatar_filler`, `avatar_show_content`, `video_gallery`,
 * `external_video`, `show_link`, `use_web_search`, `screen_share_analysis`.
 * @type {readonly string[]}
 */
const OFF_BY_DEFAULT = Object.freeze([
  'avatar', 'avatar_filler', 'avatar_show_content', 'video_gallery',
  'external_video', 'show_link', 'use_web_search', 'screen_share_analysis',
]);

/**
 * Per-capability default snapshot — the `env`/default layer.
 *
 * DOCUMENTED SNAPSHOT: a hand-transcribed copy of the backend's
 * `DEFAULT_CAPABILITY_VALUES`. There is NO public
 * endpoint that returns per-partner env/settings overrides, so this is a
 * best-effort prediction of the env layer — NOT a live read. Eight capabilities
 * default OFF (see {@link OFF_BY_DEFAULT}); the other seven default ON
 * (`kaltura_genie_experiences` explicitly ON). Frozen so callers can't mutate
 * the snapshot.
 * @type {Readonly<Record<string,'on'|'off'>>}
 */
export const CAPABILITY_DEFAULTS = Object.freeze(
  CAPABILITIES.reduce((acc, name) => {
    acc[name] = OFF_BY_DEFAULT.includes(name) ? CAPABILITY_STATE.OFF : CAPABILITY_STATE.ON;
    return acc;
  }, /** @type {Record<string,'on'|'off'>} */ ({})),
);

/**
 * Per-capability metadata: `kind` (aligned with the doc's "Kind" column —
 * `tool` | `segment` | `mode` | `prompt`), the client-side `runtime` segment
 * name where one exists, the `defaultState` (from {@link CAPABILITY_DEFAULTS}),
 * and a one-line `summary`.
 * @type {Readonly<Record<string,{kind:'tool'|'segment'|'mode'|'prompt', runtime?:string, defaultState:'on'|'off', summary:string}>>}
 */
export const CAPABILITY_INFO = Object.freeze({
  use_knowledge_base: { kind: 'tool', defaultState: CAPABILITY_DEFAULTS.use_knowledge_base, summary: 'RAG retrieval over the bound knowledge_ids/indexer corpus (async_search_knowledge_base).' },
  use_content_search: { kind: 'tool', defaultState: CAPABILITY_DEFAULTS.use_content_search, summary: 'search_entries — search the partner media catalog metadata.' },
  use_get_entry_content: { kind: 'tool', defaultState: CAPABILITY_DEFAULTS.use_get_entry_content, summary: "Pull a specific entry's full transcript/content." },
  generate_followup_questions: { kind: 'segment', runtime: 'followups', defaultState: CAPABILITY_DEFAULTS.generate_followup_questions, summary: 'Emits a followups-tool segment (suggested next questions).' },
  include_sources: { kind: 'segment', runtime: 'sources', defaultState: CAPABILITY_DEFAULTS.include_sources, summary: 'Emits a sources-tool segment citing retrieved sources.' },
  use_related_files: { kind: 'tool', defaultState: CAPABILITY_DEFAULTS.use_related_files, summary: 'Surface related document attachments.' },
  video_gallery: { kind: 'segment', runtime: 'video-gallery', defaultState: CAPABILITY_DEFAULTS.video_gallery, summary: 'Permits a video-gallery-tool / content-gallery-tool segment (a deck/gallery of clips).' },
  external_video: { kind: 'segment', runtime: 'external-video', defaultState: CAPABILITY_DEFAULTS.external_video, summary: 'Permits an external-video-tool segment (embed a non-Kaltura video).' },
  show_link: { kind: 'segment', runtime: 'show-link', defaultState: CAPABILITY_DEFAULTS.show_link, summary: 'Permits a show-link-tool segment (render a link card).' },
  avatar: { kind: 'mode', defaultState: CAPABILITY_DEFAULTS.avatar, summary: 'Enables the live avatar face/voice channel; switches the model to agent_avatar_llm.' },
  avatar_filler: { kind: 'prompt', defaultState: CAPABILITY_DEFAULTS.avatar_filler, summary: 'Avatar speaks short filler phrases while thinking.' },
  avatar_show_content: { kind: 'prompt', defaultState: CAPABILITY_DEFAULTS.avatar_show_content, summary: 'Lets the avatar push visual content (slides/cards) alongside speech.' },
  kaltura_genie_experiences: { kind: 'mode', defaultState: CAPABILITY_DEFAULTS.kaltura_genie_experiences, summary: 'Master switch for structured GenUI (flashcards/summary/markdown experiences).' },
  use_web_search: { kind: 'tool', defaultState: CAPABILITY_DEFAULTS.use_web_search, summary: 'search_web (live external search), parameterized by web_search_config. Auto-on if web_search_config is set.' },
  screen_share_analysis: { kind: 'prompt', defaultState: CAPABILITY_DEFAULTS.screen_share_analysis, summary: 'Enables analysis of a user-shared screen.' },
});

/**
 * Assert a capability name is one of the 15 known {@link CAPABILITIES}. Throws
 * `KalturaError` ({code:'unknown_capability'}) BEFORE any network call.
 * @param {unknown} name
 * @param {string} [where] caller label for the error detail
 * @returns {string} the validated name (for chaining)
 */
export function assertCapability(name, where = 'capability') {
  if (typeof name !== 'string' || !CAPABILITY_SET.has(name)) {
    throw new KalturaError({
      type: 'about:blank', title: 'unknown capability', code: 'unknown_capability',
      detail: `${where}: unknown capability ${JSON.stringify(name)}. Must be one of: ${CAPABILITIES.join(', ')}.`,
    });
  }
  return name;
}

/**
 * Assert a state is one of `on`/`off`/`disabled`. Throws
 * `KalturaError` ({code:'bad_request'}) BEFORE any network call.
 * @param {unknown} state
 * @param {string} [where]
 * @returns {'on'|'off'|'disabled'}
 */
export function assertCapabilityState(state, where = 'capability') {
  if (typeof state !== 'string' || !VALID_STATES.includes(/** @type {any} */ (state))) {
    throw new KalturaError({
      type: 'about:blank', title: 'invalid capability state', code: 'bad_request',
      detail: `${where}: invalid state ${JSON.stringify(state)}. Must be one of: ${VALID_STATES.join(', ')}.`,
    });
  }
  return /** @type {'on'|'off'|'disabled'} */ (state);
}

/**
 * Validate a `{name:state}` capability dict — every key must be a known
 * capability and every value a valid state. Throws `KalturaError` on the first
 * offender, BEFORE any network call. Returns the dict unchanged for chaining.
 * @param {unknown} dict
 * @param {string} [where]
 * @returns {Record<string,'on'|'off'|'disabled'>}
 */
export function validateCapabilities(dict, where = 'capabilities') {
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
    throw new KalturaError({
      type: 'about:blank', title: 'capabilities object required', code: 'bad_request',
      detail: `${where}: expected an object of {capabilityName: state}, got ${JSON.stringify(dict)}.`,
    });
  }
  for (const [name, state] of Object.entries(dict)) {
    assertCapability(name, where);
    assertCapabilityState(state, `${where}.${name}`);
  }
  return /** @type {Record<string,'on'|'off'|'disabled'>} */ (dict);
}

/**
 * Full-replace merge for a capability WRITE. `capabilities` is a full-replace
 * sub-dict on the wire, so the SDK read-merge-write sends the ENTIRE current
 * dict with the patch overlaid — overlaying `patch` onto `current` and dropping
 * nothing. Both inputs are validated. Pure: returns a NEW object, mutates
 * neither argument. (Shared by `Intellects.setCapability`/`setCapabilities` and
 * by `Knowledge.setEnabled`, which patches the single `use_knowledge_base` key.)
 * @param {Record<string,'on'|'off'|'disabled'>|undefined|null} current the stored capabilities dict (e.g. from intellect.get)
 * @param {Record<string,'on'|'off'|'disabled'>} patch the keys to change
 * @returns {Record<string,'on'|'off'|'disabled'>} the merged full-replace dict to send
 */
export function mergeCapabilityWrite(current, patch) {
  const base = current == null ? {} : current;
  if (typeof base !== 'object' || Array.isArray(base)) {
    throw new KalturaError({
      type: 'about:blank', title: 'capabilities object required', code: 'bad_request',
      detail: `mergeCapabilityWrite: current must be an object of {capabilityName: state}, got ${JSON.stringify(current)}.`,
    });
  }
  // Validate the patch strictly (caller-controlled). For the current dict, only
  // validate keys that appear in CAPABILITIES — unknown keys (capabilities added
  // server-side after this SDK snapshot) are passed through unchanged so the SDK
  // does not throw 'unknown_capability' on a simple read-merge-write, which would
  // make that intellect's capabilities immutable from the SDK.
  const unknownCurrentKeys = /** @type {Record<string,any>} */ ({});
  const knownCurrentKeys = /** @type {Record<string,any>} */ ({});
  for (const [k, v] of Object.entries(base)) {
    if (CAPABILITY_SET.has(k)) {
      knownCurrentKeys[k] = v;
    } else {
      unknownCurrentKeys[k] = v;
    }
  }
  if (Object.keys(knownCurrentKeys).length > 0) {
    validateCapabilities(knownCurrentKeys, 'mergeCapabilityWrite.current');
  }
  validateCapabilities(patch, 'mergeCapabilityWrite.patch');
  // Unknown keys from the server are preserved at the front so known patch keys win.
  return { ...unknownCurrentKeys, ...knownCurrentKeys, ...patch };
}

/**
 * The PURE 3-level resolver — mirrors the server's `get_turned_on_capabilities`
 * behavior. For EVERY one of the 15
 * {@link CAPABILITIES} it resolves a final state with EXACT precedence:
 *
 *   1. DISABLED VETO — if `env` OR `partnerConfig` marks the capability
 *      `'disabled'`, the result is `'off'` regardless of any request override
 *      (`vetoed:true`). This is a hard override.
 *   2. Otherwise: `request` > `partnerConfig` > `env` > {@link CAPABILITY_DEFAULTS}.
 *
 * Note the asymmetry, faithful to the server: a `'disabled'` in `request` is
 * NOT a veto (a per-request override cannot newly disable a capability the way a
 * stored layer can) — it is treated as a normal request value that loses to the
 * veto and otherwise resolves like any state. Each result records the layer it
 * `resolvedFrom`, whether it was `vetoed`, and the raw `layers` it saw.
 *
 * `use_web_search` BEST-EFFORT: HONEST LIMIT: use_web_search may be forced ON server-side by web_search_config — this resolver cannot see that and marks the result inferred:true. A present
 * `web_search_config` server-side force-sets `use_web_search` ON. This resolver
 * does NOT have the brain config, so it CANNOT see that flip. The doc does not
 * confirm `intellect/get` exposes `web_search_config`, so we degrade gracefully:
 * `use_web_search` resolves from its explicit layers only and its result carries
 * `inferred:true` to mark it as a lower-confidence prediction (it may be ON at
 * runtime via `web_search_config` even when this predicts OFF). All other
 * capabilities resolve exactly.
 *
 * `resolvedFrom:'env'` vs `'default'` — a precedence subtlety: when `env` is
 * OMITTED, {@link CAPABILITY_DEFAULTS} is supplied AS the env layer. So an
 * unset capability resolves `resolvedFrom:'env'` (every name is present in the
 * defaults snapshot), NOT `'default'`. The literal `'default'` only appears when
 * you pass an EXPLICIT EMPTY env (`resolveCapabilities({env:{}})`), leaving a
 * name absent from every layer.
 * @example resolveCapabilities({}).capabilities.avatar.resolvedFrom === 'env'
 * @example resolveCapabilities({ env: {} }).capabilities.avatar.resolvedFrom === 'default'
 *
 * @param {object} [layers]
 * @param {Record<string,'on'|'off'|'disabled'>} [layers.env] env/settings layer (defaults to {@link CAPABILITY_DEFAULTS} when omitted)
 * @param {Record<string,'on'|'off'|'disabled'>} [layers.partnerConfig] stored partner_config.capabilities
 * @param {Record<string,'on'|'off'|'disabled'>} [layers.request] per-request override
 * @param {string|number} [layers.partnerId] for the `_meta` receipt
 * @param {boolean} [layers.webSearchConfigPresent] if true, `use_web_search` is force-resolved ON (mirrors the server flip)
 * @returns {{ capabilities: Record<string,{state:'on'|'off'|'disabled', resolvedFrom:'request'|'partner_config'|'env'|'default'|'disabled_veto'|'web_search_config', vetoed:boolean, inferred?:boolean, layers:{env?:string, partnerConfig?:string, request?:string, default:'on'|'off'}}>, _meta: object }}
 */
export function resolveCapabilities(layers = {}) {
  const env = layers.env === undefined ? CAPABILITY_DEFAULTS : layers.env;
  const partnerConfig = layers.partnerConfig || {};
  const request = layers.request || {};

  // Validate caller-supplied layers BEFORE resolving (no network here, but keep
  // the same fail-fast contract). The default snapshot is trusted (frozen).
  if (layers.env !== undefined) validateCapabilities(env, 'resolveCapabilities.env');
  if (layers.partnerConfig) validateCapabilities(partnerConfig, 'resolveCapabilities.partnerConfig');
  if (layers.request) validateCapabilities(request, 'resolveCapabilities.request');

  /** @type {Record<string, any>} */
  const out = {};
  for (const name of CAPABILITIES) {
    const envState = env[name];
    const pcState = partnerConfig[name];
    const reqState = request[name];
    const defState = CAPABILITY_DEFAULTS[name];

    const seen = {
      env: envState,
      partnerConfig: pcState,
      request: reqState,
      default: defState,
    };

    // (1) DISABLED veto — env OR partner_config disabled => off, period.
    if (envState === CAPABILITY_STATE.DISABLED || pcState === CAPABILITY_STATE.DISABLED) {
      out[name] = { state: CAPABILITY_STATE.OFF, resolvedFrom: 'disabled_veto', vetoed: true, layers: seen };
      continue;
    }

    // (2) request > partner_config > env > default.
    let state;
    let resolvedFrom;
    if (reqState !== undefined) { state = reqState; resolvedFrom = 'request'; }
    else if (pcState !== undefined) { state = pcState; resolvedFrom = 'partner_config'; }
    else if (envState !== undefined) { state = envState; resolvedFrom = 'env'; }
    else { state = defState; resolvedFrom = 'default'; }

    const entry = { state, resolvedFrom, vetoed: false, layers: seen };

    // use_web_search: a present web_search_config force-sets it ON server-side.
    // Best-effort/inferred — the resolver can't read web_search_config itself.
    if (name === 'use_web_search') {
      if (layers.webSearchConfigPresent && state !== CAPABILITY_STATE.DISABLED) {
        entry.state = CAPABILITY_STATE.ON;
        entry.resolvedFrom = 'web_search_config';
      }
      entry.inferred = true;
    }
    out[name] = entry;
  }

  return {
    capabilities: out,
    _meta: meta({
      partnerId: layers.partnerId === undefined ? undefined : String(layers.partnerId),
      source: 'sdk/capabilities/resolve',
      scope: 'pure resolver (request > partner_config > env > default; DISABLED veto)',
    }),
  };
}
