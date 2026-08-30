/**
 * Conversation plane (Genie): headless converse, threads, messages, feedback,
 * followups, knowledge search, and partner analytics. The conversation/converse
 * paths need a CONVERSATION token (`geniegpcid:<configId>`, entitlement ON);
 * thread/message/report management use an admin token. Source:
 * tools/genie.mjs + API-REFERENCE §4.
 */
import { parseConverseStream, collectConverse, SPIRAL_RECOVERY_PREFIX } from '../core/stream.js';
import { paginate } from './paginate.js';
import { meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';
import { EXPERIENCES } from '../experience/wire.js';   // single source of truth for force_experience values
import { validateCapabilities, mergeCapabilityWrite } from './capabilities.js';
import { buildIndexerObjects } from '../core/knowledge-enums.js';
import { stripServerManaged } from './intellect-body.js';
import { newFormData as sharedNewFormData } from './catalog.js';
import { classifyPartnerConfigError, probePartnerConfigRoute } from './partner-config-probe.js';

// NOTE: unlike GENIE_MESSAGE_FILTER, the thread filter's objectType has no "Genie" prefix —
// 'GenieListThreadFilter' 422s with "Input should be 'ListThreadFilter'".
const GENIE_THREAD_FILTER = 'ListThreadFilter';
const GENIE_MESSAGE_FILTER = 'GenieListMessageFilter';

// Status/type scope for a knowledge-category media listing — shared by
// Knowledge#list and Knowledge#corpusStatus so the two entry-count queries
// (list + count-only) always agree on what "in the knowledge base" means.
const KNOWLEDGE_ENTRY_STATUS_TYPE_FILTER = { statusIn: '-1,-2,0,1,2,7,4', typeIn: '1,7,10' };

// categoryEntry is unique per (categoryId, entryId), and the transport retries
// transient failures (429/502/503/504/network — see core/http.js). A retry can
// re-run a categoryentry.add the server already applied; Kaltura then reports
// CATEGORY_ENTRY_ALREADY_EXISTS ("Entry already assigned to this category").
// The link exists — that's the outcome the caller asked for, not a failure.
// Live-hit: two consecutive corpus re-uploads (16 docs, ~130 chunks) died
// mid-run on exactly this before it was tolerated.
const isDuplicateCategoryEntry = (e) => e?.code === 'CATEGORY_ENTRY_ALREADY_EXISTS' || /already assigned to this category/i.test(e?.message || '');

// Re-exported for back-compat — existing callers import this from here. Canonical
// definition now lives in core/stream.js so KalturaAvatarSession's live-socket spiral
// recovery (session.js) can share the exact same literal without a management→experience
// or experience→management cross-import.
export { SPIRAL_RECOVERY_PREFIX };

/**
 * Reserved `request_vars` keys the brain injects itself (`sys__*`) plus the
 * `secrets` namespace — a caller-supplied value here would either be ignored or
 * collide with a server-managed variable, so the SDK rejects them BEFORE the
 * network call.
 * @type {readonly string[]}
 */
export const RESERVED_VARS = Object.freeze([
  'sys__thread_id', 'sys__message_id', 'sys__user_id', 'sys__user_message', 'secrets',
]);

/**
 * Validate a per-turn `request_vars` map (the `{{ X }}` Jinja interpolation
 * payload). PURE — no network. Rejects, with a typed `KalturaError`
 * (`code:'validation_error'`), BEFORE any wire call:
 *
 *  - a non-object / array payload;
 *  - any {@link RESERVED_VARS} collision (`sys__*` or `secrets`);
 *  - any non-scalar value (only string/number/boolean/null interpolate cleanly;
 *    an object/array would be stringified or dropped server-side).
 *
 * Returns the map unchanged for chaining. `undefined`/`null` (no vars) is a
 * no-op pass — `request_vars` is optional.
 * @param {unknown} vars
 * @param {string} [where]
 * @returns {Record<string, string|number|boolean|null>|undefined}
 */
export function assertRequestVars(vars, where = 'request_vars') {
  if (vars === undefined || vars === null) return undefined;
  if (typeof vars !== 'object' || Array.isArray(vars)) {
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/validation_error', title: 'invalid request_vars',
      code: 'validation_error', detail: `${where}: expected an object of {name: scalar}, got ${Array.isArray(vars) ? 'array' : typeof vars}.`,
    });
  }
  for (const [name, value] of Object.entries(vars)) {
    if (RESERVED_VARS.includes(name)) {
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/validation_error', title: 'reserved request_vars key',
        code: 'validation_error', detail: `${where}: "${name}" is reserved (server-managed). Reserved keys: ${RESERVED_VARS.join(', ')}.`,
      });
    }
    if (value !== null && typeof value === 'object') {
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/validation_error', title: 'non-scalar request_vars value',
        code: 'validation_error', detail: `${where}.${name}: values must be scalar (string/number/boolean/null), got ${Array.isArray(value) ? 'array' : 'object'} — only scalars interpolate into {{ ${name} }}.`,
      });
    }
  }
  return /** @type {Record<string, string|number|boolean|null>} */ (vars);
}

// ─────────────────────────── Converse (headless text) ───────────────────────────

