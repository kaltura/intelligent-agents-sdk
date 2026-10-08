/**
 * Management client — the umbrella over the management plane. Wires the shared
 * {@link Http} transport, the {@link Sessions} token-minter, the two-host
 * routing (Agentic vs Genie), the scope guards, and every resource namespace.
 *
 * The scope guards are the mechanical half of the two-KS-type invariant: a
 * management method that needs an admin token calls `assertAdmin(ks)`, which
 * inspects the KS and throws before any network call whenever the kind is
 * knowable client-side (a minted {@link Token}'s recorded `kind`, or a
 * plaintext/test KS). Conversation methods call `assertConversation`. Methods
 * a per-user conversation or agent token may also call on its own threads
 * (`threads.*` except `push`, `messages.list/get/share`) call
 * `assertUserOrAdmin`, which accepts admin, conversation and agent tokens and
 * rejects widget tokens. A raw encrypted KS string can't be inspected this
 * way, so every guard passes it through and the server decides. Every `Token`
 * the SDK mints is checked reliably, so mixing KS types by accident throws
 * `wrong_token_scope` before any network call.
 */
import { Http } from '../core/http.js';
import { Sessions, makeAuditEmitter } from '../core/session.js';
import { KalturaError, errorFromResponse } from '../core/errors.js';
import { Agents, resolveIntellectId } from './agents.js';
import { Avatars } from './avatars.js';
import { AvatarSessions } from './avatar-sessions.js';
import { Catalog } from './catalog.js';
import { Application } from './application.js';
import { Intellects } from './intellects.js';
import { IntellectConfig } from './intellect-config.js';
import { Tools } from './tools.js';
import { Skills } from './skills.js';
import { Lifecycle } from './lifecycle.js';
import { InsightSettings } from './insight-settings.js';
import { EmailTemplates } from './email-templates.js';
import { Conversations, Threads, Messages, Feedback, Followups, Knowledge } from './conversations.js';
import { provision } from './provision.js';
import { setForcedLanguage } from './set-forced-language.js';
import { inspectKs } from './ks-inspect.js';
import { resolveEndpoints } from '../core/endpoints.js';
import { pickResponseHeaders } from '../core/response-headers.js';

/** `userId` on the read-only admin token that looks up an agent's configId (see `Sessions.createAgentToken`). */
const CONFIG_LOOKUP_USER_ID = 'intelligent-agents-sdk';

/**
 * @typedef {string|{ks:string,kind?:string,entitlementEnforced?:boolean}} KsLike A raw KS string or a minted {@link import('../core/session.js').Token}.
 * @typedef {object} Ctx Internal context shared with every resource namespace.
 * @property {string} partnerId
 * @property {(path:string, body:unknown, ks:KsLike, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} agentic
 * @property {(path:string, fd:FormData, ks:KsLike, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} agenticMultipart
 * @property {(path:string, body:unknown, bearerToken:string, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} avatarSessionCall Bearer-authed (not KS) call on the scripted-video `avatar-session/*` API — see avatar-sessions.js.
 * @property {(path:string, fd:FormData, bearerToken:string, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} avatarSessionMultipart Bearer-authed multipart call (`say-audio`).
 * @property {(path:string, body:unknown, ks:KsLike, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} genie
 * @property {(path:string, ks:KsLike)=>Promise<{data:any,requestId:string}>} genieGet
 * @property {(path:string, body:unknown, ks:KsLike, opts?:{signal?:AbortSignal})=>Promise<ReadableStream<Uint8Array>>} genieStream
 * @property {(service:string, action:string, params:object, ks:KsLike)=>Promise<any>} ovp Kaltura OVP single call (`ovpUrl`).
 * @property {(calls:object[], ks:KsLike)=>Promise<any>} ovpMulti Kaltura OVP multirequest (chained calls).
 * @property {(uploadTokenId:string, fd:FormData, ks:KsLike)=>Promise<any>} ovpUpload Upload file bytes to an upload token.
 * @property {(path:string, body:unknown, ks:KsLike, opts?:{idempotencyKey?:string})=>Promise<{data:any,requestId:string}>} messaging Bearer-authed (not `Authorization: KS …`) call on the Kaltura Messaging API — see email-templates.js.
 * @property {(ks:KsLike, where:string)=>string} assertAdmin Throws `wrong_token_scope` for a non-admin token. Returns the raw KS string.
 * @property {(ks:KsLike, where:string)=>string} assertUserOrAdmin Throws `wrong_token_scope` for a widget token. Accepts admin, conversation and agent tokens. Returns the raw KS string.
 * @property {(ks:KsLike, where:string)=>string} assertConversation Throws `wrong_token_scope` for an admin token. Returns the raw KS string.
 * @property {(ks:KsLike, where:string)=>string} assertAny Throws `bad_request` if `ks` is empty. Accepts any kind. Returns the raw KS string.
 * @property {(type:string, outcome:string, fields?:object)=>void} audit Redacted structured security/audit event emitter (no-op if the caller passed no `onAuditEvent` hook).
 */

