/**
 * Application — utility operations on the Agentic host: AI profile generation,
 * widget resolution, and runtime init. Source: tools/agentic.mjs app-* +
 * API-REFERENCE §1.4 / §3.1 / §3.2.
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
   * bakes in `setrole:PLAYBACK_BASE_ROLE,sview:*,agentid:<uuid>` and is the
   * public artifact safe to ship in client code. Returns `{widgetId}`.
   * @param {string} agentId @param {string} ks (admin)
   */
  async resolveWidgetId(agentId, ks) {
    this._.assertAdmin(ks, 'application.resolveWidgetId');
    return (await this._.agentic('application/resolveWidgetId', { agentId }, ks)).data;
  }

  /**
   * Initialize a runtime session. Takes NO body — derives the agent from the
   * WIDGET KS (mint one via sessions.createWidgetToken). Returns the live
   * runtime endpoints + an enriched conversation KS:
   *   {ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[], widgetConfig?, embedConfig?}
   * The returned `ks` carries `geniegpcid` (entitlement ON) — hand it to
   * {@link KalturaAvatarSession}. Returned verbatim, no SDK-side transform:
   * `avatars[].previewImageUrl`/`loadingVideoUrl` are raw backend asset URLs
   * (an upload echo for a custom visual, a preset asset URL for a catalog
   * item), not the rendered composite the live WHEP stream shows. READ (no
   * resource mutation).
   * @param {string} widgetKs A widget KS (NOT an admin KS).
   */
  async appInit(widgetKs) {
    if (!widgetKs) throw new KalturaError({ type: 'about:blank', title: 'widget KS required', code: 'bad_request', detail: 'appInit needs a widget KS (sessions.createWidgetToken).' });
    return (await this._.agentic('application/appInit', {}, widgetKs)).data;
  }

  /**
   * The fixed field schema `agents.create`/`agents.update`'s `customPrompt`
   * input accepts — a static, partner-agnostic descriptor array (`goal`,
   * `targetAudience`, `restrictedTopics`, `name`, `knowledge`), not a
   * partner's saved prompts. Render an "describe your agent" form straight
   * from this instead of hardcoding the 5 fields, so a new field the backend
   * adds shows up with no SDK/app changes. READ — no state, no partner
   * lookup (any valid KS works). Each entry also carries an unmodeled wire
   * field `objectType:"Object"` (harmless serialization metadata, not a real
   * field to model).
   * @param {string} ks
   * @returns {Promise<Array<{key:string, label:string, headerTemplate:string}>>}
   */
  async getCustomPrompts(ks) {
    this._.assertAny(ks);
    return (await this._.agentic('application/getCustomPrompts', {}, ks)).data;
  }
}