export class Conversations {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Send a message and stream the response as an async iterator of segments.
   * WRITE — appends to thread memory. Needs a CONVERSATION token
   * (`geniegpcid:<configId>`). HTTP converse is HEADLESS TEXT ONLY — it never
   * reaches the live speech engine (use {@link KalturaAvatarSession.speak} for
   * the avatar).
   *
   * ⚠️ VALIDATION TIMING — this is an async `*generator`, so NOTHING in its body
   * runs until you iterate. The scope guard (`assertConversation`) and every
   * pre-network validator (force_experience / request_vars / capabilities) fire
   * on the FIRST `.next()` / `for await`, NOT at call time. So
   * `const g = k.conversations.stream(opts, adminKs)` with an admin token gets NO
   * guard until iteration — despite the client surface describing the guard as
   * running "before any network call". For EAGER validation (e.g. to reject a
   * wrong-scope token or a typo'd capability up front), use {@link send} /
   * {@link Conversations#status} which validate synchronously inside an async
   * method, or simply begin iterating.
   *
   * `capabilities` is a validated PER-MESSAGE override (`{name:state}`), layered
   * over the stored config for this turn only. The server-side DISABLED veto
   * still WINS: a capability stored/env-`disabled` cannot be turned on per
   * message (mirrors {@link resolveCapabilities}). Use it to turn an enabled-but-
   * off capability on for one turn — not to bypass a veto.
   *
   * @example <caption>Turn web search on for ONE message (loses to a stored disabled veto)</caption>
   * const reply = await k.conversations.send(
   *   { userMessage: 'What shipped this week in the news?', capabilities: { use_web_search: 'on' } },
   *   convKs,  // geniegpcid:<configId> — NOT an admin token
   * );
   * console.log(reply.text);
   *
   * @param {object} opts {userMessage, threadId?, sse?, model_type?, force_experience?, request_vars?, capabilities?, signal?}
   *   `force_experience` must be one of EXPERIENCES (markdown|summarization|flashcards|avatar_only); anything else 422s.
   *   `capabilities` is a per-message `{name:state}` override (validated pre-network); the stored DISABLED veto still wins.
   *   `signal` (optional `AbortSignal`) lets the caller cancel a stalled or unbounded-length
   *   stream — this call has no built-in timeout of its own (see `genieStream` in client.js), so
   *   a caller racing this against its own timeout MUST abort this signal when that timeout
   *   fires, or the underlying connection (and this generator's `for await` loop) keeps running
   *   detached, holding the socket open indefinitely.
   * @param {import('./client.js').KsLike} ks conversation token
   * @returns {AsyncGenerator<import('../core/stream.js').ConverseSegment>}
   */
  async *stream(opts, ks) {
    this._.assertConversation(ks, 'conversations.stream');
    // Validate force_experience BEFORE the network call — the brain 422s on a bad value and
    // the SDK should fail fast with a clear, typed error (not a buried server_error).
    if (opts.force_experience !== undefined && opts.force_experience !== null && !EXPERIENCES.includes(opts.force_experience)) {
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/validation_error', title: 'invalid force_experience', code: 'validation_error', detail: `force_experience must be one of: ${EXPERIENCES.join(', ')} (got "${opts.force_experience}").` });
    }
    // Validate request_vars (reserved-key collisions + non-scalar values) BEFORE the
    // network call — the brain silently drops/ignores these, so fail fast & typed.
    assertRequestVars(opts.request_vars, 'conversations.stream.request_vars');
    // Validate the per-message capabilities override (every key a known capability,
    // every value on/off/disabled). The server-side DISABLED veto still wins at
    // runtime; this just rejects typos before the wire.
    if (opts.capabilities !== undefined) validateCapabilities(opts.capabilities, 'conversations.stream.capabilities');
    const body = { userMessage: opts.userMessage, sse: opts.sse ?? false };
    // model_type stays lowercase ('fast'); OMIT for the primary model — there is no 'DEFAULT'
    // literal (API-REFERENCE §4.1). Passed through verbatim, no normalization.
    for (const k of ['threadId', 'model_type', 'force_experience', 'request_vars', 'capabilities']) {
      if (opts[k] !== undefined) body[k] = opts[k];
    }
    let stream;
    try {
      stream = await this._.genieStream('assistant/converse', body, ks, { signal: opts.signal });
    } catch (e) {
      throw remapConverseError(e);
    }
    yield* parseConverseStream(stream, { sse: body.sse });
  }

  /**
   * Send a message and collect the assembled reply: `{text, threadId,
   * messageId, segments, experiences}`. WRITE. Convenience over {@link stream}
   * that DRAINS the generator, so the scope guard + pre-network validators fire
   * eagerly within this awaited call — prefer this (or iterate `stream` yourself)
   * when you want a wrong-scope token or a bad option rejected up front rather
   * than on first iteration.
   *
   * SPIRAL RECOVERY (opt-in, `opts.recoverFromSpiral:true`): `collectConverse`'s
   * spiral backstop (`spiralStopped:true`) can still leave `text:""` — the brain
   * looped a tool call so many times that it never reached a spoken sentence, so
   * there is nothing to fall back to in the SAME turn (the good content it
   * already gathered IS the tool calls; there's no spoken text hiding later in
   * the stream — `collectConverse` stopped reading precisely because the raw
   * segment budget was exhausted). Observed in production:
   * a two-metric guidance question made the brain re-emit an already-successful
   * `show_widget` call 8+ times with zero spoken segments ever produced, even
   * after fixing the tool's arg schema (str→dict) to remove double-JSON-encoding
   * — confirmed via a direct, uncapped stream read (150+ segments, 90s, still
   * zero spoken output): the loop would not have resolved on its own no matter
   * how long the caller waited. HTTP converse has no live-socket `interrupt()` to
   * fall back on (that's `KalturaAvatarSession`'s recovery, a different runtime),
   * so the only proven lever is a follow-up turn: a same-
   * thread nudge message reliably breaks the loop and gets a real spoken answer.
   * When `recoverFromSpiral` is on and the first attempt comes back
   * `spiralStopped:true` with empty `text`, this sends ONE follow-up turn on the
   * same thread wrapping the original `userMessage` in an explicit "answer in
   * words, no tool calls" instruction, and returns THAT result with
   * `spiralRecovered:true` added (`firstAttempt` carries the discarded empty
   * attempt's `toolCalls`/`spiralStopped` for diagnostics). Never retries more
   * than once — if the nudge turn also comes back empty, that result is returned
   * as-is with `spiralRecovered:false`. Off by default (back-compat): a caller
   * that wants raw `spiralStopped` visibility unchanged sees no new behavior.
   * @param {object} opts {userMessage, threadId?, sse?, model_type?, force_experience?, request_vars?, capabilities?, recoverFromSpiral?}
   * @param {import('./client.js').KsLike} ks conversation token (`geniegpcid:<configId>`)
   * @returns {Promise<{text:string, threadId:string, messageId:string, segments:object[], toolCalls:object[], experiences:Record<string,object[]>, experiencesList:object[], kindCounts:object, spiralStopped:boolean, truncated:boolean, spiralRecovered?:boolean, firstAttempt?:object, _meta:object}>}
   */
  async send(opts, ks) {
    const first = await collectConverse(this.stream(opts, ks));
    if (!opts.recoverFromSpiral || !first.spiralStopped || first.text) return first;
    const nudgeOpts = { ...opts, threadId: first.threadId || opts.threadId, userMessage: `${SPIRAL_RECOVERY_PREFIX}${opts.userMessage}` };
    delete nudgeOpts.recoverFromSpiral;
    const retry = await collectConverse(this.stream(nudgeOpts, ks));
    return { ...retry, spiralRecovered: !(retry.spiralStopped && !retry.text), firstAttempt: { toolCalls: first.toolCalls, spiralStopped: first.spiralStopped } };
  }

  /** Assistant status/consent/avatar config. READ (GET). @param {string} ks conversation token */
  async status(ks) {
    this._.assertConversation(ks, 'conversations.status');
    return (await this._.genieGet('assistant/status', ks)).data;
  }

}

// ─────────────────────────── Threads ───────────────────────────

export class Threads {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /** List threads. READ. objectType is mandatory (sent automatically). @param {string} ks @param {{pageSize?:number}} [opts] */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'threads.list');
    return paginate({
      style: 'index', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.genie('v1/thread/list', { filter: { objectType: GENIE_THREAD_FILTER }, pager }, ks).then((r) => r.data),
    });
  }

  /** Get a thread. READ. @param {string} id @param {string} ks */
  async get(id, ks) {
    this._.assertAdmin(ks, 'threads.get');
    return (await this._.genie('v1/thread/get', { id }, ks)).data;
  }

  /** Flattened `human:/ai:` transcript of one thread. READ. @param {string} id @param {string} ks */
  async transcript(id, ks) {
    this._.assertAdmin(ks, 'threads.transcript');
    return (await this._.genie('v1/thread/get_transcripts', { id }, ks)).data;
  }

  /** Rename a thread. WRITE — idempotent for a given title. @param {string} id @param {string} title @param {string} ks */
  async rename(id, title, ks) {
    this._.assertAdmin(ks, 'threads.rename');
    return (await this._.genie('v1/thread/update', { id, title }, ks)).data;
  }

  /**
   * Delete threads. WRITE — DESTRUCTIVE. This is the GDPR/CCPA deletion path for
   * conversation PII (it removes the thread; the SDK does not claim it satisfies
   * full Art. 17 anonymization — see API-REFERENCE.md, "Delete returns" note under Threads). Takes a plural array.
   * @param {string[]} threadIds @param {string} ks @param {{confirmPermanent:boolean}} confirm
   */
  async delete(threadIds, ks, confirm) {
    this._.assertAdmin(ks, 'threads.delete');
    const ids = Array.isArray(threadIds) ? threadIds : [threadIds];
    requireConfirm(confirm, 'threads.delete', ids.join(','));
    return (await this._.genie('v1/thread/delete', { thread_ids: ids }, ks)).data;
  }
}

// ─────────────────────────── Messages + analytics ───────────────────────────

export class Messages {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /** List messages (optionally for one thread). READ. objectType mandatory (auto). @param {string} ks @param {{threadId?:string,pageSize?:number}} [opts] */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'messages.list');
    const filter = { objectType: GENIE_MESSAGE_FILTER };
    if (opts.threadId) filter.threadIdEquals = opts.threadId;
    return paginate({
      style: 'index', pageSize: opts.pageSize ?? 50,
      fetchPage: (pager) => this._.genie('message/list', { filter, pager }, ks).then((r) => r.data),
    });
  }

  /** Clone a message under a new title for sharing. WRITE — NOT idempotent. Returns `{newMessageId}`. @param {string} id @param {string} newTitle @param {string} ks */
  async share(id, newTitle, ks) {
    this._.assertAdmin(ks, 'messages.share');
    return (await this._.genie('message/share', { id, newTitle }, ks)).data;
  }

  /**
   * Raw partner conversation report as CSV. READ. ⚠️ SENSITIVE — contains
   * end-user ids/names + verbatim question/feedback text. Treat as PII; scope
   * and redact before sharing.
   * @param {string} ks @param {{pageSize?:number}} [opts]
   */
  async report(ks, opts = {}) {
    this._.assertAdmin(ks, 'messages.report');
    const body = { filter: { objectType: GENIE_MESSAGE_FILTER } };
    if (opts.pageSize) body.pager = { pageIndex: 1, pageSize: opts.pageSize };
    return (await this._.genie('message/report', body, ks)).data;
  }

  /**
   * Parsed analytics summary with a `_meta` provenance receipt
   * ({generatedAt,partnerId,source,scope}). READ. `topQuestions` contain
   * user-entered text (treat as PII).
   * @param {string} ks @param {{pageSize?:number}} [opts]
   */
  async reportSummary(ks, opts = {}) {
    const csv = await this.report(ks, { pageSize: opts.pageSize ?? 1000 });
    if (typeof csv !== 'string') {
      throw new KalturaError({ type: 'about:blank', title: 'report not CSV', code: 'server_error', detail: 'message/report did not return CSV (likely an error body).', body: csv });
    }
    return summarizeReport(csv, this._.partnerId);
  }
}

