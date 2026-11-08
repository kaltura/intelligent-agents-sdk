/**
 * Plan and run the eval turns. The caller passes in `runTurn`, so tests run with no network.
 * `liveTurn` is the real `runTurn`: it drives the SDK and stores the raw chunks.
 */
import { performance } from 'node:perf_hooks';

/** Trials for the cheaper side paths are capped at this number. */
export const SIDE_PATH_TRIALS = 4;

/**
 * @typedef {'on'|'off'|'avatar-off'|'send'} Mode
 * @typedef {{id:number, scenario:string, trial:number, mode:Mode, capabilities:Record<string,string>, turns:{turnIndex:number, prompt:string}[]}} Job
 */

/** Capabilities per path. Scenario extras (for example a tool) are added on top. @param {Mode} mode @param {Record<string,string>} [extra] */
export function capabilitiesFor(mode, extra = {}) {
  const base = { on: { avatar: 'on', avatar_emotions: 'on' }, send: { avatar: 'on', avatar_emotions: 'on' }, off: { avatar: 'on', avatar_emotions: 'off' }, 'avatar-off': { avatar: 'off', avatar_emotions: 'on' } }[mode];
  return { ...base, ...extra };
}

/**
 * Build the job list. Order is trial-major, so a turn budget cuts trials evenly across scenarios.
 * @param {{scenarios:any[], trials:number, paths?:Mode[], maxTurns?:number, baseCapabilities?:Record<string,string>}} p
 * @returns {{jobs:Job[], planned:number, cut:boolean}}
 */
export function planJobs({ scenarios, trials, paths = ['on', 'off', 'avatar-off', 'send'], maxTurns = Infinity, baseCapabilities = {} }) {
  /** @type {Job[]} */ const jobs = [];
  let used = 0, planned = 0, cut = false;
  const want = new Set(paths);
  for (let trial = 1; trial <= trials; trial++) {
    for (const sc of scenarios) {
      /** @type {Mode[]} */ const modes = ['on'];
      if (sc.avatarOff || sc.send) modes.push('off');
      if (sc.avatarOff && trial <= SIDE_PATH_TRIALS) modes.push('avatar-off');
      if (sc.send && trial <= SIDE_PATH_TRIALS) modes.push('send');
      for (const mode of modes) {
        if (!want.has(mode)) continue;
        const turns = sc.turns.map((/** @type {any} */ t, /** @type {number} */ i) => ({ turnIndex: i, prompt: t.prompt }));
        planned += turns.length;
        if (used + turns.length > maxTurns) { cut = true; continue; }
        used += turns.length;
        jobs.push({ id: jobs.length, scenario: sc.id, trial, mode, capabilities: capabilitiesFor(mode, { ...baseCapabilities, ...sc.capabilities }), turns });
      }
    }
  }
  return { jobs, planned, cut };
}

/**
 * Run jobs with a concurrency cap. Turns inside a job run in order and share a thread.
 * @param {{jobs:Job[], runTurn:(ctx:{job:Job, turnIndex:number, prompt:string, threadId?:string})=>Promise<any>, concurrency?:number, shouldStop?:()=>boolean, onTurn?:(rec:any)=>void}} p
 * @returns {Promise<any[]>} turn records, in job order
 */
export async function runJobs({ jobs, runTurn, concurrency = 4, shouldStop = () => false, onTurn = () => {} }) {
  const recs = /** @type {any[][]} */ (jobs.map(() => []));
  let next = 0;
  async function worker() {
    while (!shouldStop()) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      let threadId;
      for (const t of job.turns) {
        if (shouldStop()) break;
        let r;
        try {
          r = await runTurn({ job, turnIndex: t.turnIndex, prompt: t.prompt, threadId });
        } catch (err) {
          r = { ok: false, error: { code: /** @type {any} */ (err)?.code ?? 'error', message: String(/** @type {any} */ (err)?.message ?? err).slice(0, 300) }, segments: [], firstChunkMs: null, totalMs: null };
        }
        threadId = r.threadId ?? threadId;
        const rec = { scenario: job.scenario, trial: job.trial, turnIndex: t.turnIndex, mode: job.mode, prompt: t.prompt, capabilities: job.capabilities, ok: r.ok !== false && !r.error, error: r.error ?? null, firstChunkMs: r.firstChunkMs ?? null, totalMs: r.totalMs ?? null, segments: r.segments ?? [], ...(r.retries ? { retries: r.retries } : {}), ...(r.waitedMs ? { waitedMs: r.waitedMs } : {}) };
        recs[i].push(rec);
        onTurn(rec);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length || 1)) }, worker));
  return recs.flat();
}