export class Management {
  /**
   * @param {object} cfg
   * @param {string|number} cfg.partnerId
   * @param {string} [cfg.adminSecret]   Server-side only. Needed for sessions.createAdminToken / token mints.
   * @param {import('../core/endpoints.js').KalturaRegion} [cfg.region]  Region your partner lives in. Default `'nvp1'` (US). Fills every base URL you don't pass, from `REGIONS`. An unknown code throws `bad_request`.
   * @param {string} [cfg.agenticUrl]    Overrides the region value.
   * @param {string} [cfg.genieUrl]      Overrides the region value.
   * @param {string} [cfg.ovpUrl]        Overrides the region value. The admin secret is sent here.
   * @param {string} [cfg.messagingUrl]  Overrides the region value. If the region has no messaging service and you pass none, `emailTemplates.*` throws `region_unavailable`.
   * @param {boolean} [cfg.allowInsecureTransport]  Allow an http:// base URL to a public host (testing only, warns). http to localhost or a private host always just warns.
   * @param {typeof fetch} [cfg.fetch]
   * @param {(level:string,msg:string,data?:unknown)=>void} [cfg.logger]   Verbose, redacted DEBUG sink (chatty). Also receives insecure-transport warnings (else `console.warn`).
   * @param {(info:import('../core/response-headers.js').ResponseInfo)=>void} [cfg.onResponse]   Called for every received response, success or failure, once per attempt, with `{ method, path, status, ok, attempt, requestId, headers }`. `headers` holds the diagnostic response headers (`x-*`, `via`, `server`, ...), redacted. A throwing hook is ignored. Failures also carry them on `err.headers`.
   * @param {(event:object)=>void} [cfg.onAuditEvent]   Discrete, redacted SECURITY events for your SIEM (token.mint/token.revoke/guard.reject/auth.fail/privileged.call). No-op if omitted (zero cost). NIST AU-2/AU-3, SOC 2 CC7.
   * @param {() => (string|Promise<string>)} [cfg.getAdminSecret]   Vault/KMS callback fetched per-mint (never retained); takes precedence over adminSecret.
   * @param {number} [cfg.timeoutMs]
   */
  constructor(cfg) {
    if (cfg?.partnerId === undefined) throw new KalturaError({ type: 'about:blank', title: 'partnerId required', code: 'bad_request', detail: 'new Management({ partnerId }) is required.' });
    const partnerId = String(cfg.partnerId);
    const warn = (m) => (cfg.logger ? cfg.logger('warn', '[security] ' + m) : console.warn('[security] ' + m));
    const endpoints = resolveEndpoints(cfg, ['agenticUrl', 'genieUrl', 'ovpUrl', 'messagingUrl'], warn);
    const { agenticUrl, genieUrl, ovpUrl, messagingUrl } = endpoints;
    this._endpoints = endpoints;
    const region = cfg.region ?? 'nvp1';
    // Crash-safe, redaction-clean structured audit emitter (no-op if no hook).
    const audit = makeAuditEmitter(cfg.onAuditEvent, partnerId, 'management');
    this._audit = audit;
    const http = new Http({ fetch: cfg.fetch, logger: cfg.logger, timeoutMs: cfg.timeoutMs, audit, onResponse: cfg.onResponse });

    /** @type {Sessions} */
    this.sessions = new Sessions({
      partnerId, adminSecret: cfg.adminSecret, getAdminSecret: cfg.getAdminSecret, ovpUrl, http, onAuditEvent: cfg.onAuditEvent,
      // createAgentToken without configId: read the agent's intellect id. Not cached,
      // so a repointed agent never mints the old persona. Runs after this.agents exists.
      // The lookup admin token is short-lived since it is used once, and read-only.
      resolveConfigId: async (agentId) => {
        const admin = await this.sessions.createAdminToken({ userId: CONFIG_LOOKUP_USER_ID, ttlSeconds: 60 });
        return resolveIntellectId((await this.agents.get(agentId, admin.ks)).intellect);
      },
    });

    /** @type {Ctx} */
    const ctx = {
      partnerId,
      agentic: (path, body, ks, opts) => http.postJson({ url: `${agenticUrl}/${path}`, ks: ksString(ks), body, idempotencyKey: opts?.idempotencyKey }),
      agenticMultipart: (path, fd, ks, opts) => http.request({ method: 'POST', url: `${agenticUrl}/${path}`, ks: ksString(ks), body: fd, json: false, idempotencyKey: opts?.idempotencyKey }),
      // The scripted-video `avatar-session/*` API is the one agentic-host surface that does NOT
      // authenticate with a KS after creation — every call following `create` carries the
      // session's own short-lived Bearer JWT instead (a KS on these routes is
      // simply ignored/rejected). Omitting `ks` here skips http.request's `Authorization: KS …`
      // assignment entirely, leaving our own header in place (see avatar-sessions.js).
      avatarSessionCall: (path, body, bearerToken, opts) => http.request({ method: 'POST', url: `${agenticUrl}/${path}`, headers: { Authorization: `Bearer ${bearerToken}` }, body, json: true, idempotencyKey: opts?.idempotencyKey }),
      avatarSessionMultipart: (path, fd, bearerToken, opts) => http.request({ method: 'POST', url: `${agenticUrl}/${path}`, headers: { Authorization: `Bearer ${bearerToken}` }, body: fd, json: false, idempotencyKey: opts?.idempotencyKey }),
      genie: (path, body, ks, opts) => http.postJson({ url: `${genieUrl}/${path}`, ks: ksString(ks), body, idempotencyKey: opts?.idempotencyKey }),
      genieGet: (path, ks) => http.request({ method: 'GET', url: `${genieUrl}/${path}`, ks: ksString(ks) }),
      // Unlike every other endpoint here, this bypasses http.request()/postJson() (it needs the
      // raw ReadableStream body, not a parsed JSON response) — which means it also bypasses
      // Http's built-in per-request AbortController/timeout. A caller that wants to bound (or
      // cancel) a stalled/slow-trickling stream must supply its own `signal` (mirrors
      // Http#request's `req.signal`); without one this can hang open indefinitely, same as any
      // unbounded fetch.
      genieStream: async (path, body, ks, opts) => {
        const signal = opts?.signal;
        let res;
        try {
          res = await http._fetch(`${genieUrl}/${path}`, {
            method: 'POST', headers: { Authorization: `KS ${ksString(ks)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (signal?.aborted) throw errorFromResponse({ status: 0, path: `/${path}`, body: 'aborted by caller', requestId: '' });
          throw err;
        }
        const requestId = res.headers?.get?.('x-request-id') || res.headers?.get?.('x-kaltura-request-id') || '';
        const headers = pickResponseHeaders(res.headers);
        http.notifyResponse({ method: 'POST', path: `/${path}`, status: res.status, ok: res.ok, attempt: 1, requestId, headers });
        if (!res.ok) {
          // Route through errorFromResponse so a 422 maps to a typed validation_error and the
          // server's actual message (incl. an array-shaped `detail`) surfaces in `.detail`,
          // not buried in a stringified body (the force_experience-typo trap).
          const t = await res.text();
          let parsed = t; try { parsed = JSON.parse(t); } catch { /* keep text */ }
          const err = errorFromResponse({ status: res.status, path: `/${path}`, body: parsed, requestId, headers });
          audit('auth.fail', 'fail', { action: `POST /${path}`, reason: `HTTP ${res.status}` });
          throw err;
        }
        if (!res.body) throw new KalturaError({ type: 'about:blank', title: 'no stream body', code: 'server_error', detail: 'converse response had no readable body.' });
        return res.body;
      },
      // OVP (`ovpUrl`) — the core Kaltura media plane (categories, entries,
      // upload tokens). JSON-in/JSON-out (format=1); the KS rides in the body, not a header.
      ovp: async (service, action, params, ks) => {
        const url = `${ovpUrl}/service/${service}/action/${action}`;
        const { data, headers } = await http.request({ method: 'POST', url, json: true, body: { ks: ksString(ks), format: 1, ...params } });
        if (data && typeof data === 'object' && data.objectType === 'KalturaAPIException') {
          throw new KalturaError({ type: 'about:blank', title: data.code || 'kaltura error', code: 'ovp_error', detail: data.message, instance: `/${service}/${action}`, headers: pickResponseHeaders(headers), body: data });
        }
        return data;
      },
      // OVP multirequest — chained calls with {n:result:field} substitution (the upload pattern).
      ovpMulti: async (calls, ks) => {
        const body = { apiVersion: '19.14.0', format: 1 };
        calls.forEach((c, i) => { body[i] = { ks: ksString(ks), ...c }; });
        const { data } = await http.request({ method: 'POST', url: `${ovpUrl}/service/multirequest`, json: true, body });
        return data;
      },
      // Upload file bytes to an upload token (uploadtoken/upload, multipart).
      // The KS is passed as a FormData field rather than a URL query parameter to
      // avoid exposing admin credentials in server access logs, CDN logs, browser
      // history, and Referer headers on any redirect.
      ovpUpload: async (uploadTokenId, fd, ks) => {
        const url = `${ovpUrl}/service/uploadtoken/action/upload?uploadTokenId=${encodeURIComponent(uploadTokenId)}&resume=false&finalChunk=true&resumeAt=0&format=1`;
        fd.append('ks', ksString(ks));
        const { data } = await http.request({ method: 'POST', url, body: fd, json: false });
        return data;
      },
      // Kaltura Messaging API (email templates) — a separate host from Agentic/Genie, and the
      // one surface here that authenticates with a bare `Authorization: Bearer <KS>` header
      // rather than the `KS <ks>` scheme http.request assigns by default. Omitting `ks` on the
      // request skips that assignment, leaving our own header in place (mirrors avatarSessionCall).
      // `null` when the region has no messaging service: fail before any network call
      // rather than send this region's KS to another region's host.
      messaging: (path, body, ks, opts) => !messagingUrl ? Promise.reject(regionUnavailable('messagingUrl', 'emailTemplates', region)) : http.request({ method: 'POST', url: `${messagingUrl}/${path}`, headers: { Authorization: `Bearer ${ksString(ks)}` }, body, json: true, idempotencyKey: opts?.idempotencyKey }),
      assertAdmin: (ks, where) => assertKind(ks, 'admin', where, audit),
      assertConversation: (ks, where) => assertKind(ks, 'conversation', where, audit),
      assertUserOrAdmin: (ks, where) => assertKind(ks, 'userOrAdmin', where, audit),
      assertAny: (ks, where) => {
        const raw = ksString(ks);
        if (!raw || typeof raw !== 'string') {
          throw new KalturaError({ type: 'about:blank', title: 'KS required', code: 'bad_request', detail: `${where} needs a KS token (string or a minted Token).` });
        }
        return raw;
      },
      audit,
    };
    this._ctx = ctx;

    this.agents = new Agents(ctx);
    this.avatars = new Avatars(ctx);
    // Scripted-video (STV-only) session lifecycle — a separate, brain-free backend from
    // `application`/the conversational runtime. See avatar-sessions.js's class doc.
    /** @deprecated Removed in the next major version. Build with agents instead. */
    this.avatarSessions = new AvatarSessions(ctx);
    this.catalog = new Catalog(ctx);
    this.application = new Application(ctx);
    this.intellects = new Intellects(ctx);
    // Facade over the raw Intellects surface: one merge-safe patch() primitive + typed
    // field setters + describe() (every EDITABLE_FIELDS value). Shares the intellects instance
    // so capability/secret writes use a single read-merge-write path (no divergence).
    this.intellectConfig = new IntellectConfig(ctx, this.intellects);
    // Standalone, PARTNER-LEVEL Tool entity CRUD (`/v1/tool/*`) — NOT intellect-scoped.
    // Link a created tool to an intellect via `intellectConfig.setToolIds` or `tool_ids`.
    this.tools = new Tools(ctx);
    // Standalone, PARTNER-LEVEL Skill entity CRUD (`/v1/skill/*`) — uuid-id
    // named behaviors, distinct from Tools.
    this.skills = new Skills(ctx);
    this.conversations = new Conversations(ctx);
    this.threads = new Threads(ctx);
    this.messages = new Messages(ctx);
    this.feedback = new Feedback(ctx);
    this.followups = new Followups(ctx);
    this.knowledge = new Knowledge(ctx);
    // Event-driven rule engine (`/lifecycle/*`) — react to session/thread
    // events (e.g. session_ended) with server-owned actions, no polling.
    this.lifecycle = new Lifecycle(ctx);
    // Reusable insight definitions (`/insight-settings/*`) a lifecycle rule's
    // `triggerInsightSettingsKai` action references by id.
    this.insightSettings = new InsightSettings(ctx);
    // Kaltura Messaging API email templates (`email-template/*`) — the `templateId` a
    // lifecycle rule's `sendInsightEmail` action can pin instead of a `presetType`.
    this.emailTemplates = new EmailTemplates(ctx);
  }

  /**
   * The resolved base URLs this instance talks to. Frozen. Safe to log (URLs
   * only, no credentials). `messagingUrl` is `null` when the region has no
   * messaging service and you passed none.
   * @returns {Readonly<import('../core/endpoints.js').KalturaEndpoints>}
   */
  get endpoints() { return /** @type {Readonly<import('../core/endpoints.js').KalturaEndpoints>} */ (this._endpoints); }

  /**
   * Headless TEXT conversation as an async stream of segments — no WebRTC, no
   * avatar. Auto-mints a conversation token from `configId` when `ks` is omitted
   * (the admin secret stays server-side). Delegates to {@link Conversations#stream};
   * `force_experience` is a HINT (the runtime may answer in plain text). WRITE —
   * appends to thread memory.
   *
   * `opts.agentId` and `opts.userId` go to the auto-mint only (ignored when `ks`
   * is passed). `agentId` labels the thread with the real agent id. `userId`
   * gives the end user their own threads. See {@link Sessions#createConversationToken}.
   * @param {number} configId
   * @param {string} message
   * @param {{agentId?:string,userId?:string|number,threadId?:string,sse?:boolean,model_type?:string,force_experience?:string,request_vars?:object,capabilities?:object}} [opts]
   * @param {string|{ks:string}} [ks]  Conversation token; minted from configId if omitted.
   * @returns {AsyncGenerator<object>}
   */
  async *converse(configId, message, opts = {}, ks) {
    const { agentId, userId, ...rest } = opts ?? {};
    const conv = ks || (await this.sessions.createConversationToken({ configId, agentId, userId }));
    yield* this.conversations.stream({ ...rest, userMessage: message }, conv);
  }

  /**
   * Headless TEXT conversation, collected into a single reply
   * `{text, threadId, messageId, segments, experiences, experiencesList,
   * kindCounts, _meta}`. Auto-mints a conversation token when `ks` is omitted.
   * WRITE — appends to thread memory. Convenience over {@link Management#converse}.
   * Delegates to {@link Conversations#send}, so `opts.recoverFromSpiral:true`
   * gets the same one-shot spiral-recovery nudge documented there.
   * @param {number} configId
   * @param {string} message
   * @param {object} [opts]  Same shape as {@link Management#converse} (including `agentId?`/`userId?`), plus `recoverFromSpiral?`.
   * @param {KsLike} [ks]
   * @returns {Promise<{text:string, threadId:string, messageId:string, segments:object[], toolCalls:object[], experiences:Record<string,object[]>, experiencesList:object[], kindCounts:object, spiralStopped:boolean, truncated:boolean, spiralRecovered?:boolean, firstAttempt?:object, _meta:object}>}
   */
  async converseOnce(configId, message, opts = {}, ks) {
    const { agentId, userId, ...rest } = opts ?? {};
    const conv = ks || (await this.sessions.createConversationToken({ configId, agentId, userId }));
    return this.conversations.send({ ...rest, userMessage: message }, conv);
  }

  /**
   * Agent factory — provision a complete, deployable agent from a one-line
   * brief: generateProfile → intellect.add → pick preset voice and visual →
   * avatar.create → intellect.update (prompts, opening phrase) → agent.create →
   * resolveWidgetId. Returns every id + a `_meta` receipt. WRITE, creates
   * multiple resources. Requires an admin token. See {@link provision}.
   * @param {object} opts {brief, ks, voiceId?, visualId?, openingPhrase?, adminTags?, maxConversationLength?, idempotencyKey?, capabilities?, tools?, knowledge?}
   */
  provision(opts) {
    return provision(this, opts);
  }

  /**
   * Force an agent's reply language by writing two related fields together:
   * `force_language` on the intellect (the backend enforces it at runtime) and
   * `asr.language` on the agent (so speech recognition matches). WRITE,
   * idempotent. Pass `language: null` to clear `force_language` and reset
   * `asr.language` to `'en'`. Requires an admin token.
   * @param {object} opts {configId, agentId, language, languageName?, asrProvider?}
   * @param {string} ks (admin)
   * @see {@link setForcedLanguage}
   */
  setForcedLanguage(opts, ks) {
    return setForcedLanguage(this, opts, ks);
  }
}

/**
 * `region_unavailable`: the configured region has no `field` service and the
 * caller passed no override. Thrown before any network call.
 * @param {string} field @param {string} where @param {string} region
 */
function regionUnavailable(field, where, region) {
  return new KalturaError({ type: 'about:blank', title: 'service not available in region', code: 'region_unavailable', detail: `${where} needs ${field}, which region '${region}' does not provide. Pass ${field} to new Management({ ... }) to use it.` });
}

/** Unwrap a KS that may be passed as a raw string OR a minted {@link Token} object. @param {string|{ks:string}} ks */
export function ksString(ks) {
  if (ks && typeof ks === 'object' && typeof ks.ks === 'string') return ks.ks;
  return /** @type {string} */ (ks);
}

/**
 * Assert a KS is of the expected kind, then return the raw KS string for the call.
 * Throws a redacted error (the KS is never echoed). Resolution of "kind" is, in
 * order: (1) a minted {@link Token}'s recorded `kind`, always checked; (2) plaintext
 * privileges if present (test/unencrypted tokens); (3) a raw encrypted KS string,
 * whose privileges aren't client-readable, passes through and the server decides.
 * Every token from `sessions.*` takes path (1), so it is always checked.
 * `'userOrAdmin'` accepts `admin`, `conversation` and `agent` and rejects `widget`.
 * Only a minted widget Token is refused client-side; a raw KS string is not checked and the server's answer is returned.
 * @param {string|{ks:string,kind?:string,entitlementEnforced?:boolean}} ks
 * @param {'admin'|'conversation'|'userOrAdmin'} expected @param {string} where @param {(t:string,o:string,f?:object)=>void} [audit]
 * @returns {string} the raw KS
 */
function assertKind(ks, expected, where, audit) {
  const raw = ksString(ks);
  if (!raw || typeof raw !== 'string') {
    throw new KalturaError({ type: 'about:blank', title: 'KS required', code: 'bad_request', detail: `${where} needs a KS token (string or a minted Token).` });
  }
  // (1) Trust a minted Token's recorded kind.
  const tokenKind = ks && typeof ks === 'object' ? ks.kind : undefined;
  let isAdmin, isConversation;
  if (tokenKind) { isAdmin = tokenKind === 'admin'; isConversation = tokenKind !== 'admin'; }
  else {
    // (2) plaintext introspection; (3) opaque → unknown.
    const info = inspectKs(raw);
    if (!info.ok || info.encrypted || info.kind === 'opaque' || info.disableEntitlement === null) return raw; // unknowable → server enforces
    isAdmin = info.disableEntitlement === true;
    isConversation = !isAdmin;
  }
  if (expected === 'admin' && isAdmin === false) {
    audit?.('guard.reject', 'fail', { kind: tokenKind || 'non-admin', action: where, reason: 'admin token required' });
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/wrong_token_scope', title: 'wrong token scope', code: 'wrong_token_scope',
      detail: `${where} requires an ADMIN token (disableentitlement). Got a ${tokenKind || 'non-admin'} token. Use sessions.createAdminToken({ userId }) (server-side only).`,
    });
  }
  if (expected === 'userOrAdmin') {
    if (tokenKind === 'widget') {
      audit?.('guard.reject', 'fail', { kind: 'widget', action: where, reason: 'user or admin token required' });
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/wrong_token_scope', title: 'wrong token scope', code: 'wrong_token_scope',
        detail: `${where} requires an admin, conversation or agent token. Got a widget token.`,
      });
    }
    return raw;
  }
  if (expected === 'conversation' && isConversation === false) {
    audit?.('guard.reject', 'fail', { kind: 'admin', action: where, reason: 'conversation token required' });
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/wrong_token_scope', title: 'wrong token scope', code: 'wrong_token_scope',
      detail: `${where} requires a conversation or agent token (entitlement ON). Got an admin token. Never converse with disableentitlement.`,
    });
  }
  return raw;
}