export class Feedback {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Rate a message. WRITE — idempotent for a (message_id,is_positive) pair.
   * @param {object} opts {message_id, is_positive, comment?}
   * @param {string} ks
   */
  async add(opts, ks) {
    this._.assertAny(ks, 'feedback.add');
    const data = { is_positive: !!opts.is_positive, message_id: opts.message_id };
    if (opts.comment) data.comment = opts.comment;
    return (await this._.genie('feedback/add', { schemaVersion: 1, data }, ks)).data;
  }
}

export class Followups {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Pre-configured STARTER questions for the partner/agent. READ. Empty body,
   * NOT thread-scoped; returns `[]` when none configured. (Per-answer followups
   * are a different feature — set capabilities.generate_followup_questions:on on
   * converse.)
   * @param {string} ks
   */
  async getSuggested(ks) {
    this._.assertAny(ks, 'followups.getSuggested');
    const r = (await this._.genie('followup/get-suggested-questions?new_response=true', {}, ks)).data;
    return Array.isArray(r?.data) ? r.data : (r?.data?.questions || r?.questions || []);
  }
}

/**
 * Knowledge base — an agent's "knowledge" is a set of Knowledge records linked
 * via `knowledge_ids[]` on the intellect DTO + `capabilities.
 * use_knowledge_base:"on"`; the brain then does RAG over the indexed content.
 *
 * "Add a file to the agent's brain" = ingest a Kaltura entry and assign it
 * (`categoryEntry.add`) to that category — all standard public media APIs.
 *
 * SCOPE (honest, verified): the SDK can upload + attach entries, list them,
 * detach them, read the linked knowledge record IDs, and toggle
 * `use_knowledge_base`. It CANNOT create or repoint the `config.knowledgeBase`
 * category linkage — `v1/intellect/update` rejects it, and the only other write
 * door (`partner-config/update`) is deployment-gated (see API-REFERENCE.md §
 * Ground the Agent). So knowledge
 * management works on agents that ALREADY have a knowledge record linked
 * (read it via `knowledge.getLinkage(id).knowledgeIds`).
 */
/** @param {unknown} v @param {string} where */
function requireRecordId(v, where) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-negative integer (the Knowledge record's id).` });
  }
}

/** @param {unknown} a @param {unknown} b Exact deep-equality for plain JSON values (no Date/Map/etc). */
function sourcesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => sourcesEqual(a[k], b[k]));
}

/**
 * Find every intellect whose `knowledge_ids` still references `knowledgeId`.
 * READ-only, paginated scan — same shape as `findIntellectsReferencingTool`
 * (tools.js) / the skills.js equivalent, swapped to the `knowledge_ids` field.
 * @param {import('./client.js').Ctx} ctx @param {number} knowledgeId @param {string} ks
 * @returns {Promise<number[]>}
 */
export async function findIntellectsReferencingKnowledge(ctx, knowledgeId, ks) {
  const refs = [];
  const pageSize = 50;
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = (await ctx.genie('v1/intellect/list', { filter: {}, pager: { pageIndex, pageSize } }, ks)).data;
    const objects = Array.isArray(page?.objects) ? page.objects : [];
    for (const item of objects) {
      if (item?.id === undefined) continue;
      const full = await ctx.genie('v1/intellect/get', { id: item.id }, ks).then((r) => r.data).catch(() => null);
      if (Array.isArray(full?.knowledge_ids) && full.knowledge_ids.includes(knowledgeId)) refs.push(item.id);
    }
    const total = page?.totalCount;
    if (objects.length === 0 || (typeof total === 'number' && pageIndex * pageSize >= total)) break;
  }
  return refs;
}

export class Knowledge {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * MCP knowledge-base search (RAG query). READ. On an empty/unindexed KB, an
   * indexed KB with `use_knowledge_base:'off'`, or a genuine no-match query,
   * the backend replies the same `{status:'error', data:"…couldn't find
   * relevant information…"}` (returned as-is, not thrown) — so this can't
   * tell those cases apart. Use {@link isIndexed} for indexing status instead.
   * @param {string} query @param {string} ks
   */
  async search(query, ks) {
    this._.assertAny(ks, 'knowledge.search');
    return (await this._.genie('mcp/search', { query }, ks)).data;
  }

  /**
   * Read the knowledge record linkage for an intellect: its `knowledge_ids[]`
   * + whether `use_knowledge_base` is on. READ.
   * @param {number} configId @param {string} ks (admin)
   * @returns {Promise<{knowledgeIds:number[], enabled:boolean}>}
   */
  async getLinkage(configId, ks) {
    this._.assertAdmin(ks, 'knowledge.getLinkage');
    const data = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    const knowledgeIds = Array.isArray(data.knowledge_ids)
      ? data.knowledge_ids.map(Number).filter((n) => Number.isFinite(n))
      : [];
    return {
      knowledgeIds,
      enabled: data.capabilities?.use_knowledge_base === 'on',
    };
  }

  /**
   * Turn RAG over the knowledge base on/off for an intellect. WRITE — idempotent.
   *
   * MECHANISM (corrected): `v1/intellect/update` is a `model_fields_set` PATCH —
   * it PRESERVES omitted top-level fields (it does NOT "replace the intellect").
   * The genuine hazard is that `capabilities` is a **full-replace sub-dict**: a
   * partial `capabilities` dict DROPS the sibling capabilities it omits. So this
   * read-merge-writes the capabilities dict specifically (via
   * {@link mergeCapabilityWrite}), flipping only `use_knowledge_base`, and
   * re-asserts `{id,type,status}`. We still re-send the rest of the current
   * config defensively (matching `IntellectConfig.patch()`'s convention), but the
   * load-bearing reason is the dict full-replace, not a top-level wipe.
   * @param {number} configId @param {boolean} enabled @param {string} ks
   */
  async setEnabled(configId, enabled, ks) {
    this._.assertAdmin(ks, 'knowledge.setEnabled');
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    const body = {
      ...stripServerManaged(cur, configId),
      // capabilities is a full-replace sub-dict — merge the patch over the stored
      // dict so sibling capabilities survive (shared with Intellects.setCapability).
      capabilities: mergeCapabilityWrite(cur.capabilities, { use_knowledge_base: enabled ? 'on' : 'off' }),
    };
    return (await this._.genie('v1/intellect/update', body, ks)).data;
  }

