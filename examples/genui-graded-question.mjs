/**
 * `graded-question` — a full worked example of the GenUI
 * comprehension-check widget: multiple-choice AND free-text variants, wired
 * through the SDK's existing "10th runtime" host-registration seam (the same
 * mechanism any custom widget uses — see docs/genui/widgets.md § 10 and
 * docs/genui/authoring-and-consuming.md "Registration, fallback, and provenance"),
 * and reported back via the
 * existing `onAction('answer', payload)` interaction-event path.
 *
 * Run:
 *
 *   node examples/genui-graded-question.mjs
 *
 * No credentials, no network, no browser needed — it prints the descriptor +
 * the exact `onAction('answer', ...)` payload for a right answer, a wrong
 * answer, and an ungraded (open-ended) question, for both variants.
 *
 * Since this is a browser widget and Node has no DOM, this example builds a
 * tiny, zero-dependency DOM shim (`makeDom()` below) just enough for
 * `mountWidget` to construct/attach nodes and fire `click`/`change`/`input`
 * listeners programmatically. A real app passes a real `document` — swap
 * `globalThis.document = makeDom()` for your actual page and everything below
 * is unchanged.
 *
 * NOTE (dev-local path): the imports below resolve against the repo's src/
 * tree. npm consumers should import from
 * '@kaltura/intelligent-agents/experience/genui' instead.
 */
import { ExperienceRenderer, mountWidget, renderGradedQuestion } from '../src/experience/genui/index.js';

/** A minimal DOM shim — enough for mountWidget's createElement/append/addEventListener path. Not for production use. */
function makeDom() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], attrs: {}, dataset: {}, hidden: false,
      _cls: '', _text: '', _listeners: {},
      classList: { add(...cs) { cs.forEach((c) => { if (!node._cls.split(' ').includes(c)) node._cls = (node._cls + ' ' + c).trim(); }); } },
      set className(v) { this._cls = String(v); }, get className() { return this._cls; },
      set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); return c; }, append(...cs) { cs.forEach((c) => this.children.push(c)); },
      replaceChildren(...cs) { this.children = cs; },
      addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
      fire(ev) { (this._listeners[ev] || []).forEach((fn) => fn()); },
    };
    return node;
  };
  return { createElement: make };
}

/** Depth-first search for the first node whose className includes `cls`. */
function findByClass(root, cls) {
  if (root.className && root.className.split(' ').includes(cls)) return root;
  for (const c of root.children) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}
function findAllByTag(root, tag, out = []) {
  if (root.tagName === tag) out.push(root);
  for (const c of root.children) findAllByTag(c, tag, out);
  return out;
}

globalThis.document = makeDom();

// The "10th runtime" registration — graded-question is NOT one of the nine
// backend runtimes, so register it explicitly on your ExperienceRenderer.
const renderer = new ExperienceRenderer({ renderers: { 'graded-question': renderGradedQuestion } });

function demo(title, model, act) {
  console.log('\n=== ' + title + ' ===');
  const descriptor = renderer.render('graded-question', model);
  console.log('descriptor._meta:', descriptor._meta);   // known:true (we registered it), firstClass:false (not backend-native)

  const container = document.createElement('div');
  const actions = [];
  const root = mountWidget(descriptor, container, { onAction: (action, payload) => actions.push({ action, payload }) });

  act(root);

  for (const { action, payload } of actions) console.log(`onAction('${action}', ${JSON.stringify(payload)})`);
  if (!actions.length) console.log('(no answer submitted)');
}

// 1) Multiple-choice, answered correctly.
demo('choice variant — correct answer', {
  questionId: 'http-methods', prompt: 'Which HTTP method is idempotent?',
  options: [{ id: 'post', text: 'POST' }, { id: 'put', text: 'PUT' }],
  correctOptionId: 'put', explanation: 'PUT replaces a resource; calling it twice has the same effect as once.',
}, (root) => {
  const radios = findAllByTag(root, 'INPUT').filter((n) => n.type === 'radio');
  radios[1].fire('change');                              // select "PUT" — the correct option
  findByClass(root, 'kgenui__submit').fire('click');
});

// 2) Multiple-choice, answered incorrectly.
demo('choice variant — wrong answer', {
  questionId: 'http-methods-2', prompt: 'Which HTTP method is idempotent?',
  options: [{ id: 'post', text: 'POST' }, { id: 'put', text: 'PUT' }],
  correctOptionId: 'put', explanation: 'PUT replaces a resource; calling it twice has the same effect as once.',
}, (root) => {
  const radios = findAllByTag(root, 'INPUT').filter((n) => n.type === 'radio');
  radios[0].fire('change');                              // select "POST" — the wrong option
  findByClass(root, 'kgenui__submit').fire('click');
});

// 3) Free-text, answered correctly (case-insensitive match).
demo('text variant — correct free-text answer', {
  questionId: 'capital', prompt: 'Name the capital of France.', acceptedAnswers: ['Paris'],
  explanation: 'Paris has been the capital since the 10th century.',
}, (root) => {
  const input = findAllByTag(root, 'INPUT').find((n) => n.type === 'text');
  input.value = 'paris';                                 // case-insensitive against acceptedAnswers
  input.fire('input');
  findByClass(root, 'kgenui__submit').fire('click');
});

// 4) Open-ended — no answer key authored → correct:null, never a false "wrong".
demo('text variant — ungraded (open-ended, no answer key)', {
  questionId: 'reflection', prompt: 'What was the most useful part of this lesson for you?',
}, (root) => {
  const input = findAllByTag(root, 'INPUT').find((n) => n.type === 'text');
  input.value = 'The worked examples.';
  input.fire('input');
  findByClass(root, 'kgenui__submit').fire('click');
});

console.log('\nA listening integration branches conversation flow off payload.correct/payload.questionId —');
console.log("e.g. session.speak('Not quite — want a hint?') on correct:false, or advance a lesson plan on correct:true.");
