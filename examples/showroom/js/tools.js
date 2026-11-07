/**
 * The client tools Juno can call. One list drives three things: the agent
 * definition (agent/spec.mjs), the browser-side argument check, and the
 * mapping from a tool call to store actions. Pure, no DOM, no network.
 */
import {
  DEVICES, ACCESSORIES, PLANS, TRADE_IN_MODELS, TRADE_IN_CONDITIONS, deviceById, findLoose,
} from './catalog.js';

/** Shared tail of every tool description. Keeps the model from looping on tools. */
export const TOOL_SUFFIX = ' Call it once, then speak in the same turn. Never call a tool again to confirm it worked.';

/**
 * @typedef {{prompt:string,type:'str'|'int'|'float'|'bool'|'list'|'dict',required?:boolean}} ArgSpec
 * @typedef {{name:string,displayName:string,description:string,args?:Record<string,ArgSpec>}} ToolSpec
 */

const idList = (list) => list.map((x) => x.id).join(', ');

/** @type {ToolSpec[]} */
export const TOOL_SPECS = [
  { name: 'show_devices', displayName: 'Show devices', description: 'Shows all phones on the screen. Use when the customer wants to look at phones or asks what is available.' },
  {
    name: 'show_device', displayName: 'Show one device',
    description: 'Shows the detail page of one phone, with its colors and storage options.',
    args: { device: { prompt: `Phone id. One of: ${idList(DEVICES)}.`, type: 'str' } },
  },
  {
    name: 'choose_option', displayName: 'Choose color or storage',
    description: 'Picks a color or a storage size for the phone on screen.',
    args: {
      kind: { prompt: 'Either "color" or "storage".', type: 'str' },
      value: { prompt: 'The color id or name, or the storage size in GB such as 256.', type: 'str' },
      device: { prompt: 'Phone id, only if it is not the phone already on screen.', type: 'str', required: false },
    },
  },
  {
    name: 'compare_devices', displayName: 'Compare phones',
    description: 'Shows two or three phones side by side.',
    args: { devices: { prompt: `Comma-separated phone ids, from: ${idList(DEVICES)}.`, type: 'str' } },
  },
  {
    name: 'add_device_to_cart', displayName: 'Add phone to cart',
    description: 'Adds a phone to the cart with the chosen color and storage. Defaults to the phone and options on screen.',
    args: {
      device: { prompt: 'Phone id, only if it is not the phone already on screen.', type: 'str', required: false },
      color: { prompt: 'Color id or name.', type: 'str', required: false },
      storage: { prompt: 'Storage size in GB.', type: 'str', required: false },
    },
  },
  { name: 'show_accessories', displayName: 'Show accessories', description: 'Shows cases, earbuds, chargers and screen guards.' },
  {
    name: 'add_accessory', displayName: 'Add accessory',
    description: 'Adds one accessory to the cart.',
    args: { accessory: { prompt: `Accessory id. One of: ${idList(ACCESSORIES)}.`, type: 'str' } },
  },
  { name: 'show_plans', displayName: 'Show plans', description: 'Shows the monthly plans.' },
  {
    name: 'choose_plan', displayName: 'Choose plan',
    description: 'Puts a monthly plan in the cart.',
    args: { plan: { prompt: `Plan id. One of: ${idList(PLANS)}.`, type: 'str' } },
  },
  {
    name: 'estimate_trade_in', displayName: 'Estimate trade-in',
    description: 'Shows the trade-in screen with a value for the customer\'s old phone and puts it in the cart.',
    args: {
      model: { prompt: `Old phone type. One of: ${idList(TRADE_IN_MODELS)}.`, type: 'str' },
      condition: { prompt: `Condition. One of: ${idList(TRADE_IN_CONDITIONS)}.`, type: 'str' },
    },
  },
  {
    name: 'remove_from_cart', displayName: 'Remove from cart',
    description: 'Removes one thing from the cart.',
    args: { item: { prompt: `What to remove: "device", "plan", "trade_in", or an accessory id (${idList(ACCESSORIES)}).`, type: 'str' } },
  },
  { name: 'show_cart', displayName: 'Show cart', description: 'Shows the cart with the total.' },
  { name: 'place_order', displayName: 'Place order', description: 'Places the order for what is in the cart. Only call after the customer clearly says to buy.' },
  { name: 'go_back', displayName: 'Go back', description: 'Returns to the previous screen.' },
  {
    name: 'suggest_next', displayName: 'Suggest next questions',
    description: 'Shows two or three tappable follow-up questions under the screen. Use after you answer, so the customer can tap instead of talk.',
    args: { questions: { prompt: 'Two or three short questions the customer might ask next, each under eight words, written as the customer would say them, separated by the | character.', type: 'str' } },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

/**
 * The `{type, required}` schema `session.onToolCall` checks before a handler runs.
 * @param {ToolSpec} spec
 */
export function argSchema(spec) {
  /** @type {Record<string,{type:string,required:boolean}>} */
  const out = {};
  for (const [k, a] of Object.entries(spec.args || {})) out[k] = { type: a.type, required: a.required !== false };
  return out;
}

/**
 * @typedef {{type:string,[k:string]:any}} Action
 * @typedef {{actions:Action[]}|{error:string}} ToolResult
 */

const bad = (error) => ({ error });

/**
 * Turn a tool call into store actions. Unknown or unusable arguments give an
 * `{error}` and change nothing, so a confused model cannot corrupt state.
 * @param {string} name
 * @param {Record<string,any>} args
 * @param {import('./reducer.js').State} state
 * @returns {ToolResult}
 */
export function toActions(name, args = {}, state) {
  switch (name) {
    case 'show_devices': return { actions: [{ type: 'show', scene: 'devices' }] };
    case 'show_device': {
      const d = findLoose(DEVICES, args.device);
      return d ? { actions: [{ type: 'show', scene: 'device', deviceId: d.id }] } : bad(`Unknown device "${args.device}".`);
    }
    case 'choose_option': return chooseOption(args, state);
    case 'compare_devices': {
      const ids = String(args.devices ?? '').split(/[,;]| and /).map((s) => findLoose(DEVICES, s)?.id).filter(Boolean);
      const unique = [...new Set(ids)];
      return unique.length >= 2 ? { actions: [{ type: 'show', scene: 'compare', deviceIds: unique }] } : bad('Need two or three known devices to compare.');
    }
    case 'add_device_to_cart': {
      const pre = [];
      if (args.device) {
        const d = findLoose(DEVICES, args.device);
        if (!d) return bad(`Unknown device "${args.device}".`);
        if (state.deviceId !== d.id) pre.push({ type: 'show', scene: 'device', deviceId: d.id });
      } else if (!state.deviceId) return bad('No phone on screen. Show a phone first or pass a device.');
      const devId = args.device ? findLoose(DEVICES, args.device).id : state.deviceId;
      const opts = [];
      if (args.color) { const r = chooseOption({ kind: 'color', value: args.color, device: devId }, state); if ('error' in r) return r; opts.push(...r.actions.filter((a) => a.type === 'choose-option')); }
      if (args.storage) { const r = chooseOption({ kind: 'storage', value: args.storage, device: devId }, state); if ('error' in r) return r; opts.push(...r.actions.filter((a) => a.type === 'choose-option')); }
      return { actions: [...pre, ...opts, { type: 'add-device' }, { type: 'show', scene: 'cart' }] };
    }
    case 'show_accessories': return { actions: [{ type: 'show', scene: 'accessories' }] };
    case 'add_accessory': {
      const a = findLoose(ACCESSORIES, args.accessory);
      return a ? { actions: [{ type: 'add-accessory', id: a.id }, { type: 'show', scene: 'accessories' }] } : bad(`Unknown accessory "${args.accessory}".`);
    }
    case 'show_plans': return { actions: [{ type: 'show', scene: 'plans' }] };
    case 'choose_plan': {
      const p = findLoose(PLANS, args.plan);
      return p ? { actions: [{ type: 'set-plan', id: p.id }, { type: 'show', scene: 'plans' }] } : bad(`Unknown plan "${args.plan}".`);
    }
    case 'estimate_trade_in': {
      const m = findLoose(TRADE_IN_MODELS, args.model);
      const c = findLoose(TRADE_IN_CONDITIONS, args.condition);
      return m && c ? { actions: [{ type: 'set-trade-in', modelId: m.id, condition: c.id }, { type: 'show', scene: 'tradein' }] } : bad('Unknown trade-in model or condition.');
    }
    case 'remove_from_cart': return removeFromCart(args.item);
    case 'show_cart': return { actions: [{ type: 'show', scene: 'cart' }] };
    case 'place_order': return { actions: [{ type: 'place-order' }] };
    case 'go_back': return { actions: [{ type: 'back' }] };
    case 'suggest_next': {
      const questions = String(args.questions ?? '').split(/[|\n]/).map((q) => q.trim()).filter(Boolean);
      return questions.length ? { actions: [{ type: 'suggest', questions }] } : bad('Give at least one question.');
    }
    default: return bad(`Unknown tool "${name}".`);
  }
}

/** @param {Record<string,any>} args @param {import('./reducer.js').State} state @returns {ToolResult} */
function chooseOption(args, state) {
  const pre = [];
  let dev = deviceById(state.deviceId);
  if (args.device) {
    const d = findLoose(DEVICES, args.device);
    if (!d) return bad(`Unknown device "${args.device}".`);
    if (!dev || dev.id !== d.id) pre.push({ type: 'show', scene: 'device', deviceId: d.id });
    dev = d;
  }
  if (!dev) return bad('No phone on screen. Show a phone first.');
  if (args.kind === 'color') {
    const c = findLoose(dev.colors, args.value);
    return c ? { actions: [...pre, { type: 'choose-option', kind: 'color', value: c.id }] } : bad(`${dev.name} has no color "${args.value}".`);
  }
  if (args.kind === 'storage') {
    const gb = Number(String(args.value).replace(/[^\d]/g, ''));
    return dev.storage.some((s) => s.gb === gb) ? { actions: [...pre, { type: 'choose-option', kind: 'storage', value: gb }] } : bad(`${dev.name} has no ${args.value} GB option.`);
  }
  return bad('kind must be "color" or "storage".');
}

/** @param {unknown} item @returns {ToolResult} */
function removeFromCart(item) {
  const key = String(item ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (key === 'device' || key === 'phone') return { actions: [{ type: 'remove-device' }] };
  if (key === 'plan') return { actions: [{ type: 'clear-plan' }] };
  if (key === 'trade_in' || key === 'tradein' || key === 'trade-in') return { actions: [{ type: 'clear-trade-in' }] };
  const a = findLoose(ACCESSORIES, item);
  return a ? { actions: [{ type: 'remove-accessory', id: a.id }] } : bad(`Unknown cart item "${item}".`);
}
