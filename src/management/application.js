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
   * {@link KalturaAvatarSession}. READ (no resource mutation).
   * @param {string} widgetKs A widget KS (NOT an admin KS).
   */
  async appInit(widgetKs) {
    if (!widgetKs) throw new KalturaError({ type: 'about:blank', title: 'widget KS required', code: 'bad_request', detail: 'appInit needs a widget KS (sessions.createWidgetToken).' });
    return (await this._.agentic('application/appInit', {}, widgetKs)).data;
  }
}
