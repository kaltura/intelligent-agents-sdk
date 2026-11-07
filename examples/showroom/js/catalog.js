/**
 * Gizmo Grove's fictional catalog. Pure data plus lookups, no DOM.
 * The agent gets a text copy of it (`catalogText`) inside its prompt (agent/spec.mjs), so it
 * can only recommend things the screen can show.
 */

/** @typedef {{id:string,name:string,hex:string}} Color */
/** @typedef {{id:string,name:string,tagline:string,price:number,form:'bar'|'flip'|'compact',colors:Color[],storage:{gb:number,add:number}[],highlights:string[]}} Device */

/** @type {Device[]} */
export const DEVICES = [
  {
    id: 'orbit-one', name: 'Orbit One', form: 'bar', price: 799,
    tagline: 'The flagship. Our brightest screen and a three-day battery.',
    colors: [
      { id: 'moon', name: 'Moon White', hex: '#e9ecf4' },
      { id: 'ember', name: 'Ember', hex: '#ff7a45' },
      { id: 'tide', name: 'Tide', hex: '#3d6bff' },
    ],
    storage: [{ gb: 128, add: 0 }, { gb: 256, add: 100 }, { gb: 512, add: 250 }],
    highlights: ['6.7 inch 120 Hz display', 'Three-day battery', 'Triple camera with night mode'],
  },
  {
    id: 'orbit-flip', name: 'Orbit Flip', form: 'flip', price: 999,
    tagline: 'Folds to fit a pocket. Opens to a full-size screen.',
    colors: [
      { id: 'lilac', name: 'Lilac', hex: '#b9a4ff' },
      { id: 'mint', name: 'Mint', hex: '#7ee0c3' },
      { id: 'graphite', name: 'Graphite', hex: '#3b3f4d' },
    ],
    storage: [{ gb: 256, add: 0 }, { gb: 512, add: 150 }],
    highlights: ['Folds to half size', 'Cover screen for quick replies', 'Hands-free stand mode'],
  },
  {
    id: 'orbit-lite', name: 'Orbit Lite', form: 'compact', price: 399,
    tagline: 'Everything you use daily, at a friendly price.',
    colors: [
      { id: 'sun', name: 'Sunbeam', hex: '#ffcf4a' },
      { id: 'sky', name: 'Skyline', hex: '#6ec6ff' },
      { id: 'night', name: 'Midnight', hex: '#222638' },
    ],
    storage: [{ gb: 64, add: 0 }, { gb: 128, add: 60 }],
    highlights: ['Two-day battery', 'Dual camera', 'Water resistant'],
  },
];

/** @typedef {{id:string,name:string,note:string,price:number,kind:'case'|'audio'|'power'|'guard'}} Accessory */
/** @type {Accessory[]} */
export const ACCESSORIES = [
  { id: 'case-clear', name: 'Clear Case', note: 'Slim and scratch resistant', price: 29, kind: 'case' },
  { id: 'case-rugged', name: 'Rugged Case', note: 'Drop tested from two meters', price: 49, kind: 'case' },
  { id: 'buds', name: 'Orbit Buds', note: 'Noise cancelling, 24 hour battery', price: 129, kind: 'audio' },
  { id: 'charger', name: 'Fast Charger', note: '45 watt, charges to 50% in 20 minutes', price: 39, kind: 'power' },
  { id: 'screen-guard', name: 'Screen Guard', note: 'Tempered glass, easy-fit frame', price: 19, kind: 'guard' },
];

/** @typedef {{id:string,name:string,price:number,data:string,perks:string[]}} Plan */
/** @type {Plan[]} */
export const PLANS = [
  { id: 'starter', name: 'Starter', price: 25, data: '5 GB', perks: ['Unlimited talk and text', 'Wi-Fi calling'] },
  { id: 'plus', name: 'Plus', price: 40, data: 'Unlimited', perks: ['Unlimited talk and text', 'Hotspot 20 GB', 'Streaming at HD'] },
  { id: 'max', name: 'Max', price: 60, data: 'Unlimited', perks: ['Everything in Plus', 'Roaming in 40 countries', 'Priority network'] },
];

/** Trade-in: base value by old phone, scaled by condition. */
export const TRADE_IN_MODELS = [
  { id: 'old-orbit', name: 'Older Orbit phone', base: 260 },
  { id: 'other-flagship', name: 'Other brand flagship', base: 320 },
  { id: 'other-budget', name: 'Other brand budget phone', base: 90 },
];
export const TRADE_IN_CONDITIONS = [
  { id: 'great', name: 'Great', factor: 1 },
  { id: 'good', name: 'Good', factor: 0.75 },
  { id: 'fair', name: 'Fair', factor: 0.45 },
];

/** @param {string} id */
export const deviceById = (id) => DEVICES.find((d) => d.id === id) || null;
/** @param {string} id */
export const accessoryById = (id) => ACCESSORIES.find((a) => a.id === id) || null;
/** @param {string} id */
export const planById = (id) => PLANS.find((p) => p.id === id) || null;

/**
 * Match free text from the model to a catalog entry. Accepts the id, the name
 * or a unique word of the name ("ember", "orbit flip"), case-insensitive.
 * @template {{id:string,name:string}} T
 * @param {T[]} list
 * @param {unknown} query
 * @returns {T|null}
 */
export function findLoose(list, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  const exact = list.find((x) => x.id === q || x.name.toLowerCase() === q);
  if (exact) return exact;
  const hits = list.filter((x) => x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase()) || x.id.includes(q.replace(/\s+/g, '-')));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Compact text copy of the catalog for the agent prompt.
 * @returns {string}
 */
export function catalogText() {
  const lines = ['PHONES (id | price from | colors | storage | form):'];
  for (const d of DEVICES) {
    lines.push(`- ${d.id} | ${d.name} | $${d.price} | ${d.colors.map((c) => `${c.id}=${c.name}`).join(', ')} | ${d.storage.map((s) => `${s.gb}GB${s.add ? ` +$${s.add}` : ''}`).join(', ')} | ${d.tagline}`);
  }
  lines.push('ACCESSORIES (id | price):');
  for (const a of ACCESSORIES) lines.push(`- ${a.id} | ${a.name} | $${a.price} | ${a.note}`);
  lines.push('PLANS (id | monthly):');
  for (const p of PLANS) lines.push(`- ${p.id} | ${p.name} | $${p.price}/mo | data ${p.data} | ${p.perks.join('; ')}`);
  lines.push('TRADE-IN models: ' + TRADE_IN_MODELS.map((m) => `${m.id}=${m.name}`).join(', ') + '. Conditions: ' + TRADE_IN_CONDITIONS.map((c) => c.id).join(', ') + '.');
  return lines.join('\n');
}
