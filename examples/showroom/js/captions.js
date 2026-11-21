/**
 * Live captions. The visible line shows who is speaking and the latest words.
 * A polite live region repeats only finished sentences for screen readers, so
 * they are not read word by word.
 */
import { h } from './dom.js';

export function createCaptions() {
  const line = h('p', { class: 'caption-line', 'data-testid': 'caption' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-testid': 'caption-live' });
  const el = h('div', { class: 'captions' }, line, live);
  let fade = 0;
  return {
    el,
    /** @param {'agent'|'user'} who @param {string} text */
    show(who, text) {
      if (!text) return;
      line.dataset.who = who;
      line.textContent = text;
      line.classList.add('on');
      clearTimeout(fade);
      fade = setTimeout(() => line.classList.remove('on'), 9000);
    },
    /** Screen readers hear finished sentences only. @param {string} text */
    announce(text) { live.textContent = text; },
    clear() { line.classList.remove('on'); },
  };
}
