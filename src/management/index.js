/**
 * @kaltura/intelligent-agents/management — the Management front.
 *
 * Provision, configure, and measure conversational avatar agents over the two
 * REST backends (Agentic + Genie). Server-side surface: needs the admin secret
 * to mint tokens. Every method states its required token scope in JSDoc and
 * enforces it before any network call.
 *
 * @example
 * import { Management } from '@kaltura/intelligent-agents/management';
 * const kaltura = new Management({ partnerId: PID, adminSecret: SECRET });
 * const admin = await kaltura.sessions.createAdminToken();
 * const result = await kaltura.provision({ brief: 'A friendly yoga receptionist', ks: admin.ks });
 * // hand the browser a scoped, entitlement-ON token — admin secret never leaves the server:
 * const conv = await kaltura.sessions.createConversationToken({ configId: result.configId });
 */
export { Management } from './client.js';
export { Sessions } from '../core/session.js';
export { KalturaError } from '../core/errors.js';
export { inspectKs } from './ks-inspect.js';
export { summarizeReport, parseCsv, SPIRAL_RECOVERY_PREFIX } from './conversations.js';
export { collectConverse, parseConverseStream, validateToolArgs, canonicalJson } from '../core/stream.js';
export { uuidv4, randId, meta } from '../core/ids.js';
export { redact } from '../core/redact.js';
// Production-resource delete guard: a cleanup-by-tag sweep must not nuke a real agent.
// `agents.delete` refuses a PROTECTED_TAGS-tagged agent unless { allowProtected:true }.
export { PROTECTED_TAGS, matchProtectedTag, resolveIntellectId, EMBED_TYPES } from './agents.js';
// Skills — partner-level reusable instruction snippets (`v1/skill/*` on Genie).
// The resource instance lives on `mgmt.skills`; the class export is for typing/extension.
export { Skills } from './skills.js';
export {
  CAPABILITIES, CAPABILITY_STATE, CAPABILITY_DEFAULTS, CAPABILITY_INFO,
  assertCapability, assertCapabilityState, validateCapabilities,
  mergeCapabilityWrite, resolveCapabilities,
} from './capabilities.js';
// Custom LLM-callable tools: typed builders + validators for api/csv/code/client tools.
// `tools.api/csv/code` build a validated GenieToolConfig; `tools.validate` checks one.
// `tools.client` builds a native type:"client" tool — the silent type:"tool" channel for
// navigate_to_slide / show_widget / call_page_function, with tool_metadata ACK support
// (`waitForResponse`/`session.respondToTool`). `clientToolReadiness` lints the two
// deployment gotchas any tool-referencing intellect hits (experiences out-compete + the
// 24h capability cache).
export { tools, clientToolReadiness, client, applyResponseMapping, findIntellectsReferencingTool, TOOL_TYPES, HTTP_METHODS, ARG_TYPES } from './tools.js';
// Secrets ref-checker: the CRUD class lives on `mgmt.intellects.secrets`; this is the pure helper.
export { validateSecretRefs } from './secrets.js';
// Prompt authoring depth: linters + client-side system-prompt preview.
export {
  lintPrompts, validatePromptVars, lintGlossary, assembleSystemPrompt, SYS_VARS, SYS_NAMESPACES,
} from './prompt-lint.js';
// Brain-config + intellect-config helpers.
export { buildBrainConfigPatch } from './intellects.js';
export { IntellectConfig, buildUserPropertiesForms, CALL_STAGES, SKILL_MODES } from './intellect-config.js';
// Knowledge / RAG indexer enums — ChapterType/Strategy + the objects[] builder.
export {
  CHAPTER_TYPE, STRATEGY, EMBED, MODALITIES, normalizeModality, buildIndexerObjects,
} from '../core/knowledge-enums.js';
// Converse stream helpers: segment classification + the runtime-name set +
// the client-side-command tool-call parser (the headless peer of session.onToolCall).
export { GENUI_RUNTIMES, segmentKind, parseToolCall, parseToolResponseName } from '../core/stream.js';
// CRM AI-SDR recipes: validated api-tool builders for HubSpot/Salesforce contact upsert.
export { hubspotContactUpsert, salesforceContactUpsert } from './crm-recipes.js';
