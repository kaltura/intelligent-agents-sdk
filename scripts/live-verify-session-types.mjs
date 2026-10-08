#!/usr/bin/env node
/**
 * Live session-type verification against a real provisioned agent. No fakes,
 * no mocks.
 *
 * Checks what each token kind can and can't reach, as a caller observes it:
 *
 *   1  user session with userId (type 0): own thread read, continue, list
 *   2  a second user can't read, list, continue or delete the first user's thread;
 *      its delete returns 200 with totalCount 0 (nothing deleted)
 *   3  a userId never registered on the partner works
 *   4  without userId, every holder shares one identity: any of them can
 *      continue a thread, none can read, list or delete it (403)
 *   5  own-thread delete lists the thread as deleted and removes it (admin get then 404s)
 *   6  through the SDK, a user Token reads and lists its own threads; another user's
 *      Token gets the server's 404 (no client-side rejection)
 *   7  createAgentToken without configId answers as the agent; the thread
 *      carries the agent id and the caller's userId
 *   8  appInit with a per-user agent token returns a KS that converses as that user
 *   9  a user session gets no OVP admin reach (user.list, partner.getInfo) and
 *      an account-wide entry list returns nothing (the entry part is skipped, and
 *      noted, when the partner has no entries at all)
 *  10  sessionType: 'admin' has admin-level reach (other users' threads, OVP user.list),
 *      limited only by its role and privileges
 *  11  widget: every visitor shares one identity: any of them can continue
 *      a thread, none can read, list or delete it (403)
 *  11b through the SDK, every relaxed method (threads.transcript/rename/setAnalysis/
 *      clearAnalysis, messages.list/get/share) works for the owner's conversation and
 *      agent Token, fails with a server status for another user's Token, and a widget
 *      Token is refused client-side with wrong_token_scope on all ten
 *  11c threads.delete through the SDK: the owner's Token deletes its thread, another
 *      user's Token deletes nothing; a raw KS string (owner, other user, widget) skips
 *      the client-side check and gets the server's own answer
 *  12  revoke() ends the token and its sessionGroupId sibling (skip with --skip-revoke)
 *
 * Raw HTTP is used for thread and OVP calls made with a user KS, so each
 * check sees the backend's own status code rather than an SDK pre-flight.
 *
 * Throwaway agent via provision(), full cleanup in `finally`. The
 * messages.share success path (one clone per token kind) runs only with
 * `--with-share`. Each such run leaves clones behind: there is no call to delete
 * a single message. The denial checks for share always run. Targets prod by
 * default; `--env <name>[:<n>] --env-file <path>` picks another environment (for example QA).
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET (or the `--env`
 * prefixed vars), from the environment or a .env file. None are written to
 * the artifacts.
 */
import { bootstrap, management, ensureAgent, verifyDeleted, Report, mdTable, redact, sleep } from './live-verify-kickoff-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'session-types');
const withShare = !!args['with-share'];
const kaltura = management(target);
const report = new Report({ runId, target: target.name });

const GENIE = target.genieUrl.replace(/\/$/, '');
const OVP = target.ovpUrl.replace(/\/$/, '');
const tag = Date.now().toString(36);
const user = (/** @type {string} */ s) => `lv-st-${tag}-${s}`;

/**
 * One raw genie call. Never throws on an HTTP error.
 * @param {string} path @param {object} body @param {string} ks
 * @returns {Promise<{status:number, body:any}>}
 */
