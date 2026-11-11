/**
 * Checks on one intellect: speed hints, tool spiral risk and prompt mistakes.
 * Pure: they read the {@link IntellectView} `gather.js` built. They say what
 * the config makes likely, never what a turn measured, so each speed message
 * points at the probe. An external intellect has no brain config and is skipped.
 */
import { isSilentOpening } from '../../../core/opening.js';
import { CAPABILITY_DEFAULTS } from '../../capabilities.js';
import { toolRefId } from '../../tools.js';

/** @typedef {import('../model.js').IntellectView} IntellectView */
/** @typedef {import('../model.js').DoctorCheck} DoctorCheck */
/** @typedef {import('../../audit-report.js').AuditFinding} AuditFinding */

const MEASURE = 'Measure a real turn before you change it.';
/** The capabilities that add a tool when on. */
const TOOL_CAPABILITIES = ['use_knowledge_base', 'use_content_search', 'use_get_entry_content', 'use_related_files'];

/** The config, unless the intellect is external. @param {IntellectView} iv */
const brain = (iv) => (iv.config && iv.config.type !== 'external' ? iv.config : null);

/** @param {IntellectView} iv @param {Omit<AuditFinding,'configId'|'agentIds'>} rest @returns {AuditFinding} */
const about = (iv, rest) => ({ ...rest, configId: iv.configId, agentIds: iv.agentIds });

/** The stored or default state of a capability. @param {Record<string, any>} config @param {string} name */
const capability = (config, name) => config.capabilities?.[name] ?? CAPABILITY_DEFAULTS[name];

/** True when any agent on the intellect has an avatar. @param {IntellectView} iv */
const speaks = (iv) => iv.agents.some((a) => a.avatars.length > 0);

/** The wire config of a tool entity: `type`, `request`, `wait_for_response`, `timeout`, `description`. @param {any} tool */
const cfgOf = (tool) => tool?.config ?? {};

/** The tool entity a reference points at. @param {IntellectView} iv @param {unknown} ref */
const toolOf = (iv, ref) => (iv.tools ?? []).find((t) => String(t.id) === toolRefId(ref));

/** Dead air before speech: reasoning on an agent that talks. @type {DoctorCheck} */
export const latencyThinking = {
  id: 'latency-thinking', category: 'speed', scope: 'intellect', needs: ['intellect', 'avatars'], codes: ['latency_thinking'],
  run(/** @type {IntellectView} */ iv) {
    const c = brain(iv);
    if (!c || !speaks(iv)) return [];
    const model = c.model_configuration ?? {};
    const reasons = [
      ['medium', 'high'].includes(model.thinking_level) ? `thinking_level is "${model.thinking_level}"` : null,
      model.include_thoughts === true ? 'include_thoughts is true' : null,
      capability(c, 'think_process') === 'on' ? 'the think_process capability is on' : null,
    ].filter(Boolean);
    if (reasons.length === 0) return [];
    return [about(iv, {
      severity: 'info', code: 'latency_thinking', field: 'model_configuration',
      message: `${reasons.join(' and ')}. Reasoning time is silence before the avatar speaks. ${MEASURE}`,
      fix: 'For a spoken agent, try thinking_level "low" or "none", include_thoughts false and think_process "off".',
    })];
  },
};

/** Long replies mean long speech. @type {DoctorCheck} */
export const latencyOutputTokens = {
  id: 'latency-output-tokens', category: 'speed', scope: 'intellect', needs: ['intellect'], codes: ['latency_output_tokens'],
  run(/** @type {IntellectView} */ iv, /** @type {Required<import('../model.js').DoctorThresholds>} */ t) {
    const max = brain(iv)?.model_configuration?.max_output_tokens;
    if (!Number.isFinite(max) || max <= t.maxOutputTokens) return [];
    return [about(iv, {
      severity: 'info', code: 'latency_output_tokens', field: 'model_configuration.max_output_tokens',
      message: `max_output_tokens is ${max}, above ${t.maxOutputTokens}. Long replies mean long speech. ${MEASURE}`,
      fix: `Lower it, or tell the agent in the prompt to keep spoken answers short. Raise the limit with thresholds: { maxOutputTokens } if it is on purpose.`,
    })];
  },
};

/** Preloaded skills go into the system prompt on every turn. @type {DoctorCheck} */
export const latencyPreloadedSkills = {
  id: 'latency-preloaded-skills', category: 'speed', scope: 'intellect', needs: ['intellect', 'refs'], codes: ['latency_preloaded_skills'],
  run(/** @type {IntellectView} */ iv, /** @type {Required<import('../model.js').DoctorThresholds>} */ t) {
    const c = brain(iv);
    if (!c || iv.refs !== 'ok') return [];
    const preloaded = new Set((c.skill_ids ?? []).filter((/** @type {any} */ s) => s?.mode === 'preloaded').map((/** @type {any} */ s) => String(s.id)));
    const chosen = (iv.skills ?? []).filter((s) => preloaded.has(String(s.id)));
    const chars = chosen.reduce((sum, s) => sum + (typeof s.instructions === 'string' ? s.instructions.length : 0), 0);
    if (chars <= t.promptChars) return [];
    return [about(iv, {
      severity: 'info', code: 'latency_preloaded_skills', field: 'skill_ids',
      message: `${chosen.length} preloaded skill(s) add ${chars} characters to the system prompt on every turn, above ${t.promptChars}. ${MEASURE}`,
      fix: 'Set mode "adhoc" on the skills the agent needs only sometimes.',
    })];
  },
};

