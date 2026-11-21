/**
 * The whole app state in one pure reducer. Voice (client tools) and touch
 * (taps) both dispatch the same actions, so the screen and the agent cannot
 * drift apart.
 */
import {
  deviceById, accessoryById, planById, TRADE_IN_MODELS, TRADE_IN_CONDITIONS,
} from './catalog.js';

/** @typedef {'welcome'|'devices'|'device'|'compare'|'accessories'|'plans'|'tradein'|'cart'|'done'} SceneName */

/**
 * @typedef {object} Cart
 * @property {{id:string,colorId:string,storageGb:number}|null} device
 * @property {Record<string,number>} accessories  id → quantity
 * @property {string|null} planId
 * @property {{modelId:string,condition:string,value:number}|null} tradeIn
 */

/**
 * @typedef {object} State
 * @property {SceneName} scene
 * @property {SceneName[]} history   Scenes to return to with `back`.
 * @property {string|null} deviceId  Device being viewed.
 * @property {string|null} colorId   Color picked while viewing.
 * @property {number|null} storageGb Storage picked while viewing.
 * @property {string[]} compareIds
 * @property {Cart} cart
 * @property {{number:string,total:number}|null} order
 * @property {string[]} suggestions  Follow-up questions the agent offered as chips.
 */

/** @returns {State} */
export const initialState = () => ({
  scene: 'welcome', history: [], deviceId: null, colorId: null, storageGb: null, compareIds: [],
  cart: { device: null, accessories: {}, planId: null, tradeIn: null },
  order: null, suggestions: [],
});

const MAX_HISTORY = 12;

/** @param {State} s @param {SceneName} scene @returns {State} */
function goto(s, scene) {
  if (s.scene === scene) return s;
  const history = [...s.history, s.scene].slice(-MAX_HISTORY);
  return { ...s, scene, history };
}

/**
 * Trade-in value for an old phone in a given condition, or null for unknown input.
 * @param {string} modelId @param {string} condition
 */
export function tradeInValue(modelId, condition) {
  const m = TRADE_IN_MODELS.find((x) => x.id === modelId);
  const c = TRADE_IN_CONDITIONS.find((x) => x.id === condition);
  return m && c ? Math.round(m.base * c.factor) : null;
}

/**
 * Price of the selected device config.
 * @param {{id:string,storageGb:number}} d
 */
export function devicePrice(d) {
  const dev = deviceById(d.id);
  if (!dev) return 0;
  return dev.price + (dev.storage.find((s) => s.gb === d.storageGb)?.add ?? 0);
}

/**
 * Totals for a cart. `today` is the one-time amount, `monthly` the plan.
 * @param {Cart} cart
 */
export function cartTotals(cart) {
  const device = cart.device ? devicePrice(cart.device) : 0;
  const accessories = Object.entries(cart.accessories).reduce((n, [id, q]) => n + (accessoryById(id)?.price ?? 0) * q, 0);
  const tradeIn = cart.tradeIn ? Math.min(cart.tradeIn.value, device) : 0;
  const monthly = cart.planId ? planById(cart.planId)?.price ?? 0 : 0;
  return { device, accessories, tradeIn, today: Math.max(0, device + accessories - tradeIn), monthly };
}

/** @param {Cart} cart */
export const cartIsEmpty = (cart) => !cart.device && !Object.keys(cart.accessories).length && !cart.planId;

/** Small stable hash so the same cart always gets the same order number. @param {string} text */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 90000 + 10000;
}

/**
 * @param {State} state
 * @param {{type:string,[k:string]:any}} action
 * @returns {State}
 */
export function reducer(state, action) {
  switch (action.type) {
    case 'show': {
      const scene = /** @type {SceneName} */ (action.scene);
      if (scene === 'device') {
        const dev = deviceById(action.deviceId);
        if (!dev) return state;
        const sameDevice = state.deviceId === dev.id;
        const inCart = state.cart.device?.id === dev.id ? state.cart.device : null;
        const next = {
          ...state, deviceId: dev.id,
          colorId: sameDevice ? state.colorId : inCart?.colorId ?? dev.colors[0].id,
          storageGb: sameDevice ? state.storageGb : inCart?.storageGb ?? dev.storage[0].gb,
        };
        return goto(next, 'device');
      }
      if (scene === 'compare') {
        const ids = (action.deviceIds || []).filter((id) => deviceById(id));
        if (ids.length < 2) return state;
        return goto({ ...state, compareIds: ids.slice(0, 3) }, 'compare');
      }
      return goto(state, scene);
    }
    case 'back': {
      if (!state.history.length) return state;
      const history = state.history.slice(0, -1);
      return { ...state, scene: state.history[state.history.length - 1], history };
    }
    case 'choose-option': {
      const dev = deviceById(state.deviceId);
      if (!dev) return state;
      if (action.kind === 'color' && dev.colors.some((c) => c.id === action.value)) {
        const next = { ...state, colorId: action.value };
        return state.cart.device?.id === dev.id ? { ...next, cart: { ...state.cart, device: { ...state.cart.device, colorId: action.value } } } : next;
      }
      if (action.kind === 'storage' && dev.storage.some((s) => s.gb === action.value)) {
        const next = { ...state, storageGb: action.value };
        return state.cart.device?.id === dev.id ? { ...next, cart: { ...state.cart, device: { ...state.cart.device, storageGb: action.value } } } : next;
      }
      return state;
    }
    case 'add-device': {
      const dev = deviceById(state.deviceId);
      if (!dev) return state;
      return { ...state, cart: { ...state.cart, device: { id: dev.id, colorId: state.colorId ?? dev.colors[0].id, storageGb: state.storageGb ?? dev.storage[0].gb } } };
    }
    case 'add-accessory': {
      if (!accessoryById(action.id)) return state;
      const qty = Math.min(9, (state.cart.accessories[action.id] ?? 0) + 1);
      return { ...state, cart: { ...state.cart, accessories: { ...state.cart.accessories, [action.id]: qty } } };
    }
    case 'remove-accessory': {
      const { [action.id]: _gone, ...rest } = state.cart.accessories;
      return { ...state, cart: { ...state.cart, accessories: rest } };
    }
    case 'remove-device':
      return { ...state, cart: { ...state.cart, device: null, tradeIn: null } };
    case 'set-plan':
      return planById(action.id) ? { ...state, cart: { ...state.cart, planId: action.id } } : state;
    case 'clear-plan':
      return { ...state, cart: { ...state.cart, planId: null } };
    case 'set-trade-in': {
      const value = tradeInValue(action.modelId, action.condition);
      if (value == null) return state;
      return { ...state, cart: { ...state.cart, tradeIn: { modelId: action.modelId, condition: action.condition, value } } };
    }
    case 'clear-trade-in':
      return { ...state, cart: { ...state.cart, tradeIn: null } };
    case 'place-order': {
      if (cartIsEmpty(state.cart)) return state;
      const total = cartTotals(state.cart).today;
      const number = `GG-${hash(JSON.stringify(state.cart))}`;
      return goto({ ...state, order: { number, total } }, 'done');
    }
    case 'suggest': {
      const questions = [...new Set((action.questions || []).map((q) => String(q).trim().slice(0, 80)).filter(Boolean))].slice(0, 3);
      return questions.join('|') === state.suggestions.join('|') ? state : { ...state, suggestions: questions };
    }
    case 'reset':
      return initialState();
    default:
      return state;
  }
}
