/**
 * Converse stream parser. `assistant/converse` returns a newline-delimited
 * stream — NDJSON by default (`sse:false`) or SSE `data:`-prefixed lines
 * (`sse:true`). Both carry the same per-segment JSON objects (API-REFERENCE
 * §4.1; WIRE-PROTOCOL §4e for the segment `type` model).
 *
 * {@link parseConverseStream} adapts a `ReadableStream<Uint8Array>` (what
 * `fetch().body` yields, in Node ≥18 and browsers) into an async iterator of
 * parsed segments — so callers `for await (const seg of …)`. Pure parsing, no
 * network: unit-testable by feeding a fake stream.
 *
 * @module core/stream
 */
import { meta } from './ids.js';

/**
 * @typedef {object} ConverseSegment
 * @property {string} [type]        text|avatar|avatar-filler|think|tool|tool_response|unisphere-tool|share|thread|error|… (LLM-chosen fence tag + control types; text/avatar/avatar-filler are the spoken types — see {@link SPOKEN_TYPES})
 * @property {string} [content]
 * @property {string} [threadId]
 * @property {string} [messageId]
 * @property {boolean} [isFinal]
 * @property {boolean} [segmentStart]
 * @property {boolean} [segmentEnd]
 * @property {{widgetName?:string, runtimeName?:string}} [metadata]
 * @property {{id:string, name?:string, args?:object, type?:string, wait_for_response?:boolean}} [tool_metadata]  Present on some `type:"tool"` segments (WIRE-PROTOCOL §4e); see {@link parseToolCall}.
 */

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{sse?:boolean}} [opts]
 * @returns {AsyncGenerator<ConverseSegment>}
 */
export async function* parseConverseStream(stream, opts = {}) {
  const sse = !!opts.sse;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const seg = parseLine(raw, sse);
        if (seg) yield seg;
      }
    }
    const tail = parseLine(buf, sse);
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Deterministic JSON serialization with object keys sorted at EVERY nesting level
 * (a plain `JSON.stringify(v, Object.keys(v).sort())` replacer-array only sorts the
 * top level and silently drops nested keys absent from that top-level list — wrong
 * for nested tool args). Arrays keep their order (order is meaningful there); only
 * plain-object key order is normalized. Used to dedup semantically-identical tool
 * calls whose JSON key order the LLM emitted non-deterministically (issue #18).
 * @param {unknown} value @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} raw @param {boolean} sse @returns {ConverseSegment|null} */