/** Long prompt blocks slow every turn. @type {DoctorCheck} */
export const latencyPromptSize = {
  id: 'latency-prompt-size', category: 'speed', scope: 'intellect', needs: ['intellect'], codes: ['latency_prompt_size'],
  run(/** @type {IntellectView} */ iv, /** @type {Required<import('../model.js').DoctorThresholds>} */ t) {
    const c = brain(iv);
    if (!c || !Array.isArray(c.prompts)) return [];
    const chars = c.prompts.reduce((/** @type {number} */ sum, /** @type {any} */ p) => sum + (typeof p?.value === 'string' ? p.value.length : 0), 0);
    if (chars <= t.promptChars) return [];
    return [about(iv, {
      severity: 'info', code: 'latency_prompt_size', field: 'prompts',
      message: `The prompt blocks hold ${chars} characters, above ${t.promptChars}. ${MEASURE}`,
      fix: 'Move rarely needed rules into a skill with mode "adhoc", or into the knowledge base.',
    })];
  },
};

/** A tool that runs before the first turn delays the opening. @type {DoctorCheck} */
export const threadStartToolBlocks = {
  id: 'thread-start-tool-blocks', category: 'speed', scope: 'intellect', needs: ['intellect', 'refs'], codes: ['thread_start_tool_blocks'],
  run(/** @type {IntellectView} */ iv) {
    const c = brain(iv);
    if (!c || iv.refs !== 'ok') return [];
    return (c.thread_start_tools ?? []).flatMap((/** @type {unknown} */ ref) => {
      const tool = toolOf(iv, ref);
      const cfg = cfgOf(tool);
      const wait = cfg.request?.timeout ?? 10;
      if (cfg.type !== 'api' || cfg.wait_for_response === false || !(wait > 10)) return [];
      return [about(iv, {
        severity: 'warn', code: 'thread_start_tool_blocks', field: `thread_start_tools ${tool.id}`,
        message: `Thread-start tool "${tool.name ?? tool.id}" can take up to ${wait} s and the first turn waits for it.`,
        fix: 'Set wait_for_response false on the tool, or lower request.timeout to 10 or less.',
      })];
    });
  },
};

