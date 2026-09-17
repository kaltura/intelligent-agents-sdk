#!/usr/bin/env node
// Report-only triage for the Phase 3 readability pass — NOT wired into
// npm test/generate. Ranks every doc page by a density score so the fix
// pass has an order, not an eligibility list: every page still gets
// reviewed regardless of rank.
//
// Usage: node scripts/report-readability.mjs [--sdk-dir <path>] [--site-dir <path>]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifest } from './docs-manifest.mjs';
import { resolveSdkDir, resolveSiteDir } from './generate-docs.mjs';

function stripToProse(raw) {
  let body = raw.replace(/^---\n[\s\S]*?\n---\n/, ''); // front matter
  body = body.replace(/```[\s\S]*?```/g, ' ');           // fenced code
  body = body.replace(/`[^`\n]+`/g, ' ');                // inline code
  body = body.replace(/^\|.*\|$/gm, ' ');                // table rows
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // images
  body = body.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // links → link text
  body = body.replace(/^#{1,6}\s+/gm, '');                // heading markers
  body = body.replace(/[*_>#-]/g, ' ');                   // remaining markdown noise
  return body;
}

function splitSentences(prose) {
  return prose
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}

function analyze(prose) {
  const sentences = splitSentences(prose);
  const words = prose.split(/\s+/).filter(Boolean);
  const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const avgWordsPerSentence = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const longest = sentences
    .map((s, i) => ({ text: s, words: lengths[i] }))
    .sort((a, b) => b.words - a.words)
    .slice(0, 5);
  return {
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgWordsPerSentence,
    longest,
  };
}

function loadEntry(entry, sdkDir, siteDir) {
  const path = entry.generated ? resolve(sdkDir, entry.source) : resolve(siteDir, 'src', entry.target);
  return readFileSync(path, 'utf8');
}

function main() {
  const sdkDir = resolveSdkDir();
  const siteDir = resolveSiteDir();
  const rows = manifest.map((entry) => {
    const raw = loadEntry(entry, sdkDir, siteDir);
    const { wordCount, sentenceCount, avgWordsPerSentence, longest } = analyze(stripToProse(raw));
    // Composite score: total prose weighted by how far avg sentence length
    // exceeds the 20-word/sentence skim target — a long page of short
    // sentences ranks far below a shorter page of dense ones.
    const score = wordCount * Math.max(1, avgWordsPerSentence / 20);
    return { target: entry.target, wordCount, sentenceCount, avgWordsPerSentence, longest, score };
  });
  rows.sort((a, b) => b.score - a.score);
  for (const row of rows) {
    console.log(`\n${row.target}  —  ${row.wordCount} words, avg ${row.avgWordsPerSentence.toFixed(1)} words/sentence, score ${row.score.toFixed(0)}`);
    for (const s of row.longest) {
      console.log(`  [${s.words}w] ${s.text.slice(0, 140)}${s.text.length > 140 ? '…' : ''}`);
    }
  }
}

main();