async function genie(path, body, ks) {
  const res = await fetch(`${GENIE}/${path}`, { // nosemgrep: scripts.harness.no-raw-fetch-bypass
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `KS ${ks}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/**
 * One raw OVP call. Returns `{ok:true, result}` or `{ok:false, code}`.
 * Each call gets its own clientTag so every check is a separate request.
 * @param {string} service @param {string} action @param {object} params @param {string} ks
 */
async function ovp(service, action, params, ks) {
  const res = await fetch(`${OVP}/service/${service}/action/${action}`, { // nosemgrep: scripts.harness.no-raw-fetch-bypass
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ks, format: 1, clientTag: `lv-st-${tag}-${Math.random().toString(36).slice(2)}`, ...params }),
  });
  const body = await res.json().catch(() => null);
  if (body?.objectType === 'KalturaAPIException') return { ok: false, code: body.code };
  return { ok: res.ok, result: body };
}

/** Ids a thread/delete response says it deleted. @param {any} r @returns {string[]} */
const deletedIds = (r) => (Array.isArray(r.body?.objects) ? r.body.objects.map((/** @type {any} */ t) => t.id) : []);

const threadList = (/** @type {string} */ ks) => genie('v1/thread/list', { filter: { objectType: 'ListThreadFilter' }, pager: { pageIndex: 1, pageSize: 50 } }, ks);
const listIds = (/** @type {any} */ r) => (Array.isArray(r.body?.objects) ? r.body.objects.map((/** @type {any} */ t) => t.id) : []);

/** Admin read of a thread: the thread, or `null` on a typed not-found. @param {string} id */
async function adminThread(id) {
  try {
    return await kaltura.threads.get(id, admin);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.status === 404 || /not_found/.test(String(e?.code ?? ''))) return null;
    throw err;
  }
}

/** @param {any} tok @param {string} userMessage @param {string} [threadId] */
const say = (tok, userMessage, threadId) => kaltura.conversations.send({ userMessage, ...(threadId ? { threadId } : {}) }, tok);

/** Run one check; a thrown error records a FAIL instead of ending the run. @param {string} name @param {() => Promise<void>} fn */
async function step(name, fn) {
  try { await fn(); } catch (err) {
    const e = /** @type {any} */ (err);
    report.check(name, false, redact(String(e?.code || e?.status || e?.message || e)).slice(0, 200));
  }
}

/** @type {any} */ let admin;
/** @type {any} */ let agent;
/** @type {Set<string>} */ const threads = new Set();

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  agent = await ensureAgent(kaltura, admin, { agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined, keep: !!args.keep });
  const { configId, agentId, widgetId } = agent;
  report.note('agent', { reused: agent.reused });

  const tokA = await kaltura.sessions.createConversationToken({ configId, agentId, userId: user('a') });
  const tokB = await kaltura.sessions.createConversationToken({ configId, agentId, userId: user('b') });
  report.check('conversation token with userId is a user session', tokA.sessionType === 'user' && tokA.privileges.includes('setrole:PLAYBACK_BASE_ROLE'), { sessionType: tokA.sessionType });

  /** @type {string} */ let threadA = '';

  await step('user A (unregistered userId) opens a thread', async () => {
    const r = await say(tokA, 'Hello. Reply with one short sentence.');
    threadA = r.threadId;
    if (threadA) threads.add(threadA);
    report.check('user A (unregistered userId) opens a thread', !!threadA && !!r.text, { replyChars: r.text.length });
  });

  if (threadA) {
    await step('user A continues its own thread', async () => {
      const r = await say(tokA, 'Thanks. One more short sentence, please.', threadA);
      report.check('user A continues its own thread', r.threadId === threadA && !!r.text, { sameThread: r.threadId === threadA });
    });

    await step('user A reads its own thread', async () => {
      const r = await genie('v1/thread/get', { id: threadA }, tokA.ks);
      report.check('user A reads its own thread', r.status === 200 && r.body?.id === threadA, { status: r.status });
    });

    await step('admin sees the thread owned by user A and labeled with the agent', async () => {
      const t = await adminThread(threadA);
      report.check('admin sees the thread owned by user A and labeled with the agent', t?.user_id === user('a') && t?.agent_id === agentId,
        { owner: t?.user_id === user('a'), agentLabel: t?.agent_id === agentId });
    });

    await step('user A list shows its own thread', async () => {
      const r = await threadList(tokA.ks);
      const ids = listIds(r);
      const owners = new Set((r.body?.objects || []).map((/** @type {any} */ t) => t.user_id));
      report.check('user A list shows its own thread', r.status === 200 && ids.includes(threadA) && owners.size === 1 && owners.has(user('a')),
        { status: r.status, total: r.body?.totalCount, owners: owners.size });
    });

    await step('user B list does not show user A thread', async () => {
      const r = await threadList(tokB.ks);
      report.check('user B list does not show user A thread', r.status === 200 && !listIds(r).includes(threadA), { status: r.status, total: r.body?.totalCount });
    });

    await step('user B cannot read user A thread', async () => {
      const r = await genie('v1/thread/get', { id: threadA }, tokB.ks);
      report.check('user B cannot read user A thread', r.status === 404, { status: r.status });
    });

    await step('user B cannot continue user A thread', async () => {
      const marker = `marker-${tag}-b`;
      /** @type {any} */ let outcome;
      try {
        const r = await say(tokB, `Repeat this word back: ${marker}`, threadA);
        if (r.threadId && r.threadId !== threadA) threads.add(r.threadId);
        outcome = { threw: false, sameThread: r.threadId === threadA };
      } catch (err) {
        outcome = { threw: true, status: /** @type {any} */ (err)?.status, code: /** @type {any} */ (err)?.code };
      }
      const transcript = await kaltura.threads.transcript(threadA, admin);
      const leaked = String(transcript?.data ?? '').includes(marker);
      report.check('user B cannot continue user A thread', !leaked && (!outcome.threw || outcome.code === 'thread_access_denied' || outcome.status >= 400), { ...outcome, markerInThreadA: leaked });
    });

    await step('user B delete of user A thread deletes nothing', async () => {
      const r = await genie('v1/thread/delete', { thread_ids: [threadA] }, tokB.ks);
      const still = await adminThread(threadA);
      report.check('user B delete of user A thread deletes nothing', r.status === 200 && r.body?.totalCount === 0 && deletedIds(r).length === 0 && !!still,
        { status: r.status, totalCount: r.body?.totalCount, stillPresent: !!still });
    });

    await step('SDK: a user Token reads its own thread through threads.get and threads.list', async () => {
      /** @type {any} */ let code;
      let got = null; let list = null;
      try { got = await kaltura.threads.get(threadA, tokA); list = await kaltura.threads.list(tokA); } catch (err) { code = /** @type {any} */ (err)?.code; }
      const listed = (list || []).some((/** @type {any} */ t) => t.id === threadA);
      report.check('SDK: a user Token reads its own thread through threads.get and threads.list', !!got && listed && code !== 'wrong_token_scope', { got: !!got, listed, code });
    });

    await step('SDK: another user Token gets 404 on threads.get, not a client-side rejection', async () => {
      /** @type {any} */ let err;
      try { await kaltura.threads.get(threadA, tokB); } catch (e) { err = e; }
      report.check('SDK: another user Token gets 404 on threads.get, not a client-side rejection', err?.status === 404 && err?.code !== 'wrong_token_scope', { status: err?.status, code: err?.code });
    });

    await step('SDK: every relaxed thread and message method works for the owner (conversation and agent Token)', async () => {
      const tokAgent = await kaltura.sessions.createAgentToken({ agentId, configId, userId: user('a') });
      /** @type {Record<string, any>} */ const results = {};
      for (const [label, tok] of /** @type {[string, any][]} */ ([['conversation', tokA], ['agent', tokAgent]])) {
        const title = `lv-${tag}-${label}`;
        const msgs = await kaltura.messages.list(tok, { threadId: threadA });
        const msgId = msgs?.[0]?.id;
        const transcript = await kaltura.threads.transcript(threadA, tok);
        const renamed = await kaltura.threads.rename(threadA, title, tok);
        const set = await kaltura.threads.setAnalysis(threadA, { lv: label }, tok);
        const cleared = await kaltura.threads.clearAnalysis(threadA, tok);
        const msg = msgId ? await kaltura.messages.get(msgId, tok) : null;
        const shared = withShare && msgId ? await kaltura.messages.share(msgId, `shared-${title}`, tok) : null;
        results[label] = {
          messages: msgs?.length ?? 0,
          transcript: typeof transcript?.data === 'string' && transcript.data.length > 0,
          renamed: renamed?.title === title,
          analysisSet: set?.thread_metadata?.analysis?.lv === label,
          analysisCleared: !cleared?.thread_metadata?.analysis,
          messageGet: msg?.id === msgId,
          ...(withShare ? { shareId: !!shared?.newMessageId } : {}),
        };
      }
      report.check('SDK: every relaxed thread and message method works for the owner (conversation and agent Token)',
        Object.values(results).every((r) => r.messages > 0 && Object.values(r).every(Boolean)), results);
    });

    await step('SDK: another user Token cannot rename, annotate or read the messages of the owner thread', async () => {
      const before = await adminThread(threadA);
      const msgId = (await kaltura.messages.list(admin, { threadId: threadA }))?.[0]?.id;
      /** @type {Record<string, any>} */ const out = {};
      const attempt = async (/** @type {string} */ name, /** @type {() => Promise<any>} */ fn) => {
        try { const r = await fn(); out[name] = { ok: true, rows: Array.isArray(r) ? r.length : undefined }; } catch (e) { out[name] = { status: /** @type {any} */ (e)?.status, code: /** @type {any} */ (e)?.code }; }
      };
      await attempt('transcript', () => kaltura.threads.transcript(threadA, tokB));
      await attempt('rename', () => kaltura.threads.rename(threadA, 'hijacked', tokB));
      await attempt('setAnalysis', () => kaltura.threads.setAnalysis(threadA, { hijacked: true }, tokB));
      await attempt('clearAnalysis', () => kaltura.threads.clearAnalysis(threadA, tokB));
      await attempt('messages.get', () => kaltura.messages.get(msgId, tokB));
      await attempt('messages.share', () => kaltura.messages.share(msgId, 'hijacked', tokB));
      const after = await adminThread(threadA);
      /** @type {any[]} */ let listRows = [];
      try { listRows = await kaltura.messages.list(tokB, { threadId: threadA }); } catch { /* a server error also means nothing was listed */ }
      const denied = ['transcript', 'rename', 'setAnalysis', 'clearAnalysis', 'messages.get', 'messages.share'].every((k) => out[k].status >= 400 && out[k].code !== 'wrong_token_scope');
      report.check('SDK: another user Token cannot rename, annotate or read the messages of the owner thread',
        denied && (listRows?.length ?? 0) === 0 && after?.title === before?.title && !after?.thread_metadata?.analysis?.hijacked, { ...out, listRows: listRows?.length ?? 0, titleUnchanged: after?.title === before?.title });
    });

    await step('SDK: a widget Token is refused client-side on every relaxed method', async () => {
      const widget = await kaltura.sessions.createWidgetToken({ widgetId });
      const calls = {
        'threads.list': () => kaltura.threads.list(widget),
        'threads.get': () => kaltura.threads.get(threadA, widget),
        'threads.transcript': () => kaltura.threads.transcript(threadA, widget),
        'threads.rename': () => kaltura.threads.rename(threadA, 'x', widget),
        'threads.setAnalysis': () => kaltura.threads.setAnalysis(threadA, { a: 1 }, widget),
        'threads.clearAnalysis': () => kaltura.threads.clearAnalysis(threadA, widget),
        'threads.delete': () => kaltura.threads.delete([threadA], widget, { confirmPermanent: true }),
        'messages.list': async () => { await kaltura.messages.list(widget, { threadId: threadA }); },
        'messages.get': () => kaltura.messages.get('m', widget),
        'messages.share': () => kaltura.messages.share('m', 't', widget),
      };
      /** @type {Record<string, string>} */ const codes = {};
      for (const [name, fn] of Object.entries(calls)) {
        try { await fn(); codes[name] = 'NO_ERROR'; } catch (e) { codes[name] = String(/** @type {any} */ (e)?.code); }
      }
      report.check('SDK: a widget Token is refused client-side on every relaxed method', Object.values(codes).every((c) => c === 'wrong_token_scope'), codes);
    });

    await step('sessionType admin has admin-level reach (other users threads, OVP user.list)', async () => {
      const tokAdm = await kaltura.sessions.createConversationToken({ configId, agentId, userId: user('c'), sessionType: 'admin' });
      const r = await genie('v1/thread/get', { id: threadA }, tokAdm.ks);
      const u = await ovp('user', 'list', { pager: { pageSize: 1 } }, tokAdm.ks);
      report.check('sessionType admin has admin-level reach (other users threads, OVP user.list)', tokAdm.sessionType === 'admin' && r.status === 200 && u.ok,
        { sessionType: tokAdm.sessionType, threadGet: r.status, userList: u.ok ? 'ok' : u.code });
    });

    await step('user session has no OVP admin reach', async () => {
      const u = await ovp('user', 'list', { pager: { pageSize: 1 } }, tokA.ks);
      const p = await ovp('partner', 'getInfo', {}, tokA.ks);
      const e = await ovp('baseEntry', 'list', { pager: { pageSize: 1 } }, tokA.ks);
      // An empty user result proves nothing on a partner with no entries, so compare against the admin total.
      const ea = await ovp('baseEntry', 'list', { pager: { pageSize: 1 } }, admin.ks);
      const adminTotal = ea.ok ? Number(ea.result?.totalCount) : NaN;
      if (ea.ok && adminTotal === 0) report.note('skipped: partner has no entries, entry reach not checked');
      report.check('user session has no OVP admin reach', !u.ok && !p.ok && ea.ok && (adminTotal === 0 || (e.ok && e.result?.totalCount === 0)),
        { userList: u.ok ? 'ok' : u.code, partnerGetInfo: p.ok ? 'ok' : p.code, adminEntries: ea.ok ? adminTotal : ea.code, userEntries: e.ok ? e.result?.totalCount : e.code });
    });

    await step('SDK: threads.delete removes the owner thread; another user Token deletes nothing', async () => {
      const r = await say(tokA, 'Reply with one short sentence.');
      const threadD = r.threadId;
      if (threadD) threads.add(threadD);
      const byB = await kaltura.threads.delete([threadD], tokB, { confirmPermanent: true });
      const stillThere = (await adminThread(threadD)) !== null;
      const byA = await kaltura.threads.delete([threadD], tokA, { confirmPermanent: true });
      const gone = (await adminThread(threadD)) === null;
      if (gone) threads.delete(threadD);
      report.check('SDK: threads.delete removes the owner thread; another user Token deletes nothing',
        !!threadD && byB?.totalCount === 0 && stillThere && byA?.totalCount === 1 && gone,
        { otherUserDeleted: byB?.totalCount, stillThereAfterOtherUser: stillThere, ownerDeleted: byA?.totalCount, gone });
    });

    await step('SDK: a raw KS string passes through and the server enforces scope', async () => {
      const widget = await kaltura.sessions.createWidgetToken({ widgetId });
      const own = await kaltura.threads.get(threadA, tokA.ks);
      const other = await kaltura.threads.get(threadA, tokB.ks).then(() => null, (e) => e);
      const asWidget = await kaltura.threads.get(threadA, widget.ks).then(() => null, (e) => e);
      report.check('SDK: a raw KS string passes through and the server enforces scope',
        own?.id === threadA && other?.status === 404 && asWidget?.status === 403 && asWidget?.code !== 'wrong_token_scope',
        { own: own?.id === threadA, otherUser: other?.status, widgetString: asWidget?.status, widgetCode: asWidget?.code });
    });

    await step('user A deletes its own thread', async () => {
      const r = await genie('v1/thread/delete', { thread_ids: [threadA] }, tokA.ks);
      const gone = (await adminThread(threadA)) === null;
      if (gone) threads.delete(threadA);
      report.check('user A deletes its own thread', r.status === 200 && r.body?.totalCount === 1 && deletedIds(r).includes(threadA) && gone,
        { status: r.status, totalCount: r.body?.totalCount, listsThread: deletedIds(r).includes(threadA), gone });
    });
  }

  await step('no userId: any holder continues the thread, read/list/delete 403', async () => {
    const n1 = await kaltura.sessions.createConversationToken({ configId, agentId });
    const n2 = await kaltura.sessions.createConversationToken({ configId, agentId });
    const r1 = await say(n1, 'Hello. Reply with one short sentence.');
    if (r1.threadId) threads.add(r1.threadId);
    const marker = `marker-${tag}-n`;
    const r2 = await say(n2, `Repeat this word back: ${marker}`, r1.threadId);
    const joined = r2.threadId === r1.threadId && String((await kaltura.threads.transcript(r1.threadId, admin))?.data ?? '').includes(marker);
    const get = await genie('v1/thread/get', { id: r1.threadId }, n1.ks);
    const list = await threadList(n2.ks);
    const del = await genie('v1/thread/delete', { thread_ids: [r1.threadId] }, n2.ks);
    const still = !!(await adminThread(r1.threadId));
    report.check('no userId: any holder continues the thread, read/list/delete 403',
      n1.sessionType === 'user' && joined && get.status === 403 && list.status === 403 && del.status === 403 && still,
      { sessionType: n1.sessionType, secondTokenContinues: joined, ownGet: get.status, list: list.status, delete: del.status, deleteDetail: del.body?.detail, stillPresent: still });
  });

  await step('createAgentToken without configId answers as the agent', async () => {
    const tokD = await kaltura.sessions.createAgentToken({ agentId, userId: user('d') });
    const intellect = await kaltura.intellects.get(configId, admin);
    const name = String(intellect?.prompts?.find((/** @type {any} */ p) => p.key === 'name')?.value ?? '').trim();
    // Match the longest word of the configured name, not a common word like "the".
    // A model can answer without its name, so allow one retry.
    const needle = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort((x, y) => y.length - x.length)[0];
    let r = await say(tokD, 'What is your name? Reply with your name only.');
    if (r.threadId) threads.add(r.threadId);
    let attempts = 1;
    if (needle && !r.text.toLowerCase().includes(needle)) {
      r = await say(tokD, 'What is your name? Reply with your name only.');
      if (r.threadId) threads.add(r.threadId);
      attempts = 2;
    }
    const t = r.threadId ? await adminThread(r.threadId) : null;
    const nameInReply = !!needle && r.text.toLowerCase().includes(needle);
    report.check('createAgentToken without configId answers as the agent',
      tokD.privileges.includes(`geniegpcid:${configId}`) && nameInReply && t?.agent_id === agentId && t?.user_id === user('d'),
      { configResolved: tokD.privileges.includes(`geniegpcid:${configId}`), nameInReply, attempts, agentLabel: t?.agent_id === agentId, owner: t?.user_id === user('d') });
  });

  await step('appInit with a per-user agent token converses as that user', async () => {
    const tokE = await kaltura.sessions.createAgentToken({ agentId, configId, userId: user('e') });
    const init = await kaltura.application.appInit(tokE);
    const r = await say(init.ks, 'Hello. Reply with one short sentence.');
    if (r.threadId) threads.add(r.threadId);
    const t = r.threadId ? await adminThread(r.threadId) : null;
    const other = r.threadId ? await genie('v1/thread/get', { id: r.threadId }, tokB.ks) : { status: 0 };
    report.check('appInit with a per-user agent token converses as that user',
      !!init.ks && !!r.text && t?.user_id === user('e') && t?.agent_id === agentId && other.status >= 400,
      { reply: !!r.text, owner: t?.user_id === user('e'), agentLabel: t?.agent_id === agentId, otherUserGet: other.status });
  });

  await step('widget: any visitor continues the thread, read/list/delete 403', async () => {
    const widget = await kaltura.sessions.createWidgetToken({ widgetId });
    const list = await threadList(widget.ks);
    const init1 = await kaltura.application.appInit(widget.ks);
    const init2 = await kaltura.application.appInit((await kaltura.sessions.createWidgetToken({ widgetId })).ks);
    const r1 = await say(init1.ks, 'Hello. Reply with one short sentence.');
    if (r1.threadId) threads.add(r1.threadId);
    const marker = `marker-${tag}-w`;
    const r2 = await say(init2.ks, `Repeat this word back: ${marker}`, r1.threadId);
    const joined = r2.threadId === r1.threadId && String((await kaltura.threads.transcript(r1.threadId, admin))?.data ?? '').includes(marker);
    const get = await genie('v1/thread/get', { id: r1.threadId }, init2.ks);
    const del = await genie('v1/thread/delete', { thread_ids: [r1.threadId] }, init2.ks);
    const still = !!(await adminThread(r1.threadId));
    report.check('widget: any visitor continues the thread, read/list/delete 403', joined && get.status === 403 && list.status === 403 && del.status === 403 && still,
      { list: list.status, secondVisitorContinues: joined, secondVisitorGet: get.status, delete: del.status, deleteDetail: del.body?.detail, stillPresent: still });
  });

  if (args['skip-revoke']) {
    report.note('revoke skipped (--skip-revoke)');
  } else {
    await step('revoke ends the token and its sessionGroupId sibling', async () => {
      const group = `lv-st-${tag}`;
      const r1 = await kaltura.sessions.createConversationToken({ configId, agentId, userId: user('f'), restrictions: { sessionGroupId: group } });
      const r2 = await kaltura.sessions.createConversationToken({ configId, agentId, userId: user('f'), restrictions: { sessionGroupId: group } });
      const probe = (/** @type {string} */ ks) => ovp('baseEntry', 'list', { pager: { pageSize: 1 } }, ks);
      const before = await probe(r1.ks);
      await kaltura.sessions.revoke(r1);
      // Revocation takes effect within seconds, so poll for up to 30s.
      const start = Date.now();
      let after1 = await probe(r1.ks);
      while (after1.ok && Date.now() - start < 30000) { await sleep(1000); after1 = await probe(r1.ks); }
      const tookMs = Date.now() - start;
      const after2 = await probe(r2.ks);
      report.check('revoke ends the token and its sessionGroupId sibling', before.ok && !after1.ok && !after2.ok,
        { before: before.ok ? 'ok' : before.code, revoked: after1.ok ? 'ok' : after1.code, sibling: after2.ok ? 'ok' : after2.code, tookMs });
    });
  }
} catch (err) {
  const e = /** @type {any} */ (err);
  report.check('run completed', false, redact(String(e?.code || e?.message || e)).slice(0, 200));
} finally {
  if (admin) {
    for (const id of threads) {
      try { await kaltura.threads.delete([id], admin, { confirmPermanent: true }); } catch { /* best effort */ }
    }
    const left = [];
    for (const id of threads) if (await adminThread(id).catch(() => 'error')) left.push(id);
    report.check('scratch threads deleted', left.length === 0, { remaining: left.length });
    if (agent) {
      await agent.cleanup();
      if (!agent.reused && !args.keep) {
        const gone = await verifyDeleted(kaltura, admin, agent);
        report.check('agent resources deleted', Object.values(gone).every((v) => v === 'deleted'), gone);
      }
    }
  }
  const rows = report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)]);
  report.write(outDir, `# Session types: ${target.name}\n\n${mdTable(['', 'check', 'detail'], rows)}\n`);
  process.exitCode = report.failed ? 1 : 0;
}