  /**
   * List the media entries currently in a knowledge category (the agent's
   * documents/videos). READ. @param {number} categoryId @param {string} ks (admin) @param {{pageSize?:number}} [opts]
   */
  list(categoryId, ks, opts = {}) {
    this._.assertAdmin(ks, 'knowledge.list');
    return paginate({
      style: 'index', pageSize: opts.pageSize ?? 30,
      fetchPage: async (pager) => {
        // `style: 'index'` above means paginate.js always hands this an IndexPager at
        // runtime — the cast just narrows off the OffsetPager half of its shared union type.
        const idxPager = /** @type {import('./paginate.js').IndexPager} */ (pager);
        const filter = { objectType: 'KalturaBaseEntryFilter', categoryAncestorIdIn: String(categoryId), orderBy: '-createdAt', ...KNOWLEDGE_ENTRY_STATUS_TYPE_FILTER };
        const res = await this._.ovp('baseentry', 'list', { filter, pager: { objectType: 'KalturaFilterPager', pageSize: idxPager.pageSize, pageIndex: idxPager.pageIndex } }, ks);
        return { objects: res?.objects || [], totalCount: res?.totalCount };
      },
    });
  }

  /**
   * Upload a document/video file into a knowledge category — the brain will use
   * it for RAG. WRITE — NOT idempotent. Mirrors the Kaltura Knowledge-tab flow
   * exactly: baseentry.add (document) → uploadtoken.add → upload bytes →
   * document.addContent → categoryEntry.add(categoryId). Returns `{entryId, categoryId}`.
   * @param {object} opts
   * @param {Blob|File} opts.file
   * @param {string} opts.name
   * @param {number} opts.categoryId   The agent's knowledge category (from {@link getLinkage}).
   * @param {string} ks (admin)
   */
  async uploadDocument(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.uploadDocument');
    if (!opts?.file) throw new KalturaError({ type: 'about:blank', title: 'file required', code: 'bad_request', detail: 'knowledge.uploadDocument needs a file.' });
    if (!opts.categoryId) throw new KalturaError({ type: 'about:blank', title: 'categoryId required', code: 'bad_request', detail: 'Pass the agent knowledge categoryId (knowledge.getLinkage).' });
    // 1) create document entry + upload token (multirequest)
    const created = await this._.ovpMulti([
      { service: 'baseentry', action: 'add', entry: { objectType: 'KalturaDocumentEntry', name: opts.name, type: '10', documentType: 11 } },
      { service: 'uploadtoken', action: 'add', uploadToken: { objectType: 'KalturaUploadToken', fileName: opts.name } },
    ], ks);
    const entryId = created?.[0]?.id;
    const tokenId = created?.[1]?.id;
    if (!entryId || !tokenId) throw new KalturaError({ type: 'about:blank', title: 'knowledge upload init failed', code: 'server_error', detail: 'baseentry/uploadtoken add returned no ids', body: created });
    // 2) upload the bytes to the token (multipart to uploadtoken/upload)
    const fd = newFormData();
    fd.append('fileData', opts.file, opts.name);
    await this._.ovpUpload(tokenId, fd, ks);
    // 3) attach content + assign to the knowledge category (multirequest)
    const done = await this._.ovpMulti([
      { service: 'document_documents', action: 'addContent', entryId, resource: { objectType: 'KalturaUploadedFileTokenResource', token: tokenId } },
      { service: 'categoryentry', action: 'add', categoryEntry: { objectType: 'KalturaCategoryEntry', categoryId: opts.categoryId, entryId } },
    ], ks);
    const doneErr = Array.isArray(done)
      ? done.find((r) => r?.objectType === 'KalturaAPIException' && !isDuplicateCategoryEntry(r))
      : (done?.objectType === 'KalturaAPIException' ? done : null);
    if (doneErr) throw new KalturaError({ type: 'about:blank', title: doneErr.code, code: 'ovp_error', detail: doneErr.message, body: doneErr });
    return { entryId, categoryId: opts.categoryId };
  }

  /**
   * Upload markdown text into a knowledge category by attaching a
   * KalturaMarkdownAsset directly. WRITE — NOT idempotent. The indexer only
   * scans an entry's ATTACHMENT assets for a `markdown.markdown` asset, never
   * an entry's own primary content — a raw `.md` set as an entry's content
   * (via {@link uploadDocument}'s path) is invisible to it, and the backend's
   * async PDF→markdown-attachment conversion only fires for PDF entries. This
   * method skips both: it creates the backing entry (kept in sync for
   * browsability), then attaches the SAME markdown as its own
   * `KalturaMarkdownAsset` via a second, independent upload token — the thing
   * the indexer actually indexes. Returns `{entryId, categoryId, markdownAssetId}`.
   * @param {object} opts
   * @param {string} opts.markdown
   * @param {string} opts.name
   * @param {number} opts.categoryId   The agent's knowledge category (from {@link getLinkage}).
   * @param {string} ks (admin)
   */
  async uploadMarkdown(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.uploadMarkdown');
    if (!opts?.markdown) throw new KalturaError({ type: 'about:blank', title: 'markdown required', code: 'bad_request', detail: 'knowledge.uploadMarkdown needs a { markdown } string.' });
    if (!opts.categoryId) throw new KalturaError({ type: 'about:blank', title: 'categoryId required', code: 'bad_request', detail: 'Pass the agent knowledge categoryId (knowledge.getLinkage).' });
    const name = opts.name || 'document.md';
    // 1) backing document entry + its own upload token (multirequest)
    const created = await this._.ovpMulti([
      { service: 'baseentry', action: 'add', entry: { objectType: 'KalturaDocumentEntry', name, type: '10', documentType: 11 } },
      { service: 'uploadtoken', action: 'add', uploadToken: { objectType: 'KalturaUploadToken', fileName: name } },
    ], ks);
    const entryId = created?.[0]?.id;
    const entryTokenId = created?.[1]?.id;
    if (!entryId || !entryTokenId) throw new KalturaError({ type: 'about:blank', title: 'markdown upload init failed', code: 'server_error', detail: 'baseentry/uploadtoken add returned no ids', body: created });
    const entryFd = newFormData();
    entryFd.append('fileData', new Blob([opts.markdown], { type: 'text/markdown' }), name);
    await this._.ovpUpload(entryTokenId, entryFd, ks);
    // 2) attach content to the entry + assign to the knowledge category (multirequest)
    const linked = await this._.ovpMulti([
      { service: 'baseentry', action: 'updateContent', entryId, resource: { objectType: 'KalturaUploadedFileTokenResource', token: entryTokenId } },
      { service: 'categoryentry', action: 'add', categoryEntry: { objectType: 'KalturaCategoryEntry', categoryId: opts.categoryId, entryId } },
    ], ks);
    const linkErr = (linked || []).find((r) => r?.objectType === 'KalturaAPIException' && !isDuplicateCategoryEntry(r));
    if (linkErr) throw new KalturaError({ type: 'about:blank', title: linkErr.code, code: 'ovp_error', detail: linkErr.message, body: linkErr });
    // 3) the thing the indexer actually scans for: a SEPARATE KalturaMarkdownAsset
    // attachment, uploaded via its own token — bypasses the backend's PDF
    // conversion pipeline entirely.
    const assetToken = await this._.ovp('uploadtoken', 'add', { uploadToken: { objectType: 'KalturaUploadToken', fileName: name } }, ks);
    const assetFd = newFormData();
    assetFd.append('fileData', new Blob([opts.markdown], { type: 'text/markdown' }), name);
    await this._.ovpUpload(assetToken.id, assetFd, ks);
    const asset = await this._.ovp('attachment_attachmentasset', 'add', {
      entryId, attachmentAsset: { objectType: 'KalturaMarkdownAsset', filename: name, fileExt: 'md', format: 5 },
    }, ks);
    await this._.ovp('attachment_attachmentasset', 'setContent', {
      id: asset.id, contentResource: { objectType: 'KalturaUploadedFileTokenResource', token: assetToken.id },
    }, ks);
    return { entryId, categoryId: opts.categoryId, markdownAssetId: asset.id };
  }

