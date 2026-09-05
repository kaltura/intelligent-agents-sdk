/**
 * Management client — the umbrella over the management plane. Wires the shared
 * {@link Http} transport, the {@link Sessions} token-minter, the two-host
 * routing (Agentic vs Genie), the scope guards, and every resource namespace.
 *
 * The scope guards are the mechanical half of the two-KS-type invariant: a
 * management method that needs an admin token calls `assertAdmin(ks)`, which
 * inspects the KS and THROWS before any network call if it isn't an admin
 * (`disableentitlement`) token. Conversation methods call `assertConversation`.
 * This makes "never mix KS types" impossible to violate by accident.
 */
import { Http } from '../core/http.js';
import { Sessions, makeAuditEmitter } from '../core/session.js';
import { KalturaError, errorFromResponse } from '../core/errors.js';
import { Agents } from './agents.js';
import { Avatars } from './avatars.js';
import { AvatarSessions } from './avatar-sessions.js';
import { Catalog } from './catalog.js';
import { Application } from './application.js';
import { Intellects } from './intellects.js';
import { IntellectConfig } from './intellect-config.js';
import { Tools } from './tools.js';
import { Skills } from './skills.js';
import { Lifecycle } from './lifecycle.js';
import { Conversations, Threads, Messages, Feedback, Followups, Knowledge } from './conversations.js';
import { provision } from './provision.js';
import { setForcedLanguage } from './set-forced-language.js';
import { inspectKs } from './ks-inspect.js';

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
 * @property {(service:string, action:string, params:object, ks:KsLike)=>Promise<any>} ovp Kaltura OVP single call (www.kaltura.com/api_v3).
 * @property {(calls:object[], ks:KsLike)=>Promise<any>} ovpMulti Kaltura OVP multirequest (chained calls).
 * @property {(uploadTokenId:string, fd:FormData, ks:KsLike)=>Promise<any>} ovpUpload Upload file bytes to an upload token.
 * @property {(ks:KsLike, where:string)=>void} assertAdmin
 * @property {(ks:KsLike, where:string)=>void} assertConversation
 * @property {(ks:KsLike, where:string)=>void} assertAny
 * @property {(type:string, outcome:string, fields?:object)=>void} audit Redacted structured security/audit event emitter (no-op if the caller passed no `onAuditEvent` hook).
 */