/** Keep only what the eval reads from one stream chunk. @param {any} seg */
export function slimSegment(seg) {
  const out = {
    type: String(seg?.type ?? 'unknown'),
    content: typeof seg?.content === 'string' ? seg.content : null,
    segmentStart: !!seg?.segmentStart,
    segmentEnd: !!seg?.segmentEnd,
    isFinal: !!seg?.isFinal,
  };
  const md = seg?.metadata;
  return md && typeof md === 'object' && Object.prototype.hasOwnProperty.call(md, 'emotion') ? { ...out, emotion: md.emotion } : out;
}

/** @param {any} err */
const errInfo = (err) => ({ code: String(err?.code ?? err?.name ?? 'error'), message: String(err?.message ?? err).slice(0, 300) });

/**
 * The real `runTurn`. Streams the reply (or uses the aggregate `send` call) and times it.
 * @param {{conversations:{stream:Function, send:Function}}} kaltura
 * @param {string} convKs
 * @param {number} timeoutMs
 * @param {{now?:()=>number}} [deps]
 */
export function liveTurn(kaltura, convKs, timeoutMs, deps = {}) {
  const now = deps.now ?? (() => performance.now());
  return async function runTurn(/** @type {{job:Job, prompt:string, threadId?:string}} */ { job, prompt, threadId }) {
    const opts = { userMessage: prompt, capabilities: job.capabilities, ...(threadId ? { threadId } : {}) };
    const t0 = now();
    const segments = [];
    let first = null, tid = threadId;
    if (job.mode === 'send') {
      let timer;
      try {
        const res = await Promise.race([
          kaltura.conversations.send(opts, convKs),
          new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('turn timed out'), { code: 'timeout' })), timeoutMs); }),
        ]);
        return { ok: true, threadId: res.threadId ?? tid, firstChunkMs: null, totalMs: now() - t0, segments: (res.segments ?? []).map(slimSegment) };
      } catch (err) {
        const partial = /** @type {any} */ (err)?.segments;
        return { ok: false, error: errInfo(err), firstChunkMs: null, totalMs: now() - t0, segments: Array.isArray(partial) ? partial.map(slimSegment) : [] };
      } finally { clearTimeout(timer); }
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for await (const seg of kaltura.conversations.stream({ ...opts, signal: ac.signal }, convKs)) {
        if (first === null) first = now() - t0;
        if (seg?.threadId && !tid) tid = seg.threadId;
        segments.push(slimSegment(seg));
      }
      return { ok: true, threadId: tid, firstChunkMs: first, totalMs: now() - t0, segments };
    } catch (err) {
      const e = ac.signal.aborted ? { code: 'timeout', message: 'turn timed out' } : errInfo(err);
      return { ok: false, error: e, threadId: tid, firstChunkMs: first, totalMs: now() - t0, segments };
    } finally { clearTimeout(timer); }
  };
}

/** Seconds the server asks us to wait, read from a rate-limit message. Falls back to 30. @param {any} err */
export function retryAfterSeconds(err) {
  const m = /retry after (\d+)/i.exec(String(err?.message ?? ''));
  return m ? Math.min(120, Math.max(1, Number(m[1]))) : 30;
}

/**
 * Wrap `runTurn` so a run stays under the server's request limit.
 * - Starts at most `perMinute` calls in any 60 s window (shared by all workers).
 * - On a `rate_limited` error it waits the time the server asks for and tries again, up to `maxRetries` times.
 * The result carries `retries` and `waitedMs` when it had to wait.
 * @param {(ctx:any)=>Promise<any>} runTurn
 * @param {{perMinute?:number, maxRetries?:number, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} [opts]
 */
export function withPacing(runTurn, { perMinute = 80, maxRetries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  /** @type {number[]} */ const starts = [];
  let gate = Promise.resolve();
  const WINDOW = 60_000;
  // Reserve a start slot. Slots are handed out one at a time, so workers cannot jump the queue.
  const slot = () => (gate = gate.then(async () => {
    for (;;) {
      const t = now();
      while (starts.length && t - starts[0] >= WINDOW) starts.shift();
      if (perMinute <= 0 || starts.length < perMinute) { starts.push(t); return; }
      await sleep(Math.max(1, WINDOW - (t - starts[0])));
    }
  }));
  return async function paced(/** @type {any} */ ctx) {
    let waitedMs = 0, retries = 0, r;
    for (;;) {
      const before = now();
      await slot();
      waitedMs += now() - before;
      r = await runTurn(ctx);
      if (r?.error?.code !== 'rate_limited' || retries >= maxRetries) break;
      retries++;
      const ms = (retryAfterSeconds(r.error) + 1) * 1000;
      waitedMs += ms;
      await sleep(ms);
    }
    return retries || waitedMs > 1000 ? { ...r, retries, waitedMs: Math.round(waitedMs) } : r;
  };
}
