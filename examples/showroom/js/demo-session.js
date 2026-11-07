/**
 * A scripted stand-in for `KalturaAvatarSession`. Same event names, same
 * `onToolCall` and `updateRequestVars` surface, no network and no credentials.
 * It powers `?demo` and the cross-browser tests, so the whole UI, including the
 * voice path, runs anywhere. The "brain" is a small keyword table, not an LLM.
 */
import { Emitter } from '../../../src/experience/emitter.js';
import { validateToolArgs } from '../../../src/core/stream.js';

/** [pattern, tool calls, reply, suggested questions]. First match wins. */
const RULES = [
  [/\b(back|previous)\b/i, [['go_back', {}]], 'Sure, back we go.'],
  [/\b(place|buy|order|check ?out|purchase)\b/i, [['place_order', {}]], 'Done! Your order is in. Thank you for shopping at Gizmo Grove.'],
  [/\b(add|take|want)\b.*\b(it|this|that)\b|\badd to (my )?cart\b/i, [['add_device_to_cart', {}]], 'Added to your cart.'],
  [/\b(cart|basket|total)\b/i, [['show_cart', {}]], 'Here is your cart with the total.'],
  [/\btrade/i, [['estimate_trade_in', { model: 'old-orbit', condition: 'good' }]], 'An older Orbit in good shape is worth about one ninety-five. I put it in your cart.'],
  [/\b(plan|plans|monthly|data)\b/i, [['show_plans', {}]], 'We have three plans. Plus is the popular one.', ['Pick the Plus plan', 'Can I trade in my phone?']],
  [/\b(earbuds|buds)\b/i, [['add_accessory', { accessory: 'buds' }]], 'Orbit Buds added. They last all day.'],
  [/\b(case)\b/i, [['add_accessory', { accessory: 'case-rugged' }]], 'I added the rugged case. It survives two meter drops.'],
  [/\b(accessor|charger)/i, [['show_accessories', {}]], 'Here are our accessories.', ['Add the earbuds', 'Show me my cart']],
  [/\b(compare|difference|versus|vs)\b/i, [['compare_devices', { devices: 'orbit-one,orbit-flip,orbit-lite' }]], 'Here they are side by side.'],
  [/\b(ember|orange)\b/i, [['choose_option', { kind: 'color', value: 'ember' }]], 'Ember looks great on it.'],
  [/\b(256)\b/, [['choose_option', { kind: 'storage', value: '256' }]], 'Two fifty-six gigabytes. Plenty of room.'],
  [/\bflip\b/i, [['show_device', { device: 'orbit-flip' }]], 'The Orbit Flip folds to fit a pocket. Here it is.', ['Add it to my cart', 'Show me a case for it']],
  [/\blite\b/i, [['show_device', { device: 'orbit-lite' }]], 'The Orbit Lite is our friendly price pick.', ['Add it to my cart', 'What plans do you have?']],
  [/\b(orbit one|the one|flagship)\b/i, [['show_device', { device: 'orbit-one' }]], 'The Orbit One is our flagship. It has a three day battery.', ['Add it to my cart', 'How does it compare?']],
  [/\b(phone|phones|show|browse|look)\b/i, [['show_devices', {}]], 'Here are our phones. Tap one or tell me which.', ['Which has the best battery?', 'Compare them for me']],
];

const GREETING = 'Hi, I am Juno, your guide at Gizmo Grove. Tell me what you are looking for, or just tap.';

export class DemoSession extends Emitter {
  /** @param {{speed?:number}} [opts] `speed` scales speech time; `0` makes it instant (tests). */
  constructor({ speed = 1 } = {}) {
    super();
    this.speed = speed;
    this.connected = false;
    this.muted = false;
    /** Last request vars the app sent. Tests read it. */
    this.requestVars = {};
    /** Every typed turn, in order. Tests read it. */
    this.turns = [];
    this._handlers = new Map();
    this._schemas = new Map();
    this._timers = new Set();
    this._speech = 0;
  }

  _later(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms * this.speed);
    this._timers.add(t);
  }

  async connect() {
    this.connected = true;
    this.emit('streamReady', {});
    this._later(() => this._say(GREETING), 300);
  }

  /** @param {string} name @param {(args:object)=>unknown} handler @param {object} [schema] */
  onToolCall(name, handler, schema) {
    const list = this._handlers.get(name) || [];
    list.push(handler);
    this._handlers.set(name, list);
    if (schema) this._schemas.set(name, schema);
    return () => { this._handlers.set(name, (this._handlers.get(name) || []).filter((h) => h !== handler)); };
  }

  /** @param {Record<string,string|number|boolean|null>} vars */
  updateRequestVars(vars) { this.requestVars = { ...this.requestVars, ...vars }; }

  /** A typed turn: what the app sends for taps. @param {string} text */
  async speak(text) {
    this.turns.push(text);
    this._think(text, false);
    return true;
  }

  /** Test and demo helper: pretend the customer said something aloud. @param {string} text */
  hear(text) {
    this.emit('userStartedTalking', {});
    this.emit('transcript', { text, type: 'user', speechId: null, words: [] });
    this._think(text, true);
  }

  _think(text, spoken) {
    this.emit('responsePending', {});
    this._later(() => {
      const isNote = !spoken && text.startsWith('[');
      const rule = isNote ? null : RULES.find(([re]) => re.test(text));
      this.emit('turnStart', { isNewTurn: true });
      if (rule) {
        for (const [name, args] of rule[1]) this._call(name, args);
        if (rule[3]) this._call('suggest_next', { questions: rule[3].join('|') });
        this._say(rule[2]);
      } else this._say(isNote ? 'Good choice.' : 'I can help with phones, accessories, plans and trade-ins. What would you like?');
    }, 250);
  }

  _call(name, args) {
    const check = validateToolArgs(args, this._schemas.get(name));
    const call = { name, args, raw: JSON.stringify(args) };
    if (!check.ok) { this.emit('toolCallInvalid', { call, errors: check.errors }); return; }
    this.emit('toolCall', call);
    for (const h of this._handlers.get(name) || []) {
      try { const value = h(args, call); if (value !== undefined) this.emit('toolCallResult', { call, ok: true, value }); } catch (error) { this.emit('toolCallResult', { call, ok: false, error }); }
    }
  }

  _say(text) {
    this.emit('responseSettled', {});
    this.emit('avatarStartTalking', {});
    const durationMs = Math.max(400, text.split(' ').length * 140);
    const speechId = `demo-${++this._speech}`;
    this.emit('transcript', { text, type: 'final', speechId, words: [] });
    this.emit('speechChunk', { text, durationMs, speechId });
    this._later(() => { this.emit('avatarStopTalking', {}); this.emit('turnEnd', {}); }, durationMs);
  }

  mute() { this.muted = true; this.emit('hardwareMuteChanged', { muted: true }); }
  unmute() { this.muted = false; this.emit('hardwareMuteChanged', { muted: false }); }
  async startPlayback() { return true; }
  muteAudioOutput() {}
  unmuteAudioOutput() {}
  interrupt() { this.emit('interrupted', {}); }
  disconnect() {
    this.connected = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.emit('ended', {});
  }
}