  /**
   * Attach an EXISTING Kaltura entry to a knowledge category. WRITE — idempotent
   * (categoryEntry is unique per pair; an already-linked pair resolves to the
   * link instead of throwing). @param {string} entryId @param {number} categoryId @param {string} ks (admin)
   */
  async attachEntry(entryId, categoryId, ks) {
    this._.assertAdmin(ks, 'knowledge.attachEntry');
    try {
      return await this._.ovp('categoryentry', 'add', { categoryEntry: { objectType: 'KalturaCategoryEntry', categoryId, entryId } }, ks);
    } catch (e) {
      if (isDuplicateCategoryEntry(e?.body)) return { objectType: 'KalturaCategoryEntry', categoryId, entryId };
      throw e;
    }
  }

  /**
   * Remove an entry from a knowledge category (the brain stops using it). WRITE
   * — DESTRUCTIVE of the link (not the entry). Requires confirmation.
   * @param {string} entryId @param {number} categoryId @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   */
  async detachEntry(entryId, categoryId, ks, confirm) {
    this._.assertAdmin(ks, 'knowledge.detachEntry');
    requireConfirm(confirm, 'knowledge.detachEntry', entryId);
    return this._.ovp('categoryentry', 'delete', { categoryId, entryId }, ks);
  }

  // ─── The category-LINKAGE write ───
  // TWO PATHS link knowledge to an intellect (both end at one partner-config row):
  //   PATH A (preferred, UNGATED): mint a Knowledge record with
  //     `addRecord()` (`POST /v1/knowledge/add`, requires admin KS), then pass its id as
  //     `knowledge_ids:[id]` to `intellects.create`/`add`/`update`. The create/update DTO
  //     accepts `knowledge_ids` directly, so linkage + `use_knowledge_base:on` persist with
  //     NO `partner-config/update` and NO gate. RAG retrieval works after async indexing.
  //   PATH B (this `linkCategory`, and `linkRecords`): re-point an EXISTING intellect via
  //     `POST /partner-config/update` (the agentic studio-intellect proxy does NOT
  //     accept it). `partner_config_update` MERGES set fields, so we send only
  //     `indexer`. NOTE: this route still returns 403 for a partner admin KS
  //     (it needs a higher/service privilege than a partner admin holds) — see API-REFERENCE.md § Ground the Agent. So Path B can't
  //     re-point on a partner KS today; use Path A for new agents. `linkAvailable()` probes
  //     Path B. (`/v1/knowledge/*` itself works — only the partner-config re-point is gated.)

  /**
   * Create a Kaltura CATEGORY to hold a knowledge corpus — the container that
   * `uploadDocument`/`attachEntry` assign entries to and `linkCategory` later
   * binds to an intellect. WRITE — **NOT idempotent** (a retry creates a SECOND
   * category with the same name, orphaning the first corpus — use
   * {@link findCategory}/{@link findOrCreateCategory} to dedupe). Routes through
   * OVP `category/add` at ADMIN scope — a real public endpoint that does NOT
   * violate the knowledge-linkage gate (which forbids writing the *intellect linkage* / activating
   * retrieval — which stays gated; creating the container does not).
   * Returns the new `{id, fullName, fullIds}`-bearing KalturaCategory.
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} [opts.parentId]      Parent category id (0/omitted = a root category).
   * @param {string} [opts.description]
   * @param {string} ks (admin)
   */
  async createCategory(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.createCategory');
    if (!opts?.name || typeof opts.name !== 'string') throw new KalturaError({ type: 'about:blank', title: 'name required', code: 'bad_request', detail: 'knowledge.createCategory needs a non-empty { name }.' });
    const category = { objectType: 'KalturaCategory', name: opts.name };
    if (opts.parentId !== undefined && opts.parentId !== null) category.parentId = opts.parentId;
    if (opts.description) category.description = opts.description;
    return this._.ovp('category', 'add', { category }, ks);
  }

  /**
   * Find an existing category by EXACT name (first match). READ. Returns the
   * KalturaCategory or `null`. Use with {@link createCategory} to avoid the
   * non-idempotent duplicate-corpus trap. @param {string} name @param {string} ks (admin)
   */
  async findCategory(name, ks) {
    this._.assertAdmin(ks, 'knowledge.findCategory');
    const res = await this._.ovp('category', 'list', { filter: { objectType: 'KalturaCategoryFilter', fullNameEqual: name }, pager: { objectType: 'KalturaFilterPager', pageSize: 1, pageIndex: 1 } }, ks);
    return res?.objects?.[0] || null;
  }

  /**
   * Idempotent create: return the category named `name` if it exists, else create
   * it. WRITE — idempotent on `name`. Wraps {@link findCategory}+{@link createCategory}.
   * @param {object} opts {name, parentId?, description?} @param {string} ks (admin)
   */
  async findOrCreateCategory(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.findOrCreateCategory');
    if (!opts?.name) throw new KalturaError({ type: 'about:blank', title: 'name required', code: 'bad_request', detail: 'knowledge.findOrCreateCategory needs { name }.' });
    const existing = await this.findCategory(opts.name, ks);
    if (existing) return existing;
    return this.createCategory(opts, ks);
  }

