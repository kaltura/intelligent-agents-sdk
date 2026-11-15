import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * A relative ENV_FILE means "relative to where I ran the command". The child runs in
 * another folder, so give both processes the same absolute path.
 * @param {NodeJS.ProcessEnv} env @param {string} [cwd] @returns {NodeJS.ProcessEnv} the same env object
 */
export function absoluteEnvFile(env, cwd = process.cwd()) {
  if (env.ENV_FILE) env.ENV_FILE = resolve(cwd, env.ENV_FILE);
  return env;
}

/**
 * Start a server process and wait for its "Open: <url>" line.
 * @param {{command:string, args:string[], cwd:string, env:NodeJS.ProcessEnv, redact?:(s:string)=>string, urlTimeoutMs?:number, stopTimeoutMs?:number, pollMs?:number}} o
 * @returns {Promise<{url:string, stop:()=>Promise<{code:number|null, log:string}>}>}
 */
export function startServer({ command, args, cwd, env, redact = (s) => s, urlTimeoutMs = 300_000, stopTimeoutMs = 180_000, pollMs = 250 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    let timer;
    const code = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r('timeout'), stopTimeoutMs); })]).finally(() => clearTimeout(timer));
    if (code === 'timeout') child.kill('SIGKILL');
    return { code: /** @type {number|null} */ (code === 'timeout' ? null : code), log };
  };
  let timedOut = false;
  const urlPromise = new Promise((ok, fail) => {
    const t = setTimeout(() => { timedOut = true; clearInterval(poll); stop(); }, urlTimeoutMs);
    const poll = setInterval(() => {
      const m = /^Open: (\S+)/m.exec(log);
      if (m) { clearTimeout(t); clearInterval(poll); ok(m[1]); }
    }, pollMs);
    exited.then(() => {
      clearTimeout(t); clearInterval(poll);
      fail(new Error(timedOut ? 'server did not print a URL in time, so it was stopped' : `server exited early:\n${redact(log)}`));
    });
  });
  return urlPromise.then((url) => ({ url, stop }));
}
