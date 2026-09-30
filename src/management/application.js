/**
 * Application — utility operations on the Agentic host: AI profile generation,
 * widget resolution, and runtime init. Reference: docs/api/deploy.md and
 * docs/api/authentication.md.
 */
import { KalturaError } from '../core/errors.js';

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
   * KS. Pass either a WIDGET KS (sessions.createWidgetToken, one identity
   * shared by every visitor) or a per-user AGENT KS minted on your server
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
}
