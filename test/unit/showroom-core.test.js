// Showroom example: the pure core (catalog, reducer, tools, vars, layout). No DOM, no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICES, ACCESSORIES, PLANS, findLoose, catalogText, deviceById } from '../../examples/showroom/js/catalog.js';
import { reducer, initialState, cartTotals, cartIsEmpty, tradeInValue } from '../../examples/showroom/js/reducer.js';
import { createStore } from '../../examples/showroom/js/store.js';
import { TOOL_SPECS, TOOL_NAMES, TOOL_SUFFIX, argSchema, toActions } from '../../examples/showroom/js/tools.js';
import { screenText, cartText, tapNote } from '../../examples/showroom/js/vars.js';
import { pickLayout, unitFor, presentDirection } from '../../examples/showroom/js/layout.js';

const run = (state, ...actions) => actions.reduce((s, a) => reducer(s, a), state);
const call = (state, name, args) => {
  const r = toActions(name, args, state);
  assert.ok(!('error' in r), `${name} failed: ${r.error}`);
  return run(state, ...r.actions);
};

describe('catalog', () => {
  test('findLoose matches id, name, unique word, and rejects ambiguity', () => {
    assert.equal(findLoose(DEVICES, 'orbit-one').id, 'orbit-one');
    assert.equal(findLoose(DEVICES, 'Orbit Flip').id, 'orbit-flip');
    assert.equal(findLoose(DEVICES, 'flip').id, 'orbit-flip');
    assert.equal(findLoose(DEVICES, 'orbit'), null);
    assert.equal(findLoose(DEVICES, ''), null);
    assert.equal(findLoose(DEVICES, undefined), null);
  });
  test('catalog text names every device, accessory and plan id', () => {
    const t = catalogText();
    for (const x of [...DEVICES, ...ACCESSORIES, ...PLANS]) assert.ok(t.includes(x.id), x.id);
  });
});

describe('reducer', () => {
  test('show device seeds defaults and records history; back returns', () => {
    let s = run(initialState(), { type: 'show', scene: 'devices' }, { type: 'show', scene: 'device', deviceId: 'orbit-one' });
    assert.equal(s.scene, 'device');
    assert.equal(s.colorId, 'moon');
    assert.equal(s.storageGb, 128);
    s = run(s, { type: 'back' });
    assert.equal(s.scene, 'devices');
  });
  test('unknown device or option changes nothing (same reference)', () => {
    const s = initialState();
    assert.equal(reducer(s, { type: 'show', scene: 'device', deviceId: 'nope' }), s);
    const d = run(s, { type: 'show', scene: 'device', deviceId: 'orbit-one' });
    assert.equal(reducer(d, { type: 'choose-option', kind: 'color', value: 'pink' }), d);
    assert.equal(reducer(d, { type: 'choose-option', kind: 'storage', value: 7 }), d);
  });
  test('options changed after adding to cart update the cart line', () => {
    let s = run(initialState(), { type: 'show', scene: 'device', deviceId: 'orbit-one' }, { type: 'add-device' });
    s = run(s, { type: 'choose-option', kind: 'storage', value: 512 }, { type: 'choose-option', kind: 'color', value: 'tide' });
    assert.deepEqual(s.cart.device, { id: 'orbit-one', colorId: 'tide', storageGb: 512 });
  });
  test('returning to a carted device shows its cart options', () => {
    let s = run(initialState(), { type: 'show', scene: 'device', deviceId: 'orbit-one' }, { type: 'choose-option', kind: 'color', value: 'ember' }, { type: 'add-device' });
    s = run(s, { type: 'show', scene: 'device', deviceId: 'orbit-lite' }, { type: 'show', scene: 'device', deviceId: 'orbit-one' });
    assert.equal(s.colorId, 'ember');
  });
  test('totals: device storage upcharge, accessories, trade-in capped at device price, plan monthly', () => {
    let s = run(initialState(), { type: 'show', scene: 'device', deviceId: 'orbit-lite' }, { type: 'choose-option', kind: 'storage', value: 128 }, { type: 'add-device' });
    s = run(s, { type: 'add-accessory', id: 'buds' }, { type: 'add-accessory', id: 'buds' }, { type: 'set-plan', id: 'plus' }, { type: 'set-trade-in', modelId: 'other-flagship', condition: 'great' });
    const t = cartTotals(s.cart);
    assert.deepEqual(t, { device: 459, accessories: 258, tradeIn: 320, today: 397, monthly: 40 });
    const big = { ...s.cart, tradeIn: { modelId: 'x', condition: 'great', value: 9999 } };
    assert.equal(cartTotals(big).tradeIn, 459);
  });
  test('accessory quantity is capped at 9', () => {
    let s = initialState();
    for (let i = 0; i < 20; i++) s = reducer(s, { type: 'add-accessory', id: 'charger' });
    assert.equal(s.cart.accessories.charger, 9);
  });
  test('order needs a non-empty cart, number is stable for the same cart', () => {
    const empty = initialState();
    assert.equal(reducer(empty, { type: 'place-order' }), empty);
    const filled = run(empty, { type: 'add-accessory', id: 'charger' });
    const a = reducer(filled, { type: 'place-order' });
    const b = reducer(filled, { type: 'place-order' });
    assert.match(a.order.number, /^GG-\d{5}$/);
    assert.equal(a.order.number, b.order.number);
    assert.equal(a.scene, 'done');
  });
  test('history is bounded', () => {
    let s = initialState();
    for (let i = 0; i < 40; i++) s = reducer(s, { type: 'show', scene: i % 2 ? 'plans' : 'accessories' });
    assert.ok(s.history.length <= 12);
  });
  test('tradeInValue rejects unknown input', () => {
    assert.equal(tradeInValue('old-orbit', 'good'), 195);
    assert.equal(tradeInValue('zzz', 'good'), null);
  });
  test('the reducer never mutates its input', () => {
    const s = Object.freeze(run(initialState(), { type: 'add-accessory', id: 'buds' }));
    assert.doesNotThrow(() => reducer(s, { type: 'add-accessory', id: 'buds' }));
  });
});

