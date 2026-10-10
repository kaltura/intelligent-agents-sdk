/**
 * Pure helpers for `live-verify-matrix.mjs`: which scripts run, how each one is told its target,
 * where its log goes, and how the result table looks. No process spawning here, so tests cover all of it.
 */

/**
 * Live scripts the matrix runs by default, in order. `envFlag` marks the scripts that read the
 * target from `--env`; the rest read `TARGET`. The runner always sets `TARGET`, and adds `--env`
 * only where the script parses it.
 * @type {ReadonlyArray<{name:string, file:string, envFlag?:boolean, args?:string[]}>}
 */
export const MATRIX_SCRIPTS = [
  { name: 'smoke', file: 'live-verify.mjs' },
  { name: 'agents', file: 'live-verify-agents.mjs' },
  { name: 'avatars', file: 'live-verify-avatars.mjs' },
  { name: 'catalog', file: 'live-verify-catalog.mjs' },
  { name: 'tools', file: 'live-verify-tools.mjs' },
  { name: 'skills', file: 'live-verify-skills.mjs' },
  { name: 'knowledge', file: 'live-verify-knowledge.mjs' },
  { name: 'capabilities', file: 'live-verify-capabilities.mjs' },
  { name: 'intellects-conversations', file: 'live-verify-intellects-conversations.mjs' },
  { name: 'threads-messages-feedback', file: 'live-verify-threads-messages-feedback.mjs' },
  { name: 'conversation-surface', file: 'live-verify-conversation-avatar-surface.mjs' },
  { name: 'request-vars', file: 'live-verify-request-vars.mjs' },
  { name: 'context-fields', file: 'live-verify-context-fields.mjs' },
  { name: 'set-forced-language', file: 'live-verify-set-forced-language.mjs' },
  { name: 'site-nav', file: 'live-verify-site-nav.mjs' },
  { name: 'session-types', file: 'live-verify-session-types.mjs', envFlag: true },
  { name: 'browser', file: 'live-verify-browser.mjs' },
  { name: 'avatar-media', file: 'live-verify-avatar-media.mjs' },
  { name: 'session-complete', file: 'live-verify-session-complete.mjs' },
  { name: 'opening-phrase', file: 'live-verify-opening-phrase.mjs', envFlag: true },
  { name: 'kickoff', file: 'live-verify-kickoff.mjs', envFlag: true },
  { name: 'startup-faults', file: 'live-verify-startup-faults.mjs', envFlag: true },
  { name: 'reconnect', file: 'live-verify-reconnect.mjs', envFlag: true },
  { name: 'unload', file: 'live-verify-unload.mjs', envFlag: true },
  { name: 'prepare', file: 'live-verify-prepare.mjs', envFlag: true },
  { name: 'connect-timing', file: 'live-verify-connect-timing.mjs', envFlag: true, args: ['--runs', '9'] },
];

export const DEFAULT_TARGETS = ['prod', 'nvq2:1'];

/**
 * @param {string[]} argv
 * @returns {{targets:string[], scripts:string[]|null, list:boolean, outDir:string}}
 */
export function parseMatrixArgs(argv) {
  const out = { targets: [...DEFAULT_TARGETS], scripts: /** @type {string[]|null} */ (null), list: false, outDir: 'live-verify-artifacts' };
  const csv = (/** @type {string|undefined} */ v, /** @type {string} */ flag) => {
    const items = (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw new Error(`${flag} needs a comma-separated list`);
    return items;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--targets') out.targets = csv(argv[++i], a);
    else if (a === '--scripts') out.scripts = csv(argv[++i], a);
    else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out needs a directory');
      out.outDir = v;
    } else if (a === '--list') out.list = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * Pick scripts by name. `null` means the default list. An unknown name is an error, never a skip.
 * @param {string[]|null} names
 */
export function selectScripts(names) {
  if (!names) return [...MATRIX_SCRIPTS];
  const byName = new Map(MATRIX_SCRIPTS.map((s) => [s.name, s]));
  return names.map((n) => {
    const s = byName.get(n);
    if (!s) throw new Error(`unknown script "${n}". Known: ${MATRIX_SCRIPTS.map((x) => x.name).join(', ')}`);
    return s;
  });
}

/**
 * Command line and environment for one script on one target.
 * @param {{name:string, file:string, envFlag?:boolean, args?:string[]}} script
 * @param {string} target `prod` or `<name>[:<account>]`
 * @param {string} outDir Artifact directory for this target
 */
export function buildCommand(script, target, outDir) {
  const args = [`scripts/${script.file}`, ...(script.args || [])];
  if (script.envFlag) args.push('--env', target, '--out', outDir);
  return { cmd: process.execPath, args, env: { TARGET: target } };
}

/** Folder name for a target: `nvq2:1` becomes `nvq2-1`, `prod` stays `prod`. @param {string} target */
export const targetDir = (target) => target.replace(/[^A-Za-z0-9._-]+/g, '-');

/**
 * @typedef {{target:string, script:string, status:'pass'|'fail'|'unavailable', ms:number, log?:string}} MatrixResult
 */

/**
 * Markdown table, one row per script and one column per target.
 * @param {MatrixResult[]} results
 * @param {string[]} targets
 */
export function renderTable(results, targets) {
  const scripts = [...new Set(results.map((r) => r.script))];
  const cell = (/** @type {MatrixResult|undefined} */ r) => (r ? `${r.status} ${(r.ms / 1000).toFixed(1)}s` : 'not run');
  const rows = scripts.map((s) => `| ${s} | ${targets.map((t) => cell(results.find((r) => r.script === s && r.target === t))).join(' | ')} |`);
  return [`| script | ${targets.join(' | ')} |`, `|---|${targets.map(() => '---').join('|')}|`, ...rows].join('\n');
}

/** A run is green only when every cell passed. @param {MatrixResult[]} results */
export const allPassed = (results) => results.length > 0 && results.every((r) => r.status === 'pass');
