/**
 * Renderer for `graded-question` — a graded interactive question:
 * a prompt, either multiple-choice options or a free-text answer, and an
 * optional answer key + explanation. NOT one of the nine backend `unisphere-tool`
 * runtimes (there's no brain tool that emits it) — it's a host-registered
 * "10th runtime" widget, wired in via `new ExperienceRenderer({ renderers: {
 * 'graded-question': renderGradedQuestion } })` or `.register(...)`, the same
 * extensibility seam any custom widget uses (see `docs/genui/authoring-and-consuming.md`
 * "Registration, fallback, and provenance"). Grading happens client-side in
 * `mountWidget`'s DOM builder — see `renderers/mount.js` — because the answer
 * key travels inside the descriptor itself: this is a comprehension-check
 * primitive for a cooperative learner, NOT a tamper-proof/proctored assessment.
 * Framework-agnostic `{kind:'graded-question', data}`, pure function, no
 * module-level state.
 */
import { safeText } from '../../../core/safety.js';

/** Hard cap on rendered options — bounds DOM size against a malformed/adversarial model. */
const MAX_OPTIONS = 8;

/**
 * @param {Record<string, unknown>} model
 * @returns {{kind:'graded-question', data:{
 *   questionId:string, variant:'choice'|'text', prompt:string,
 *   options:Array<{id:string,text:string}>, correctOptionId:string|null,
 *   acceptedAnswers:string[], explanation:string
 * }}}
 */
export function renderGradedQuestion(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars/garbage

  const prompt = safeText(model.prompt ?? model.question ?? model.text ?? '', 2000);
  const explanation = safeText(model.explanation ?? model.feedback ?? model.rationale ?? '', 2000);

  const rawOptions = Array.isArray(model.options) ? model.options
    : Array.isArray(model.choices) ? model.choices
      : Array.isArray(model.answers) ? model.answers
        : [];

  const options = rawOptions.slice(0, MAX_OPTIONS).map((o, i) => {
    const src = /** @type {Record<string,unknown>} */ ((o && typeof o === 'object') ? o : { text: o });
    const text = safeText(src.text ?? src.label ?? src.value ?? '', 500);
    const id = safeText(src.id ?? src.key ?? '', 200) || fallbackId(text, i);
    return { id, text };
  }).filter((o) => o.text);

  const variant = options.length > 0 ? 'choice' : 'text';

  let correctOptionId = null;
  if (variant === 'choice') {
    const rawCorrect = safeText(model.correctOptionId ?? model.correctId ?? model.answerId ?? model.correct ?? '', 200);
    if (rawCorrect && options.some((o) => o.id === rawCorrect)) correctOptionId = rawCorrect;
  }

  const rawAccepted = model.acceptedAnswers ?? model.answer ?? model.correctText ?? model.expectedAnswer ?? model.expectedAnswers;
  const acceptedAnswers = variant === 'text'
    ? (Array.isArray(rawAccepted) ? rawAccepted : (rawAccepted != null ? [rawAccepted] : []))
      .map((a) => safeText(a, 500)).filter(Boolean)
    : [];

  const questionId = safeText(model.questionId ?? model.id ?? model.key ?? '', 200) || fallbackId(prompt, 0);

  return {
    kind: 'graded-question',
    data: { questionId, variant, prompt, options, correctOptionId, acceptedAnswers, explanation },
  };
}

/** A deterministic, pure fallback id derived from text content — never module state. */
function fallbackId(text, i) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (slug || 'q') + '-' + i;
}