  /**
   * Link a knowledge CATEGORY to an intellect for RAG (the indexer linkage) and
   * turn `use_knowledge_base` on. WRITE — idempotent. GATED: routes through Genie
   * `partner-config/update` (`config.indexer`), which 403s for a partner admin KS
   * on the current deployment — call {@link linkAvailable} first; on a 403 this
   * returns `{applied:false, reason, code}` and NEVER throws (see API-REFERENCE.md § Ground the Agent).
   *
   * Wire shape is the indexer's VERIFIED `categoryEntry` DTO:
   * `indexer.{filterType:'categoryEntry', chunkSize, categoryInfo:[{categoryId, language}]}`
   * — `categoryId` is SINGULAR (a string id; the server resolves the full id),
   * and `chunkSize` lives at the INDEXER level (the backend hard-reads
   * `index_config["chunkSize"]`). NOTE: the indexer does NOT read a per-category
   * `objects[]`/`indexPosition`/`strategy` array — those modality embed-strategy
   * primitives ({@link buildIndexerObjects}) are validated here as INPUT (to
   * reject an unknown modality before the wire) and returned in `_meta.modalities`,
   * but are not part of the indexer's read path, so they are not sent. `documentTypes`
   * is a deprecated alias for `modalities`. `chunkSize` defaults to 5000 (the
   * backend default at `index.py:34`).
   * @param {object} opts {configId, categoryId, language?, modalities?, documentTypes?, chunkSize?} @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, reason?:string, code?:string, result?:any, _meta?:object}>}
   */
  async linkCategory(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.linkCategory');
    if (!opts?.configId || !opts?.categoryId) throw new KalturaError({ type: 'about:blank', title: 'configId+categoryId required', code: 'bad_request', detail: 'knowledge.linkCategory needs { configId, categoryId }.' });
    // Validate modalities BEFORE the wire (rejects an unknown/duplicate modality with a
    // typed bad_request) — but the indexer reads only {categoryId, language} + indexer-level
    // chunkSize, so we do NOT fabricate an objects[]/indexPosition array on the wire.
    if (opts.modalities || opts.documentTypes) buildIndexerObjects(opts.modalities || opts.documentTypes);
    const chunkSize = opts.chunkSize == null ? 5000 : opts.chunkSize;
    if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize <= 0) throw new KalturaError({ type: 'about:blank', title: 'bad chunkSize', code: 'bad_request', detail: 'knowledge.linkCategory chunkSize must be a positive integer.' });
    const config = { indexer: { filterType: 'categoryEntry', chunkSize, categoryInfo: [{ categoryId: String(opts.categoryId), language: opts.language || 'English' }] }, capabilities: { use_knowledge_base: 'on' } };
    try {
      const result = (await this._.genie('partner-config/update', { id: opts.configId, config }, ks)).data;
      return { applied: true, result };
    } catch (e) {
      // Deployment-gated: 403 (higher privilege required) / 404 (route not deployed) — surface
      // the typed reason WITHOUT throwing, never fake success.
      if (e instanceof KalturaError && (e.status === 403 || e.status === 404)) {
        const { code, reason } = classifyPartnerConfigError(e);
        return { applied: false, code, reason };
      }
      throw e;
    }
  }

  /**
   * Count the media entries in one or more knowledge CONTAINER categories (the
   * self-created corpus). READ. Accepts an explicit `categoryId`/`categoryIds`
   * (the container `createCategory`/`uploadDocument` used) AND/OR an intellect
   * `configId` to also fold in the linked categories from {@link getLinkage}.
   *
   * `getLinkage` returns EMPTY when the linkage is gated (the link write
   * 403s), so counting via linkage alone reports `populated:false` despite N
   * uploaded entries. Passing the
   * explicit container id(s) makes "corpus populated (N), retrieval gated"
   * observable. Uses `baseentry/list` `totalCount` (one call/category) for an
   * exact count — no per-entry probe loop.
   *
   * `_meta` surfaces `retrievalGated` + `reason` when a `configId` was given and
   * its linkage is empty/gated, so a UI badge has a machine-readable source.
   *
   * Counts entries that EXIST — not whether they've finished indexing. Use
   * {@link isIndexed} for that.
   * @param {object} opts {categoryId?, categoryIds?, configId?}
   * @param {string} ks (admin)
   * @returns {Promise<{entryCount:number, populated:boolean, categoryIds:number[], perCategory:Record<number,number>, _meta:object}>}
   */
  async corpusStatus(opts, ks) {
    this._.assertAdmin(ks, 'knowledge.corpusStatus');
    const explicit = []
      .concat(opts?.categoryIds || [])
      .concat(opts?.categoryId !== undefined && opts?.categoryId !== null ? [opts.categoryId] : []);
    /** @type {string|undefined} */ let linkageReason;
    /** @type {boolean} */ let retrievalGated = false;
    let linked = [];
    if (opts?.configId) {
      const link = await this.getLinkage(opts.configId, ks);
      linked = link.knowledgeIds;
      if (!linked.length) { retrievalGated = true; linkageReason = 'no indexer linkage on the read façade (linkage write is deployment-gated — see API-REFERENCE.md § Ground the Agent)'; }
    }
    const ids = [...new Set([...explicit, ...linked].map(Number).filter((n) => Number.isFinite(n)))];
    // Nothing to scope on AND no configId given → a genuine usage error.
    if (!ids.length && !opts?.configId) {
      throw new KalturaError({ type: 'about:blank', title: 'categoryId or configId required', code: 'bad_request', detail: 'knowledge.corpusStatus needs at least one of { categoryId, categoryIds, configId }.' });
    }
    // A configId WAS provided but resolved to no linked categories — the documented
    // deployment-gated linkage case (see API-REFERENCE.md § Ground the Agent), NOT a usage error. Report it honestly.
    if (!ids.length) {
      return {
        entryCount: 0, populated: false, categoryIds: [], perCategory: {},
        // retrievalGated/reason live in _meta ONLY (consistent with the populated
        // branch below) so consumers read one stable place.
        _meta: meta({
          partnerId: this._.partnerId, source: 'knowledge.corpusStatus (no linkage on read façade)',
          scope: `configId:${opts.configId}`, retrievalGated: true, reason: linkageReason,
        }),
      };
    }
    /** @type {Record<number,number>} */ const perCategory = {};
    let entryCount = 0;
    for (const cid of ids) {
      const filter = { objectType: 'KalturaBaseEntryFilter', categoryAncestorIdIn: String(cid), ...KNOWLEDGE_ENTRY_STATUS_TYPE_FILTER };
      const res = await this._.ovp('baseentry', 'list', { filter, pager: { objectType: 'KalturaFilterPager', pageSize: 1, pageIndex: 1 } }, ks);
      const n = Number(res?.totalCount) || 0;
      perCategory[cid] = n; entryCount += n;
    }
    return {
      entryCount,
      populated: entryCount > 0,
      categoryIds: ids,
      perCategory,
      _meta: meta({
        partnerId: this._.partnerId, source: 'ovp/baseentry.list (totalCount per category)',
        scope: 'admin KS (disableentitlement); knowledge container categories',
        ...(retrievalGated ? { retrievalGated: true, reason: linkageReason } : {}),
      }),
    };
  }

  /**
   * Probe whether the knowledge-linkage write path is usable on THIS deployment
   * (the route + the partner KS's privilege). READ — no state change. Returns
   * `{ available, reason }` so an app/provisioner can decide whether to attempt
   * RAG linkage or fall back to prompt/glossary grounding. @param {string} ks (admin)
   */
  async linkAvailable(ks) {
    this._.assertAdmin(ks, 'knowledge.linkAvailable');
    // A no-op-ish probe: partner-config/get must succeed (route deployed + authorized).
    return probePartnerConfigRoute(this._, ks, 'partner-config route reachable');
  }

  /**
   * Create a Knowledge record (`POST /v1/knowledge/add` on Genie). WRITE — NOT idempotent.
   * LIVE on the current deployment (verified) — returns `{id,...}`. This is
   * "Path A": pass the returned `id` as `knowledge_ids:[id]` to {@link Intellects.create}/
   * `add` (or `update`) to LINK it at write time — no `partner-config/update`, no gate.
   * @param {object} body {name,description?,config?} @param {string} ks (admin)
   */
  async addRecord(body, ks) {
    this._.assertAdmin(ks, 'knowledge.addRecord');
    return (await this._.genie('v1/knowledge/add', body, ks)).data;
  }

  /**
   * Get a Knowledge record by id (`POST /v1/knowledge/get`). READ. Returns the
   * full record `{id, partner_id, name, description, tags, status, user_id,
   * config:{sources:[{indexers:[{index_position, type, strategy}]}]},
   * created_at, updated_at}`. A deleted/unknown id → typed
   * `not_found`; another partner's id → typed `forbidden` ("Does not belong
   * to your partner"). `status` is the record's own container-lifecycle flag
   * (`"READY"`/`"DELETED"`), not an indexing-completion signal — see
   * {@link isIndexed} and {@link entryStatus}.
   * @param {number} id @param {string} ks (admin)
   */
  async getRecord(id, ks) {
    this._.assertAdmin(ks, 'knowledge.getRecord');
    requireRecordId(id, 'knowledge.getRecord');
    return (await this._.genie('v1/knowledge/get', { id }, ks)).data;
  }

  /**
   * List Knowledge records for the authenticated partner
   * (`POST /v1/knowledge/list`). READ. Async-iterable + awaitable (first
   * page) — mirrors {@link Tools#list}/{@link Skills#list}'s Genie
   * `{pageIndex,pageSize}` pager. Named `listRecords`, NOT `list` —
   * {@link Knowledge#list} (above) already means something unrelated: it
   * lists KMS *media entries* inside a category, not Knowledge record
   * containers.
   *
   * The "browse" step before every other Knowledge method's "act on a known
   * id" step — e.g. an Agent Factory picker letting a user attach an
   * existing knowledge base to a new agent by name, without hardcoding ids.
   * @param {string} ks (admin)
   * @param {{filter?:{nameEquals?:string, nameLike?:string, statusEquals?:string, statusIn?:string[]}, pageSize?:number}} [opts]
   */
  listRecords(ks, opts = {}) {
    this._.assertAdmin(ks, 'knowledge.listRecords');
    return paginate({
      style: 'index', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.genie('v1/knowledge/list', { filter: opts.filter || {}, pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update a Knowledge record (`POST /v1/knowledge/update`). WRITE — idempotent.
   * Patches `name`/`description`/`config` and returns the updated record.
   * Needs at least one field.
   *
   * ⚠️ `config` is a FULL-REPLACE field on the backend — passing
   * it here overwrites the ENTIRE config, including `sources` you didn't mean
   * to touch. Use {@link addSource}/{@link removeSource} to add or remove one
   * source without disturbing the others.
   * @param {number} id @param {{name?:string, description?:string, config?:object}} patch @param {string} ks (admin)
   */
  async updateRecord(id, patch, ks) {
    this._.assertAdmin(ks, 'knowledge.updateRecord');
    requireRecordId(id, 'knowledge.updateRecord');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.updateRecord needs a patch object {name?, description?, config?}.' });
    }
    /** @type {Record<string,unknown>} */
    const body = { id };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.updateRecord patch.name must be a non-empty string.' });
      body.name = patch.name;
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.updateRecord patch.description must be a string.' });
      body.description = patch.description;
    }
    if (patch.config !== undefined) {
      if (!patch.config || typeof patch.config !== 'object' || Array.isArray(patch.config)) {
        throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.updateRecord patch.config must be an object.' });
      }
      body.config = patch.config;
    }
    if (Object.keys(body).length === 1) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.updateRecord needs at least one of name/description/config.' });
    }
    return (await this._.genie('v1/knowledge/update', body, ks)).data;
  }

  /**
   * Add one source to a Knowledge record's config WITHOUT disturbing existing
   * sources. WRITE — idempotent: if an identical source (exact deep match)
   * already exists, this is a no-op (`applied:false`) — no wire write.
   * READ-MERGE-WRITE: reads the current record, appends `source` to
   * `config.sources`, and writes the union back via {@link updateRecord}'s
   * `config` support — because the backend's `v1/knowledge/update` REPLACES
   * `config` wholesale, a bare passthrough would silently
   * drop every other source.
   *
   * NOT SAFE TO CALL CONCURRENTLY for the same record id: two overlapping
   * calls both read the same pre-write `config.sources`, so the second
   * write silently overwrites the first's addition (a lost update, not an
   * error). Serialize calls per knowledge id, or re-read via {@link
   * getRecord} and retry on conflict.
   * @param {number} id @param {object} source One entry of `config.sources[]`
   *   (e.g. `{type:'internal', language, categoryIds:[...], indexers:[...]}`).
   * @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async addSource(id, source, ks) {
    this._.assertAdmin(ks, 'knowledge.addSource');
    requireRecordId(id, 'knowledge.addSource');
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.addSource needs a source object (one entry of config.sources[]).' });
    }
    const cur = await this.getRecord(id, ks);
    const existing = cur.config?.sources || [];
    if (existing.some((s) => sourcesEqual(s, source))) {
      return { applied: false, _meta: meta({ partnerId: this._.partnerId, source: 'genie/knowledge.update', scope: `knowledge:${id}`, reason: 'source already present (idempotent no-op)' }) };
    }
    const sent = { id, config: { ...cur.config, sources: [...existing, source] } };
    const result = await this.updateRecord(id, { config: sent.config }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/knowledge.update', scope: `knowledge:${id}`, readModifyWrite: true }) };
  }

  /**
   * Remove one source from a Knowledge record's config (exact deep match).
   * WRITE — idempotent: if no matching source is found, this is a no-op
   * (`applied:false`) — no wire write. Symmetric counterpart to
   * {@link addSource}; same read-merge-write shape, and the same
   * concurrent-call caveat: two overlapping calls race on the same
   * pre-write `config.sources` snapshot.
   * @param {number} id @param {object} source The exact source object to remove.
   * @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async removeSource(id, source, ks) {
    this._.assertAdmin(ks, 'knowledge.removeSource');
    requireRecordId(id, 'knowledge.removeSource');
    const cur = await this.getRecord(id, ks);
    const existing = cur.config?.sources || [];
    const sources = existing.filter((s) => !sourcesEqual(s, source));
    if (sources.length === existing.length) {
      return { applied: false, _meta: meta({ partnerId: this._.partnerId, source: 'genie/knowledge.update', scope: `knowledge:${id}`, reason: 'no matching source found (idempotent no-op)' }) };
    }
    const sent = { id, config: { ...cur.config, sources } };
    const result = await this.updateRecord(id, { config: sent.config }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/knowledge.update', scope: `knowledge:${id}`, readModifyWrite: true }) };
  }

  /**
   * Delete a Knowledge record (`POST /v1/knowledge/delete`). WRITE —
   * DESTRUCTIVE (requires confirmation). The wire reply body is `null`
   * (HTTP 200, get-after-delete 404s "Knowledge not found"), so
   * this returns a `{removed, _meta}` receipt instead. Does NOT unlink on its
   * own — see the SAFETY CHECK below, which is what stops that from silently
   * happening.
   *
   * SAFETY CHECK (default on): before deleting, lists every intellect and
   * refuses with a typed `knowledge_in_use` error naming each one still
   * carrying this id in `knowledge_ids` — same guard `tools.delete`/
   * `skills.delete` already run for their own entities. Pass
   * `{confirmPermanent:true, force:true}` to skip the check and delete
   * unconditionally (e.g. once you've confirmed via
   * `intellectConfig.setKnowledgeIds(configId, [], ks)` that every
   * referencing intellect has already been updated).
   * @param {number} id @param {string} ks (admin) @param {{confirmPermanent:boolean, force?:boolean}} confirm
   * @returns {Promise<{removed:number, _meta:object, skippedInUseCheck?:boolean}>}
   */
  async deleteRecord(id, ks, confirm) {
    this._.assertAdmin(ks, 'knowledge.deleteRecord');
    requireRecordId(id, 'knowledge.deleteRecord');
    requireConfirm(confirm, 'knowledge.deleteRecord', String(id));
    if (!confirm.force) {
      const refs = await findIntellectsReferencingKnowledge(this._, id, ks);
      if (refs.length) {
        throw new KalturaError({
          type: 'about:blank', title: 'knowledge in use', code: 'knowledge_in_use',
          detail: `knowledge record ${id} is still referenced in knowledge_ids by ${refs.length} intellect(s) (configId: ${refs.join(', ')}) — deleting it would leave them pointing at a missing record. Drop it from their knowledge_ids first via intellectConfig.setKnowledgeIds(configId, [], ks), or pass {confirmPermanent:true, force:true} to delete anyway.`,
        });
      }
    }
    await this._.genie('v1/knowledge/delete', { id }, ks);
    return {
      removed: id,
      ...(confirm.force ? { skippedInUseCheck: true } : {}),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/knowledge.delete', scope: `knowledge:${id}` }),
    };
  }

  /**
   * Re-point an EXISTING intellect's `knowledge_ids` via `partner-config/update` ("Path B").
   * WRITE — idempotent. GATED: this route 403s for a partner admin KS on the current
   * deployment (verified — needs a higher privilege; see API-REFERENCE.md § Ground the Agent). For a NEW agent prefer Path A
   * (pass `knowledge_ids` to {@link Intellects.create}, which writes it in the create DTO
   * with no gate). Call {@link linkAvailable} first; on 403 this throws a typed `forbidden`.
   * @param {number} configId @param {number[]} knowledgeIds @param {string} ks (admin)
   */
  async linkRecords(configId, knowledgeIds, ks) {
    this._.assertAdmin(ks, 'knowledge.linkRecords');
    return (await this._.genie('partner-config/update', { id: configId, config: { knowledge_ids: knowledgeIds, capabilities: { use_knowledge_base: 'on' } } }, ks)).data;
  }

  /**
   * Read indexing status for the partner's knowledge (`partner-config/stats`). READ.
   * GATED: 403s for a partner admin KS on at least one deployment — same
   * privilege wall as {@link linkRecords}, not a read exempt from it. A
   * knowledge-level status check that doesn't require elevated privilege is
   * planned for a future release; this method will likely be updated to use
   * it once that ships. Use {@link entryStatus} for per-entry status today.
   * @param {string} ks
   */
  async indexStatus(ks) {
    this._.assertAdmin(ks, 'knowledge.indexStatus');
    return (await this._.genie('partner-config/stats', { filter: {} }, ks)).data;
  }

  /**
   * Read a Knowledge record's own container status (`getRecord(id,
   * ks).status`). READ. This is the record's lifecycle flag — `"READY"` once
   * the record exists and is usable, `"DELETED"` once removed — NOT an
   * indexing-completion signal: a knowledge base is open-ended (entries can be
   * added at any time), so there's no single "fully indexed" state for the
   * record as a whole. `status` reads `"READY"` immediately on creation, before
   * any entry has been indexed. For whether specific entries have finished
   * indexing, use {@link entryStatus} instead.
   * @param {number} id @param {string} ks (admin)
   * @returns {Promise<{ready:boolean, status:string|null, indexPosition:number|null}>}
   */
  async isIndexed(id, ks) {
    this._.assertAdmin(ks, 'knowledge.isIndexed');
    const rec = await this.getRecord(id, ks);
    const indexers = (rec?.config?.sources || []).flatMap((s) => s.indexers || []);
    const withPosition = indexers.find((idx) => idx?.index_position != null);
    return {
      ready: rec?.status === 'READY',
      status: rec?.status ?? null,
      indexPosition: withPosition?.index_position ?? null,
    };
  }

  /**
   * Per-entry indexing status (`POST v1/knowledge/entry_status`). READ. The
   * correct way to check whether SPECIFIC uploaded content has finished
   * indexing — unlike {@link isIndexed}/`getRecord().status`, which reflect the
   * knowledge record's own container lifecycle, not entry-level progress.
   *
   * **Not yet generally available.** Verified working end-to-end on a
   * pre-production test environment; general rollout is expected in early
   * September 2026. Calling this before your deployment has it will fail —
   * don't build on it yet.
   *
   * Returns the raw `{entries:[...]}` array, unmodified: one row per entry
   * FOUND in the knowledge base (an unknown/not-yet-indexed entry id is
   * silently omitted, not an error), each with a `documents[]` list of
   * `{objectType, objectId, status}`. `status` is one of `SUCCEEDED`,
   * `NO_CHAPTERS`, `PARSE_ERROR`, `TOO_SHORT`, or `null` (queued/in progress).
   * `SUCCEEDED`/`TOO_SHORT` are the terminal-success statuses; `NO_CHAPTERS`/
   * `PARSE_ERROR` are terminal failures — this method doesn't collapse that
   * into a boolean, since "done" vs. "failed" is a caller decision.
   * @param {number} knowledgeId @param {string[]} entryIds 1-500 Kaltura entry ids @param {string} ks (admin)
   * @returns {Promise<{entries:Array<{entry_id:string, documents:Array<{objectType:string, objectId:string, status:string|null}>}>}>}
   */
  async entryStatus(knowledgeId, entryIds, ks) {
    this._.assertAdmin(ks, 'knowledge.entryStatus');
    requireRecordId(knowledgeId, 'knowledge.entryStatus');
    if (!Array.isArray(entryIds) || entryIds.length < 1 || entryIds.length > 500 || !entryIds.every((v) => typeof v === 'string' && v.length > 0)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'knowledge.entryStatus needs entryIds as a non-empty array of 1-500 entry-id strings.' });
    }
    return (await this._.genie('v1/knowledge/entry_status', { knowledge_id: knowledgeId, entry_ids: entryIds }, ks)).data;
  }
}