describe('store', () => {
  test('notifies on change only, supports unsubscribe', () => {
    const store = createStore(reducer, initialState());
    const seen = [];
    const off = store.subscribe((n, p, a) => seen.push(a.type));
    store.dispatch({ type: 'show', scene: 'plans' });
    store.dispatch({ type: 'show', scene: 'plans' });
    store.dispatch({ type: 'bogus' });
    off();
    store.dispatch({ type: 'show', scene: 'cart' });
    assert.deepEqual(seen, ['show']);
  });
});

describe('tools', () => {
  test('every spec has a unique name, a description, and string-typed args the platform accepts', () => {
    assert.equal(new Set(TOOL_NAMES).size, TOOL_SPECS.length);
    for (const t of TOOL_SPECS) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/);
      assert.ok(t.description.length > 10);
      for (const a of Object.values(t.args || {})) assert.ok(['str', 'int', 'float', 'bool', 'list', 'dict'].includes(a.type));
    }
    assert.ok(TOOL_SUFFIX.length > 10);
  });
  test('descriptions never refer to script steps', () => {
    for (const t of TOOL_SPECS) assert.doesNotMatch(t.description, /\bstep\s*\d/i);
  });
  test('argSchema marks args required unless declared optional', () => {
    const s = argSchema(TOOL_SPECS.find((t) => t.name === 'choose_option'));
    assert.deepEqual(s, { kind: { type: 'str', required: true }, value: { type: 'str', required: true }, device: { type: 'str', required: false } });
  });
  test('a full voice journey reaches a placed order', () => {
    let s = initialState();
    s = call(s, 'show_devices');
    s = call(s, 'show_device', { device: 'Orbit Flip' });
    s = call(s, 'choose_option', { kind: 'color', value: 'mint' });
    s = call(s, 'choose_option', { kind: 'storage', value: '512 GB' });
    s = call(s, 'add_device_to_cart', {});
    s = call(s, 'add_accessory', { accessory: 'rugged case' });
    s = call(s, 'choose_plan', { plan: 'max' });
    s = call(s, 'estimate_trade_in', { model: 'old-orbit', condition: 'good' });
    s = call(s, 'place_order');
    assert.equal(s.scene, 'done');
    assert.deepEqual(s.cart.device, { id: 'orbit-flip', colorId: 'mint', storageGb: 512 });
    assert.equal(s.cart.planId, 'max');
  });
  test('add_device_to_cart can do everything in one call', () => {
    const s = call(initialState(), 'add_device_to_cart', { device: 'orbit-one', color: 'ember', storage: '256' });
    assert.deepEqual(s.cart.device, { id: 'orbit-one', colorId: 'ember', storageGb: 256 });
    assert.equal(s.scene, 'cart');
  });
  test('bad arguments return an error and the state is untouched', () => {
    const s = initialState();
    for (const [n, a] of [['show_device', { device: 'zz' }], ['choose_option', { kind: 'color', value: 'red' }], ['add_accessory', { accessory: 'rocket' }], ['choose_plan', { plan: 'gold' }], ['compare_devices', { devices: 'orbit-one' }], ['remove_from_cart', { item: 'moon' }], ['nope', {}]]) {
      assert.ok('error' in toActions(n, a, s), n);
    }
    const onDevice = run(s, { type: 'show', scene: 'device', deviceId: 'orbit-lite' });
    assert.ok('error' in toActions('choose_option', { kind: 'storage', value: 512 }, onDevice));
    assert.ok('error' in toActions('choose_option', { kind: 'size', value: 1 }, onDevice));
  });
  test('suggest_next keeps up to three clean, unique questions and an empty list clears them', () => {
    const s = call(initialState(), 'suggest_next', { questions: ' Add it | Add it |Show a case\nWhat plans?|A fourth one ' });
    assert.deepEqual(s.suggestions, ['Add it', 'Show a case', 'What plans?']);
    assert.equal(reducer(s, { type: 'suggest', questions: ['Add it', 'Show a case', 'What plans?'] }), s, 'same list is not a state change');
    assert.deepEqual(run(s, { type: 'suggest', questions: [] }).suggestions, []);
    assert.deepEqual(run(s, { type: 'reset' }).suggestions, []);
    assert.ok('error' in toActions('suggest_next', { questions: ' | ' }, s));
    assert.equal(call(initialState(), 'suggest_next', { questions: 'x'.repeat(200) }).suggestions[0].length, 80);
  });
  test('compare takes loose lists', () => {
    const s = call(initialState(), 'compare_devices', { devices: 'orbit one and flip' });
    assert.deepEqual(s.compareIds, ['orbit-one', 'orbit-flip']);
  });
  test('remove_from_cart handles every kind of item', () => {
    let s = call(initialState(), 'add_device_to_cart', { device: 'orbit-lite' });
    s = call(s, 'add_accessory', { accessory: 'charger' });
    s = call(s, 'choose_plan', { plan: 'plus' });
    s = call(s, 'estimate_trade_in', { model: 'other-budget', condition: 'fair' });
    for (const item of ['trade in', 'plan', 'charger', 'device']) s = call(s, 'remove_from_cart', { item });
    assert.ok(cartIsEmpty(s.cart));
    assert.equal(s.cart.tradeIn, null);
  });
});