/** More tools mean more room for a spiral. @type {DoctorCheck} */
export const toolSurfaceLarge = {
  id: 'tool-surface-large', category: 'speed', scope: 'intellect', needs: ['intellect'], codes: ['tool_surface_large'],
  run(/** @type {IntellectView} */ iv, /** @type {Required<import('../model.js').DoctorThresholds>} */ t) {
    const c = brain(iv);
    if (!c) return [];
    const parts = {
      tools: (c.tool_ids ?? []).length,
      'adhoc skills': (c.skill_ids ?? []).filter((/** @type {any} */ s) => s?.mode === 'adhoc' || s?.mode === 'adhoc-save').length,
      'MCP servers': c.mcp_servers && typeof c.mcp_servers === 'object' ? Object.keys(c.mcp_servers).length : 0,
      'built-in tools': TOOL_CAPABILITIES.filter((name) => capability(c, name) === 'on').length,
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    if (total <= t.toolSurface) return [];
    const used = Object.entries(parts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    const detail = used.length > 1 ? ` (${used.join(', ')})` : '';
    return [about(iv, {
      severity: 'info', code: 'tool_surface_large', field: 'tool_ids',
      message: `The model can choose from ${total} tools${detail}, above ${t.toolSurface}. More choices raise the risk of repeated tool calls in one turn.`,
      fix: 'Remove tools the agent does not need, or give a tool a condition so it is offered only when it applies.',
    })];
  },
};

/** A client tool with no `wait_for_response` blocks for 30 s unless the host answers. @type {DoctorCheck} */
export const clientToolWaitBlocks = {
  id: 'client-tool-wait-blocks', category: 'speed', scope: 'intellect', needs: ['intellect', 'refs'], codes: ['client_tool_wait_blocks'],
  run(/** @type {IntellectView} */ iv) {
    if (!brain(iv) || iv.refs !== 'ok') return [];
    return (iv.tools ?? []).filter((t) => cfgOf(t).type === 'client' && (cfgOf(t).wait_for_response ?? null) === null
      && (brain(iv)?.tool_ids ?? []).some((/** @type {unknown} */ ref) => toolRefId(ref) === String(t.id)))
      .map((t) => about(iv, {
        severity: 'info', code: 'client_tool_wait_blocks', field: `tool_ids ${t.id}`,
        message: `Client tool "${t.name ?? t.id}" does not set wait_for_response. Unset means the turn waits for your app, up to ${cfgOf(t).timeout ?? 30} s.`,
        fix: 'Set waitForResponse true and answer with session.respondToTool(), or set it to false if the app only reacts.',
      }));
  },
};

/** A client tool that does not wait can be called again and again in one turn. @type {DoctorCheck} */
export const clientToolFireAndForget = {
  id: 'client-tool-fire-and-forget', category: 'speed', scope: 'intellect', needs: ['intellect', 'refs'], codes: ['client_tool_fire_and_forget_unbudgeted'],
  run(/** @type {IntellectView} */ iv) {
    if (!brain(iv) || iv.refs !== 'ok') return [];
    const once = /\b(once|one time|single time|per turn|at most one)\b/i;
    return (iv.tools ?? []).filter((t) => cfgOf(t).type === 'client' && cfgOf(t).wait_for_response === false && !once.test(String(cfgOf(t).description ?? '')))
      .map((t) => about(iv, {
        severity: 'info', code: 'client_tool_fire_and_forget_unbudgeted', field: `tool_ids ${t.id}`,
        message: `Client tool "${t.name ?? t.id}" does not wait and its description does not say how often to call it. The model gets no result, so it may call it again.`,
        fix: 'Say in the description when to call it and that it is called once per turn.',
      }));
  },
};

/** @param {IntellectView} iv @returns {Array<{where:string, expr:string}>} Every condition string on the intellect. */
function conditionsOf(iv) {
  const c = iv.config ?? {};
  const fromRefs = (/** @type {string} */ key) => (Array.isArray(c[key]) ? c[key] : []).flatMap((/** @type {any} */ r, /** @type {number} */ i) => (typeof r?.condition === 'string' ? [{ where: `${key}[${i}]`, expr: r.condition }] : []));
  const prompts = (Array.isArray(c.prompts) ? c.prompts : []).flatMap((/** @type {any} */ p) => (typeof p?.condition === 'string' ? [{ where: `prompt ${p.key ?? ''}`.trim(), expr: p.condition }] : []));
  return [...prompts, ...fromRefs('skill_ids'), ...fromRefs('tool_ids')];
}

/** `plan == pro`: the right side is a name, not text, so it never equals the value. @type {DoctorCheck} */
export const conditionUnquotedName = {
  id: 'condition-unquoted-name', category: 'intellect', scope: 'intellect', needs: ['intellect'], codes: ['condition_unquoted_name'],
  run(/** @type {IntellectView} */ iv) {
    if (!brain(iv)) return [];
    const literal = new Set(['true', 'false', 'none', 'null']);
    return conditionsOf(iv).flatMap(({ where, expr }) => {
      const bare = expr.replace(/"[^"]*"|'[^']*'/g, '""');
      const hit = [...bare.matchAll(/(?:==|!=)\s*([A-Za-z]+)\b(?![\w(.])/g)].map((m) => m[1]).find((w) => !literal.has(w.toLowerCase()));
      if (!hit) return [];
      return [about(iv, {
        severity: 'info', code: 'condition_unquoted_name', field: where,
        message: `Condition "${expr}" compares with the bare name ${hit}. A name is read as a variable, not as text, so this does not match the text "${hit}". If ${hit} is a variable, ignore this.`,
        fix: `Quote the text: "${hit}" in double quotes.`,
      })];
    });
  },
};

/** The whole opening in one `{% if %}` with no `{% else %}` renders empty when false. @type {DoctorCheck} */
export const openingPhraseMayRenderEmpty = {
  id: 'opening-phrase-may-render-empty', category: 'intellect', scope: 'intellect', needs: ['intellect'], codes: ['opening_phrase_may_render_empty'],
  run(/** @type {IntellectView} */ iv) {
    const phrase = brain(iv)?.opening_phrase;
    if (typeof phrase !== 'string' || isSilentOpening(phrase)) return [];
    const text = phrase.trim();
    const wrapped = /^\{%-?\s*if\b/.test(text) && /\{%-?\s*endif\s*-?%\}$/.test(text);
    const ifs = text.match(/\{%-?\s*if\b/g)?.length ?? 0;
    if (!wrapped || ifs !== 1 || /\{%-?\s*(else|elif)\b/.test(text)) return [];
    return [about(iv, {
      severity: 'info', code: 'opening_phrase_may_render_empty', field: 'opening_phrase',
      message: 'The whole opening sits in one {% if %} with no {% else %}. When the condition is false the line renders empty, and the agent speaks its default greeting.',
      fix: 'Add an {% else %} branch with text, or with <blank> for a silent opening.',
    })];
  },
};