export class Management {
  /**
   * @param {object} cfg
   * @param {string|number} cfg.partnerId
   * @param {string} [cfg.adminSecret]   Server-side only. Needed for sessions.createAdminToken / token mints.
   * @param {string} [cfg.agenticUrl]    Default https://api.avatar.us.kaltura.ai/v1
   * @param {string} [cfg.genieUrl]      Default https://genie.nvp1.ovp.kaltura.com
   * @param {string} [cfg.ovpUrl]        Default https://www.kaltura.com/api_v3
   * @param {typeof fetch} [cfg.fetch]
   * @param {(level:string,msg:string,data?:unknown)=>void} [cfg.logger]   Verbose, redacted DEBUG sink (chatty).
   * @param {(event:object)=>void} [cfg.onAuditEvent]   Discrete, redacted SECURITY events for your SIEM (token.mint/token.revoke/guard.reject/auth.fail/privileged.call). No-op if omitted (zero cost). NIST AU-2/AU-3, SOC 2 CC7.
   * @param {() => (string|Promise<string>)} [cfg.getAdminSecret]   Vault/KMS callback fetched per-mint (never retained); takes precedence over adminSecret.
   * @param {number} [cfg.timeoutMs]
   */
  constructor(cfg) {
    if (cfg?.partnerId === undefined) throw new KalturaError({ type: 'about:blank', title: 'partnerId required', code: 'bad_request', detail: 'new Management({ partnerId }) is required.' });
    const partnerId = String(cfg.partnerId);
    const agenticUrl = (cfg.agenticUrl || 'https://api.avatar.us.kaltura.ai/v1').replace(/\/$/, '');
    const genieUrl = (cfg.genieUrl || 'https://genie.nvp1.ovp.kaltura.com').replace(/\/$/, '');
    const ovpUrl = (cfg.ovpUrl || 'https://www.kaltura.com/api_v3').replace(/\/$/, '');
    // Crash-safe, redaction-clean structured audit emitter (no-op if no hook).
    const audit = makeAuditEmitter(cfg.onAuditEvent, partnerId, 'management');
    this._audit = audit;
    const http = new Http({ fetch: cfg.fetch, logger: cfg.logger, timeoutMs: cfg.timeoutMs, audit });

    /** @type {Sessions} */
    this.sessions = new Sessions({ partnerId, adminSecret: cfg.adminSecret, getAdminSecret: cfg.getAdminSecret, ovpUrl: cfg.ovpUrl, http, onAuditEvent: cfg.onAuditEvent });

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
        if (!res.ok) {
          // Route through errorFromResponse so a 422 maps to a typed validation_error and the
          // server's actual message (incl. an array-shaped `detail`) surfaces in `.detail`,
          // not buried in a stringified body (the force_experience-typo trap).
          const t = await res.text();
          let parsed = t; try { parsed = JSON.parse(t); } catch { /* keep text */ }
          const err = errorFromResponse({ status: res.status, path: `/${path}`, body: parsed, requestId: res.headers.get?.('x-request-id') || '' });
          audit('auth.fail', 'fail', { action: `POST /${path}`, reason: `HTTP ${res.status}` });
          throw err;
        }
        if (!res.body) throw new KalturaError({ type: 'about:blank', title: 'no stream body', code: 'server_error', detail: 'converse response had no readable body.' });
        return res.body;
      },
      // OVP (www.kaltura.com/api_v3) — the core Kaltura media plane (categories, entries,
      // upload tokens). JSON-in/JSON-out (format=1); the KS rides in the body, not a header.
      ovp: async (service, action, params, ks) => {
        const url = `${ovpUrl}/service/${service}/action/${action}`;
        const { data } = await http.request({ method: 'POST', url, json: true, body: { ks: ksString(ks), format: 1, ...params } });
        if (data && typeof data === 'object' && data.objectType === 'KalturaAPIException') {
          throw new KalturaError({ type: 'about:blank', title: data.code || 'kaltura error', code: 'ovp_error', detail: data.message, instance: `/${service}/${action}`, body: data });
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
      assertAdmin: (ks, where) => assertKind(ks, 'admin', where, audit),
      assertConversation: (ks, where) => assertKind(ks, 'conversation', where, audit),
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
    this.avatarSessions = new AvatarSessions(ctx);
    this.catalog = new Catalog(ctx);
    this.application = new Application(ctx);
    this.intellects = new Intellects(ctx);
    // Facade over the raw Intellects surface: one merge-safe patch() primitive + typed
    // field setters + describe() (editable/readOnly map). Shares the intellects instance
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
  }

  /**
   * Headless TEXT conversation as an async stream of segments — no WebRTC, no
   * avatar. Auto-mints a conversation token from `configId` when `ks` is omitted
   * (the admin secret stays server-side). Delegates to {@link Conversations#stream};
   * `force_experience` is a HINT (the runtime may answer in plain text). WRITE —
   * appends to thread memory.
   * @param {number} configId
   * @param {string} message
   * @param {{threadId?:string,sse?:boolean,model_type?:string,force_experience?:string,request_vars?:object,capabilities?:object}} [opts]
   * @param {string|{ks:string}} [ks]  Conversation token; minted from configId if omitted.
   * @returns {AsyncGenerator<object>}
   */
  async *converse(configId, message, opts = {}, ks) {
    const conv = ks || (await this.sessions.createConversationToken({ configId }));
    yield* this.conversations.stream({ ...opts, userMessage: message }, conv);
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
   * @param {object} [opts]  Same shape as {@link Management#converse}, plus `recoverFromSpiral?`.
   * @param {KsLike} [ks]
   * @returns {Promise<{text:string, threadId:string, messageId:string, segments:object[], toolCalls:object[], experiences:Record<string,object[]>, experiencesList:object[], kindCounts:object, spiralStopped:boolean, truncated:boolean, spiralRecovered?:boolean, firstAttempt?:object, _meta:object}>}
   */
  async converseOnce(configId, message, opts = {}, ks) {
    const conv = ks || (await this.sessions.createConversationToken({ configId }));
    return this.conversations.send({ ...opts, userMessage: message }, conv);
  }

  /**
   * Agent factory — provision a complete, deployable agent from a one-line
   * brief: generateProfile → intellect.add → configure prompts →
   * avatar.create → agent.create → resolveWidgetId. Returns every id
   * + a `_meta` receipt. WRITE — creates multiple resources. Requires an admin
   * token. See {@link provision}.
   * @param {object} opts {brief, ks, voiceId?, visualId?, adminTags?, maxConversationLength?, idempotencyKey?}
   */
  provision(opts) {
    return provision(this, opts);
  }

  /**
   * Force an agent's reply language by writing three related fields together:
   * `force_language` on the intellect, `asr.language` on the agent, and a
   * marker-wrapped instruction in `base_directive`. `force_language` alone
   * does not change the reply language; the `base_directive` instruction does.
   * WRITE, idempotent. Pass `language: null` to remove the instruction and
   * reset `asr.language`/`force_language` to their defaults. Requires an admin
   * token.
   * @param {object} opts {configId, agentId, language, languageName?, asrProvider?}
   * @param {string} ks (admin)
   * @see {@link setForcedLanguage}
   */
  setForcedLanguage(opts, ks) {
    return setForcedLanguage(this, opts, ks);
  }
}

/** Unwrap a KS that may be passed as a raw string OR a minted {@link Token} object. @param {string|{ks:string}} ks */
export function ksString(ks) {
  if (ks && typeof ks === 'object' && typeof ks.ks === 'string') return ks.ks;
  return /** @type {string} */ (ks);
}

/**
 * Assert a KS is of the expected kind, then return the raw KS string for the call.
 * Throws a redacted error (the KS is never echoed). Resolution of "kind" is, in
 * order: (1) a minted {@link Token}'s recorded `kind` (reliable); (2) plaintext
 * privileges if present (test/unencrypted tokens); (3) for a real ENCRYPTED token
 * whose privileges aren't client-readable, DON'T block — the server enforces
 * scope, and the only load-bearing guarantee (refusing disableentitlement on a
 * conversation mint) is already enforced at mint time in session.js.
 *
 * **Advisory only in production.** This guard only catches plaintext/test tokens
 * and is advisory in production — all real KS tokens are AES-encrypted and cannot
 * be inspected client-side (inspectKs returns `encrypted:true` and the check
 * returns early). The server is the authoritative enforcement point; do not rely
 * on this check as a security barrier.
 * @param {string|{ks:string,kind?:string,entitlementEnforced?:boolean}} ks
 * @param {'admin'|'conversation'} expected @param {string} where @param {(t:string,o:string,f?:object)=>void} [audit]
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
      detail: `${where} requires an ADMIN token (disableentitlement). Got a ${tokenKind || 'non-admin'} token. Use sessions.createAdminToken() (server-side only).`,
    });
  }
  if (expected === 'conversation' && isConversation === false) {
    audit?.('guard.reject', 'fail', { kind: 'admin', action: where, reason: 'conversation token required' });
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/wrong_token_scope', title: 'wrong token scope', code: 'wrong_token_scope',
      detail: `${where} requires a CONVERSATION token (geniegpcid, entitlement ON). Got an admin token — never converse with disableentitlement.`,
    });
  }
  return raw;
}