describe('vars', () => {
  test('screen and cart text describe the state in plain words', () => {
    let s = call(initialState(), 'show_device', { device: 'orbit-one' });
    assert.match(screenText(s), /Orbit One page.*Moon White.*128 GB.*\$799/);
    s = call(s, 'add_device_to_cart', {});
    assert.match(cartText(s.cart), /Orbit One, Moon White, 128 GB, \$799.*Due today \$799/);
    assert.equal(cartText(initialState().cart), 'The cart is empty.');
  });
  test('screenText covers every scene', () => {
    const base = call(call(initialState(), 'show_device', { device: 'orbit-one' }), 'add_accessory', { accessory: 'buds' });
    for (const scene of ['welcome', 'devices', 'accessories', 'plans', 'tradein', 'cart']) assert.ok(screenText({ ...base, scene }).length > 5, scene);
    assert.match(screenText({ ...base, scene: 'compare', compareIds: ['orbit-one', 'orbit-lite'] }), /Orbit One and Orbit Lite/);
    assert.match(screenText({ ...base, scene: 'done', order: { number: 'GG-12345', total: 1 } }), /GG-12345/);
  });
  test('taps produce a note only for meaningful actions', () => {
    const a = initialState();
    const act = { type: 'show', scene: 'device', deviceId: 'orbit-lite' };
    const b = reducer(a, act);
    assert.equal(tapNote(a, b, act), '[The customer tapped Orbit Lite.]');
    const pick = { type: 'choose-option', kind: 'color', value: 'sky' };
    assert.equal(tapNote(b, reducer(b, pick), pick), '[The customer picked the color Skyline.]');
    const back = { type: 'back' };
    assert.equal(tapNote(b, reducer(b, back), back), null);
  });
  test('a voice call and the matching tap leave identical state', () => {
    const viaVoice = call(initialState(), 'add_device_to_cart', { device: 'orbit-flip', color: 'lilac', storage: '256' });
    const viaTaps = run(initialState(),
      { type: 'show', scene: 'device', deviceId: 'orbit-flip' }, { type: 'choose-option', kind: 'color', value: 'lilac' },
      { type: 'choose-option', kind: 'storage', value: 256 }, { type: 'add-device' }, { type: 'show', scene: 'cart' });
    assert.deepEqual(viaVoice.cart, viaTaps.cart);
    assert.equal(viaVoice.scene, viaTaps.scene);
    assert.equal(deviceById(viaVoice.cart.device.id).name, 'Orbit Flip');
  });
});

describe('layout', () => {
  const cases = [
    [{ width: 390, height: 844 }, 'phone'],
    [{ width: 430, height: 932 }, 'phone'],
    [{ width: 820, height: 1180 }, 'tall'],
    [{ width: 1080, height: 1920 }, 'tall'],
    [{ width: 1366, height: 768 }, 'wide'],
    [{ width: 1920, height: 1080 }, 'wide'],
    [{ width: 844, height: 390 }, 'wide'],
    [{ width: 1024, height: 1024 }, 'wide'],
    [{ width: 3840, height: 2160 }, 'wide'],
  ];
  for (const [vp, want] of cases) test(`${vp.width}x${vp.height} → ${want}`, () => assert.equal(pickLayout(vp), want));
  test('unit scales with the screen and the font never drops below 14px', () => {
    assert.equal(unitFor('tall', { width: 1080, height: 1920 }).unit, 1);
    assert.equal(unitFor('wide', { width: 3840, height: 2160 }).fontPx, 48);
    assert.equal(unitFor('phone', { width: 320, height: 568 }).fontPx >= 14, true);
    assert.equal(unitFor('wide', { width: 844, height: 390 }).fontPx >= 14, true);
  });
  test('presentation direction per layout', () => {
    assert.deepEqual(['wide', 'tall', 'phone'].map(presentDirection), ['right', 'up', 'down']);
  });
});
