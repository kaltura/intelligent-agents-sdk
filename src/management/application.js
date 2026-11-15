/**
 * Application — utility operations on the Agentic host: AI profile generation,
 * widget resolution, and runtime init. Reference: docs/api/deploy.md and
 * docs/api/authentication.md.
 */
import { KalturaError } from '../core/errors.js';
import { resolveIntellectId } from './agents.js';
import { isNotFound } from './audit-report.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Application {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * AI-generate a draft agent profile from a plain-English brief. READ — no
   * state change (the result is NOT saved; pass it to intellect config
   * yourself). Returns {goal,targetAudience,restrictedTopics,name,openingPhrase}.
   * @param {string} userDescription @param {string} ks (admin)
   */
  async generateProfile(userDescription, ks) {
    this._.assertAdmin(ks, 'application.generateProfile');
    return (await this._.agentic('application/generateAgentProfile', { userDescription }, ks)).data;
  }

  /**
   * Resolve (idempotently create) the embeddable widgetId for an agent. WRITE —
   * idempotent (creates the widget once, then returns the same one). The widget
   * is the public artifact safe to ship in client code. Returns `{widgetId}`.
   * @param {string} agentId @param {string} ks (admin)
   */
  async resolveWidgetId(agentId, ks) {
    this._.assertAdmin(ks, 'application.resolveWidgetId');
    return (await this._.agentic('application/resolveWidgetId', { agentId }, ks)).data;
  }

  /**
   * Initialize a runtime session. Takes NO body — derives the agent from the
   * KS. Pass either a WIDGET KS (sessions.createWidgetToken) or a per-user AGENT KS minted on your server
   * (sessions.createAgentToken with `userId`, so each user gets their own
   * threads). Returns the live runtime endpoints + a conversation KS:
   *   {partnerId, ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[], widgetConfig?, embedConfig?}
   * The returned `ks` answers as the agent, keeps entitlement ON and keeps the
   * input KS's user identity. Hand it to {@link KalturaAvatarSession}. Returned verbatim, no SDK-side transform:
   * `avatars[].previewImageUrl`/`loadingVideoUrl` are raw backend asset URLs
   * (an upload echo for a custom visual, a preset asset URL for a catalog
   * item), not the rendered composite the live WHEP stream shows. Each entry
   * also carries an unmodeled wire field `objectType:"Object"` (serialization
   * metadata, not modeled). READ (no resource
   * mutation).
   *
   * Flag fields such as `legacyScreenShareEnabled` are the server's own names
   * and may change or go away. Do not read them in app code. Use the SDK
   * instead: set `screenShare` on the agent (`agents.create` / `agents.update`)
   * and call `startScreenShare()` on the session. Those names stay stable.
   *
   * PERMISSION GATE: the KS must carry the `agentid:<uuid>` privilege (a
   * widget KS from {@link resolveWidgetId}'s widget, an agent token, or a
   * conversation token minted with `agentId`). An admin or plain
   * conversation KS without it fails with `api_exception`.
   * @param {string|import('./client.js').KsLike} widgetKs A widget or agent KS (NOT an admin KS).
   */
  async appInit(widgetKs) {
    if (!widgetKs) throw new KalturaError({ type: 'about:blank', title: 'widget KS required', code: 'bad_request', detail: 'appInit needs a widget KS (sessions.createWidgetToken) or an agent KS (sessions.createAgentToken).' });
    return (await this._.agentic('application/appInit', {}, widgetKs)).data;
  }

  /**
   * The fixed field schema `intellects.add`/`intellects.update`'s `prompts[]`
   * input accepts — a static, partner-agnostic descriptor array (`goal`,
   * `targetAudience`, `restrictedTopics`, `name`, `knowledge`), not a
   * partner's saved prompts. Render a "describe your agent" form straight
   * from this instead of hardcoding the 5 fields, so a new field the backend
   * adds shows up with no SDK/app changes. READ — no state, no partner
   * lookup (any valid KS works). Each entry also carries an unmodeled wire
   * field `objectType:"Object"` (serialization metadata, not modeled)
   * and `type:"custom"` (the same on every entry, not a per-field distinction).
   * @param {string} ks
   * @returns {Promise<Array<{key:string, label:string, headerTemplate:string, type:string}>>}
   */
  async getCustomPrompts(ks) {
    this._.assertAny(ks, 'application.getCustomPrompts');
    return (await this._.agentic('application/getCustomPrompts', {}, ks)).data;
  }

  /**
   * List the `{{ variables }}` of one agent: the reserved `sys__*` ones and the
   * custom ones its prompts, tools and skills reference. READ, no state change.
   * Returned verbatim, no SDK-side transform or defaults:
   *   `{systemVariables[], customVariables[]}`.
   * `systemVariables[]` items: `{name, template, type, description, example, used, properties?[]}`.
   * `used` says whether the agent references that variable.
   * `customVariables[]` items: `{name, template, type, paths[], origins[], sources[]}`.
   * `type` is `"unknown"` when it cannot be inferred. `origins[]` says where a
   * value comes from (`"referenced"`, or `"set_by_tool"` for a value a `var` tool
   * sets at runtime).
   * `sources[]` items: `{documentType, documentId, documentName?, field, origin}`.
   * `documentId` is a number for an intellect source and a string for the others.
   * An unknown agent id throws `agent_not_found`. An agent whose intellect no
   * longer exists throws `intellect_not_found`: on a `server_error` the SDK reads
   * the agent and its intellect (two more reads) to tell this case apart, and
   * `err.cause` holds the original error. Any other `server_error` is thrown unchanged.
   * A non-string or non-UUID-shaped `agentId` throws `bad_request` before any
   * request. The check is on shape only, so the server may still refuse the id.
   * @param {string} agentId UUID-shaped string (`agents.create` returns it as `id`).
   * @param {string} ks (admin)
   * @returns {Promise<{systemVariables?: Array<{name:string, template:string, type:string, description:string, example?:string|boolean|object, used:boolean, properties?:object[]}>, customVariables?: Array<{name:string, template:string, type:string, paths:string[], origins:string[], sources:Array<{documentType:string, documentId:string|number, documentName?:string, field:string, origin:string}>}>}>}
   */
  async getCustomVariables(agentId, ks) {
    this._.assertAdmin(ks, 'application.getCustomVariables');
    if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'application.getCustomVariables needs the agent id as a UUID-shaped string (the `id` agents.create returns).' });
    }
    try {
      return (await this._.agentic('application/getCustomVariables', { agentId }, ks)).data;
    } catch (e) {
      if (!(e instanceof KalturaError) || e.code !== 'server_error') throw e;
      throw (await this._missingIntellect(agentId, ks, e)) ?? e;
    }
  }

  /**
   * After a `server_error`, check whether the agent points at an intellect that
   * no longer exists. Returns an `intellect_not_found` error for that case, else
   * `null` (also when a lookup itself fails), so the caller throws the original.
   * @param {string} agentId @param {string} ks @param {KalturaError} cause
   * @returns {Promise<KalturaError|null>}
   */
  async _missingIntellect(agentId, ks, cause) {
    try {
      const configId = resolveIntellectId((await this._.agentic('agent/get', { agentId }, ks)).data?.intellect);
      if (configId === undefined) return null;
      try {
        await this._.genie('v1/intellect/get', { id: configId }, ks);
        return null;
      } catch (e) {
        if (!isNotFound(e)) return null;
        return new KalturaError({
          type: 'about:blank', title: 'intellect not found', code: 'intellect_not_found', status: cause.status,
          detail: `application.getCustomVariables: agent ${agentId} points at intellect ${configId}, which does not exist. Point the agent at an existing intellect.`,
          instance: cause.instance, requestId: cause.requestId, headers: cause.headers, retryable: false, cause,
        });
      }
    } catch {
      return null;
    }
  }
}