/**
 * Remap a converse-path error. A 403 from the conversation path is remapped to a
 * typed `client_variables_disabled` ONLY when the upstream body actually says
 * "Client variables are not allowed" — a 403 can ALSO come from token-scope /
 * cross-partner guards, and mislabeling those as a variables problem would
 * mislead the caller. Every other error is passed through
 * unchanged. Pure: no network, no side effects.
 * @param {any} e
 * @returns {any}
 */
export function remapConverseError(e) {
  if (!(e instanceof KalturaError) || e.status !== 403) return e;
  const hay = `${e.detail || ''} ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body || {})}`;
  if (!/Client variables are not allowed/i.test(hay)) return e;   // leave a scope-403 as a scope-403
  return new KalturaError({
    type: 'https://docs.kaltura.com/agentic/errors/client_variables_disabled',
    title: 'client variables disabled',
    code: 'client_variables_disabled',
    status: 403,
    detail: 'This intellect has allow_client_variables=false — request_vars are rejected. Enable it via intellects.setClientVariablesEnabled(configId, true) before sending request_vars.',
    instance: e.instance,
    requestId: e.requestId,
    body: e.body,
  });
}

function newFormData() {
  return sharedNewFormData('Knowledge upload needs global FormData (Node ≥18 / browser).');
}