function parseLine(raw, sse) {
  let line = raw.trim();
  if (!line) return null;
  if (sse) {
    if (!line.startsWith('data:')) return null;
    line = line.slice(5).trim();
    if (!line || line === '[DONE]') return null;
  }
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * The nine first-class GenUI runtimes, as they appear ON THE WIRE — Genie tags
 * a `unisphere-tool` segment's `metadata.runtimeName` with the `-tool` suffix
 * (e.g. `flashcards-tool`). These are the wire-form peers of the stripped
 * dispatch keys in `experience/genui/parse.js` (`RUNTIMES`); the renderer there
 * normalizes via `normalizeRuntime`. Kept here so `segmentKind` can classify a
 * segment without importing the experience layer (core stays leaf).
 * @type {readonly string[]}
 */
export const GENUI_RUNTIMES = Object.freeze([
  'flashcards-tool',
  'followups-tool',
  'sources-tool',
  'summary-tool',
  'video-gallery-tool',
  'show-link-tool',
  'external-video-tool',
  'user-properties-form-tool',
  'content-gallery-tool',
]);

/** Spoken/visible prose types — accumulated into `text`. */
export const SPOKEN_TYPES = new Set(['text', 'avatar', 'avatar-filler']);

/**
 * The one follow-up nudge {@link import('../management/conversations.js').Conversations#send}
 * sends when `recoverFromSpiral:true` and the first attempt came back `spiralStopped:true`
 * with empty text, and the same instruction `KalturaAvatarSession` prepends when auto-resending
 * a turn after a spiral-triggered `_coldReconnect()`. Verified live to reliably break a
 * tool-call loop (the brain stops re-issuing the tool and answers in words) without discarding
 * the user's original question — it's prepended, not substituted. Lives here (not in either
 * `management/conversations.js` or `experience/session.js`) so both the headless and live-socket
 * recovery paths share one literal.
 * @type {string}
 */
export const SPIRAL_RECOVERY_PREFIX = 'Please answer in words only this turn, without calling any tool. ';

/**
 * Classify a converse segment into one of four kinds:
 *
 * - `'spoken'`     — visible prose: `text` / `avatar` / `avatar-filler`.
 * - `'experience'` — a `unisphere-tool` GenUI widget segment.
 * - `'error'`      — an `error` segment.
 * - `'control'`    — everything else (`think`/`tool`/`tool_response`/`share`/
 *                    `thread`/`segmentStart`-only markers/unknown types).
 *
 * Pure, never throws; a missing/odd `type` falls through to `'control'`.
 * @param {ConverseSegment} [seg]
 * @returns {'spoken'|'control'|'experience'|'error'}
 */
export function segmentKind(seg) {
  const type = seg && typeof seg === 'object' ? seg.type : undefined;
  if (type === 'unisphere-tool') return 'experience';
  if (type === 'error') return 'error';
  if (typeof type === 'string' && SPOKEN_TYPES.has(type)) return 'spoken';
  return 'control';
}

/**
 * @typedef {object} ToolCallMetadata
 * @property {string} id  The request id to echo back on `/assistant/tool_response`
 * (via `respondToTool`/`conversations.respondToTool`) — NOT a Tools-entity UUID,
 * despite the wire field being named `tool_id` on that endpoint (issue #31 gap 2).
 * @property {boolean} waitForResponse  `true` when the brain is blocked awaiting
 * an explicit ACK before it can continue the turn (wire `wait_for_response`).
 * @property {string} [type]  The tool's declared type (`'api'`|`'client'`|`'csv'`|`'code'`).
 */

/**
 * @typedef {object} ToolCall
 * @property {string} name  The tool the LLM invoked (e.g. `navigate_to_slide`).
 * @property {object} args  The parsed argument object (`{}` if none/unparseable).
 * @property {string} raw   The verbatim segment content (`"<name> {<json>}"`).
 * @property {ToolCallMetadata} [toolMetadata]  Present when the segment carried a
 * wire `tool_metadata` object (WIRE-PROTOCOL §4e); absent for older/synthetic
 * segments that don't. Required to satisfy a `waitForResponse:true` call.
 */

/**
 * @typedef {object} ToolArgSchema  Per-key runtime shape check. Structurally
 * compatible with {@link import('../management/tools.js').GenieToolArg} (a
 * superset — `prompt`/`default` are simply ignored here), so a host can pass the
 * EXACT SAME `args` object it already declared in `tools.client({args})`.
 * @property {'str'|'int'|'float'|'bool'|'list'|'dict'} [type]
 * @property {boolean} [required]
 * @property {unknown[]} [enum]  Closed set of legal values (checked when the arg is present).
 */

/**
 * The six-value tool-arg-type vocabulary — the SINGLE SOURCE OF TRUTH, shared
 * with {@link import('../management/tools.js').ARG_TYPES} (which derives from
 * this, not the other way around: core/ must never import from management/,
 * so the canonical list lives here and management/ imports it).
 * @type {readonly ('str'|'int'|'float'|'bool'|'list'|'dict')[]}
 */
export const ARG_TYPE_NAMES = Object.freeze(['str', 'int', 'float', 'bool', 'list', 'dict']);

// Each ARG_TYPE_NAMES value needs its own distinct runtime check, so this can't be
// generated from the name list mechanically — but the keys MUST exactly match
// ARG_TYPE_NAMES (the single source of truth declared above), so a dev-time
// assertion below catches any future drift (a name added/renamed in one place
// and not the other) immediately rather than silently.
const TYPE_CHECKS = {
  str: (v) => typeof v === 'string',
  int: (v) => typeof v === 'number' && Number.isInteger(v),
  float: (v) => typeof v === 'number',
  bool: (v) => typeof v === 'boolean',
  list: (v) => Array.isArray(v),
  dict: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};
if (ARG_TYPE_NAMES.length !== Object.keys(TYPE_CHECKS).length || ARG_TYPE_NAMES.some((n) => !(n in TYPE_CHECKS))) {
  throw new Error('core/stream.js: TYPE_CHECKS has drifted from ARG_TYPE_NAMES — keep both in sync.');
}

/**
 * Validate a tool call's `args` against an optional per-key {@link ToolArgSchema}
 * map — the runtime counterpart to `tools.js`'s `validateArgs` (which checks the
 * LLM-facing schema DECLARATION shape, not actual call values). Checks `type`
 * (the six-value `ARG_TYPES` vocabulary), `required`, and `enum`, top-level keys
 * only (the LLM-facing schema never nests). Root-cause motivation: a malformed
 * call that "looks like" a spiral (e.g. a bare string where an int was declared)
 * should be caught HERE, before a handler runs on bad data, rather than surfacing
 * only as a downstream failure (issue #24).
 *
 * PURE, never throws — returns `{ok:true}` or `{ok:false, errors:string[]}` so a
 * caller decides what to do (emit a local event, log, drop the call) rather than
 * validation itself throwing into a live dispatch path. No schema (or a key with
 * no recognized checks) never blocks — this is an opt-in, additive guard.
 * @param {object} args
 * @param {Record<string, ToolArgSchema>} [schema]
 * @returns {{ok:boolean, errors?:string[]}}
 */
export function validateToolArgs(args, schema) {
  if (!schema || typeof schema !== 'object') return { ok: true };
  const a = args && typeof args === 'object' ? args : {};
  /** @type {string[]} */ const errors = [];
  for (const [key, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== 'object') continue;
    const value = a[key];
    if (value === undefined) {
      if (spec.required) errors.push(`"${key}" is required`);
      continue;
    }
    const check = spec.type && TYPE_CHECKS[spec.type];
    if (check && !check(value)) {
      errors.push(`"${key}" must be of type ${spec.type}, got ${JSON.stringify(value)}`);
      continue;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      errors.push(`"${key}" must be one of ${JSON.stringify(spec.enum)}, got ${JSON.stringify(value)}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Parse a `type:"tool"` segment into a structured `{name, args, raw}` tool call.
 *
 * When the LLM calls a native function-calling tool (an intellect `tools` entry,
 * incl. a {@link import('../management/tools.js').client} tool), Genie streams a
 * SILENT `type:"tool"` segment — not in the TTS gate, so it never reaches the
 * voice track (WIRE-PROTOCOL §4e). Its `content` is the wire form
 * `"<toolName> <json-args>"`, e.g. `navigate_to_slide {"slide_num": 4}`. This is
 * the canonical client-side-command channel: the host app reads the tool name +
 * args and runs whatever JS it wants (navigate a deck, call a page function,
 * inject content). A native `type:"client"` tool makes NO server-side call at
 * all — the `type:"tool"` segment IS the entire contract.
 *
 * Robust to phrasing: extracts the args object from the first `{` onward, and if
 * that doesn't parse, returns `{name, args:{}, raw}` rather than throwing. PURE,
 * never throws. Returns `null` for anything that is not a tool segment.
 *
 * Also lifts the segment's wire `tool_metadata` (id/name/args/type/wait_for_response
 * — WIRE-PROTOCOL §4e, live-verified through the conversation-manager relay hop
 * intact) into a camelCase `toolMetadata` field when present, so a caller of
 * `respondToTool()`/`onToolCall()`/`collectConverse().toolCalls` can satisfy a
 * `waitForResponse:true` call without dropping to raw `brainSegment` (issue #31
 * gap 2). Absent (not synthesized) when the segment carries no `tool_metadata`.
 *
 * FUSED MULTI-TOOL SEGMENTS (live-verified): when the brain calls more than one
 * tool in a single turn, the server can stream ONE `type:"tool"` segment whose
 * `content` is N concatenated JSON objects under a single printed name — e.g.
 * `open_filing {"quarters":[...],"metric":"total_revenue"}{"quarter":"q1_2026","docType":"press_release"}`.
 * The printed name pairs with the LAST object (`args` above always takes it, so
 * the named tool always gets its own real args instead of `{}`); any EARLIER
 * object belongs to a DIFFERENT tool this segment doesn't name. Those are
 * returned in arrival order as `fusedArgs` — see `KalturaAvatarSession`'s
 * `tool_response`-name pairing (the only reliable attribution signal) for how a
 * live session recovers them; a headless caller reading `fusedArgs` directly
 * must supply its own attribution.
 *
 * @param {ConverseSegment|undefined} seg
 * @returns {ToolCall|null}
 * @example
 * for await (const seg of session) {
 *   const call = parseToolCall(seg);
 *   if (call?.name === 'navigate_to_slide') deck.goTo(call.args.slide_num);
 * }
 */
export function parseToolCall(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'tool') return null;
  const content = typeof seg.content === 'string' ? seg.content : '';
  if (!content) return null;
  const brace = content.indexOf('{');
  const name = (brace >= 0 ? content.slice(0, brace) : content).trim();
  if (!name) return null;
  /** @type {object} */ let args = {};
  /** @type {object[]} */ const blobs = [];
  if (brace >= 0) {
    for (const raw of splitJsonObjects(content.slice(brace))) {
      try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) blobs.push(v); } catch { /* tolerate */ }
    }
    if (blobs.length) args = blobs[blobs.length - 1];
  }
  /** @type {ToolCall} */ const call = { name, args, raw: content };
  if (blobs.length > 1) call.fusedArgs = blobs.slice(0, -1);
  const meta = seg.tool_metadata;
  if (meta && typeof meta === 'object' && typeof meta.id === 'string' && meta.id) {
    call.toolMetadata = { id: meta.id, waitForResponse: meta.wait_for_response === true };
    if (typeof meta.type === 'string' && meta.type) call.toolMetadata.type = meta.type;
  }
  return call;
}

/**
 * Split a string starting at `{` into its top-level balanced-brace JSON object
 * substrings — brace-depth AND string/escape aware, so a `}` or `{` inside a
 * quoted value never miscounts. Used by `parseToolCall` to recover N
 * concatenated tool-arg objects from a fused segment. Tolerant: stops at the
 * first unterminated/malformed object rather than throwing. PURE.
 * @param {string} s
 * @returns {string[]}
 */
function splitJsonObjects(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n || s[i] !== '{') break;
    const start = i;
    let depth = 0, inStr = false, esc = false, closed = false;
    for (; i < n; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { out.push(s.slice(start, i + 1)); i++; closed = true; break; }
      }
    }
    if (!closed) break;
  }
  return out;
}

/**
 * Extract the tool name from a `type:"tool_response"` segment's content
 * (`"<toolName> responded with size <n>"`, WIRE-PROTOCOL §4e) — the reliable
 * signal for attributing an earlier blob in a fused `type:"tool"` segment (see
 * `parseToolCall`'s `fusedArgs`) to its real tool name: responses echo back in
 * the SAME order the tools were called server-side (live-verified). PURE,
 * never throws. Returns `null` for anything that doesn't match.
 * @param {ConverseSegment|undefined} seg
 * @returns {string|null}
 */
export function parseToolResponseName(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'tool_response') return null;
  const content = typeof seg.content === 'string' ? seg.content : '';
  const m = /^(\S+)\s+responded\b/.exec(content.trim());
  return m ? m[1] : null;
}

/**
 * Collect a converse stream into a plain `{ text, threadId, messageId,
 * segments, experiences }` result — the headless-text convenience the CLI
 * tools' `converse-pretty` provides. `experiences` groups any `unisphere-tool`
 * segments by wire `runtimeName` for GenUI rendering.
 *
 * `text` accumulates the brain's SPOKEN/visible prose. On a text-only intellect
 * that is the `text` type; on an avatar-enabled intellect (`avatar:'on'`) the
 * spoken content streams as `avatar` (and `avatar-filler`) segments instead
 * (WIRE-PROTOCOL §4e), so those are accumulated too. Control/structured types
 * (`think`/`tool`/`unisphere-tool`/`share`/`thread`) are never added to `text`.
 *
 * ADDITIVE fields (back-compat: the original `{text,threadId,messageId,
 * segments,experiences}` shape is unchanged for existing callers):
 * - `experiencesList` — flat array of the `unisphere-tool` segments in arrival
 *   order (the same objects grouped under `experiences`), for callers that want
 *   a stream rather than a by-runtime map.
 * - `kindCounts` — `{spoken,control,experience,error}` tally via `segmentKind`.
 * - `toolCalls` — flat array of `{name,args,raw}` for every `type:"tool"`
 *   segment ({@link parseToolCall}), in arrival order. This is the headless
 *   peer of `session.on('toolCall')` — read it to act on client-side commands
 *   (e.g. `navigate_to_slide`) a non-avatar / SSE turn emitted.
 * - `toolCallsInvalid` — flat array of `{call, errors}` for a call whose `args`
 *   failed the schema supplied via `opts.toolArgSchemas[call.name]` ({@link
 *   validateToolArgs}, issue #24) — held OUT of `toolCalls` (a caller acting on
 *   `toolCalls` never sees an invalid call) so the headless path gets the same
 *   dispatch-time guard the live session's `onToolCall(name, handler, argsSchema)`
 *   applies. Empty when no schema is supplied (opt-in, no behavior change).
 * - `_meta` — provenance receipt (`meta()`); source `sdk/core/stream`, scope
 *   `converse-stream (client-collected)`.
 * TOOL-SPIRAL GUARD (W6): a tool-eager brain can loop the SAME client command dozens of
 * times in one turn (e.g. re-emitting `show_widget` 25× — a real, observed runaway). Left
 * unbounded the collector would consume the whole spiral and block to the request timeout.
 * `collectConverse` therefore DEDUPES identical calls (by name + {@link canonicalJson} of
 * `args`, matching the live session's `_dispatchToolCall` — an LLM retry of the identical
 * logical call can arrive with non-deterministic JSON key order, which raw-string dedup would
 * fail to catch, issue #18), CAPS how many times any one tool name is collected (`maxPerTool`),
 * and STOPS reading the stream once a spiral threshold is crossed (`maxToolCalls`) — returning
 * the good content already gathered + `spiralStopped:true` so the turn yields the valid first
 * widget instead of a timeout. Pass `{maxToolCalls:Infinity}` to disable (raw collection).
 * SEGMENT CAP: a pathological stream could emit an arbitrarily large number of non-tool segments
 * (text, control, etc.), growing `segments` without bound. `maxSegments` (default 2000) caps the
 * total collected; once reached the loop breaks and the result carries `truncated:true`.
 *
 * @param {AsyncIterable<ConverseSegment>} segments
 * @param {object} [opts]
 * @param {number} [opts.maxToolCalls]  Maximum total `type:"tool"` segments before the spiral backstop fires (default 8). Pass `Infinity` to disable.
 * @param {number} [opts.maxPerTool]    Maximum times any single tool name is collected (default 3). Duplicates beyond this are dropped.
 * @param {number} [opts.maxSegments]   Maximum total segments collected before the loop breaks with `truncated:true` (default 2000).
 * @param {Record<string, Record<string, ToolArgSchema>>} [opts.toolArgSchemas]  Optional per-tool-name arg schema map ({@link validateToolArgs}, issue #24) — a call whose `args` fails its schema is diverted to `toolCallsInvalid` instead of `toolCalls`. No entry for a name → no check (opt-in).
 */
export async function collectConverse(segments, opts = {}) {
  // Accept a positive number OR Infinity (disable); fall back to the default otherwise.
  const lim = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const maxToolCalls = lim(opts.maxToolCalls, 8);
  const maxPerTool = lim(opts.maxPerTool, 3);
  const maxSegments = lim(opts.maxSegments, 2000);
  const toolArgSchemas = opts.toolArgSchemas && typeof opts.toolArgSchemas === 'object' ? opts.toolArgSchemas : null;
  let text = '';
  let threadId, messageId;
  /** @type {ConverseSegment[]} */ const all = [];
  /** @type {Record<string, ConverseSegment[]>} */ const experiences = {};
  /** @type {ConverseSegment[]} */ const experiencesList = [];
  /** @type {ToolCall[]} */ const toolCalls = [];
  /** @type {{call:ToolCall, errors:string[]}[]} */ const toolCallsInvalid = [];
  const kindCounts = { spoken: 0, control: 0, experience: 0, error: 0 };
  const seenKeys = new Set();
  const perTool = Object.create(null);
  let rawToolSegments = 0;   // total type:"tool" segments seen (incl. dropped dupes) — spiral signal
  let spiralStopped = false;
  let truncated = false;
  for await (const s of segments) {
    if (all.length >= maxSegments) {
      truncated = true;
      break;
    }
    all.push(s);
    kindCounts[segmentKind(s)]++;
    if (s.threadId && !threadId) threadId = s.threadId;
    if (s.messageId && !messageId) messageId = s.messageId;
    if (s.type && SPOKEN_TYPES.has(s.type) && s.content) text += s.content;
    if (s.type === 'unisphere-tool') {
      const rt = s.metadata?.runtimeName || 'unknown';
      (experiences[rt] ||= []).push(s);
      experiencesList.push(s);
    }
    const call = parseToolCall(s);
    if (call) {
      rawToolSegments++;
      const check = toolArgSchemas ? validateToolArgs(call.args, toolArgSchemas[call.name]) : { ok: true };
      if (!check.ok) {
        toolCallsInvalid.push({ call, errors: check.errors });
        // Spiral backstop: total type:"tool" segments (valid + invalid + dup + over-cap)
        // reached the threshold → stop reading. Checked on raw count alone (NOT gated on
        // whether anything was actually dropped) — a run of N+1 unique, valid, under-cap
        // calls must still stop at N, since toolCalls.length tracking rawToolSegments 1:1
        // would otherwise mean the guard never fires (issue: undocumented no-op for the
        // all-unique-valid case).
        if (rawToolSegments >= maxToolCalls) { spiralStopped = true; break; }
        continue;
      }
      const key = `${call.name}:${canonicalJson(call.args || {})}`;
      const dup = seenKeys.has(key);
      const overCap = (perTool[call.name] || 0) >= maxPerTool;
      if (!dup && !overCap) {
        seenKeys.add(key);
        perTool[call.name] = (perTool[call.name] || 0) + 1;
        toolCalls.push(call);
      }
      // Spiral backstop: too many tool segments this turn → stop reading (we have the good ones).
      if (rawToolSegments >= maxToolCalls) {
        spiralStopped = true;
        break;
      }
    }
  }
  return {
    text: text.trim(),
    threadId,
    messageId,
    segments: all,
    experiences,
    experiencesList,
    toolCalls,
    toolCallsInvalid,
    kindCounts,
    spiralStopped,
    truncated,
    _meta: meta({ source: 'sdk/core/stream', scope: 'converse-stream (client-collected)' }),
  };
}