/**
 * Aggregate a conversation-report CSV into volume/feedback/top-questions with a
 * provenance receipt. Pure function (no I/O) — mirrors genie.mjs
 * report-summary so the SDK and CLI agree byte-for-byte.
 * @param {string} csv @param {string} partnerId
 */
export function summarizeReport(csv, partnerId) {
  const rows = parseCsv(csv);
  const col = (r, name) => (r[name] || '').trim();
  const pos = rows.filter((r) => ['1', 'true', 'positive'].includes(col(r, 'Feedback reaction').toLowerCase())).length;
  const neg = rows.filter((r) => ['0', 'false', 'negative'].includes(col(r, 'Feedback reaction').toLowerCase())).length;
  const threads = new Set(rows.map((r) => col(r, 'Thread Id')).filter(Boolean));
  /** @type {Map<string,number>} */ const qCount = new Map();
  for (const r of rows) { const q = col(r, 'Question'); if (q) qCount.set(q, (qCount.get(q) || 0) + 1); }
  const topQuestions = [...qCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([question, count]) => ({ question, count }));
  return {
    _meta: meta({ partnerId, source: 'genie/message/report', scope: 'partner (admin KS, disableentitlement)' }),
    totals: { messages: rows.length, threads: threads.size },
    feedback: { positive: pos, negative: neg, unrated: rows.length - pos - neg, positiveRatio: (pos + neg) ? round3(pos / (pos + neg)) : null },
    topQuestions,
  };
}

/** Minimal RFC4180 CSV parser (handles quoted fields, embedded commas/quotes/newlines). @param {string} text */
export function parseCsv(text) {
  /** @type {string[][]} */ const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== '')).map((r) => {
    /** @type {Record<string,string>} */ const o = {};
    header.forEach((h, idx) => { o[h] = r[idx] ?? ''; });
    return o;
  });
}

function round3(n) { return Math.round(n * 1000) / 1000; }
