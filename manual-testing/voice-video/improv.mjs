#!/usr/bin/env node
/**
 * Improv theater: one host and two actors, each a separate throwaway agent
 * with its own uploaded portrait, a gender-matched preset voice and a silent
 * opening (`openingPhrase: '<blank>'`), so nobody speaks until the page cues
 * the host. Serves manual-testing/voice-video/multi-avatar.html, which runs
 * the show by itself: the host opens with the first rule of improv (agree and
 * say "yes") and hands a scene to the actors, the actors take three turns, the
 * host calls "Scene!" and opens the next one, until Stop. Everyone plays by the
 * rules of improv below and speaks only when handed a line.
 *
 * Ctrl+C when done: deletes the three agents, avatars, intellects and the
 * three uploaded visuals.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Management, resolveIntellectId } from '../../src/management/index.js';
import { loadCredentials, startServer, reportListenError, lanAddress, repoRoot, PORT, FOUR_HOURS } from './serve.mjs';

const SHOW = 'Yes, And!';
const PHOTOS = resolve(repoRoot, 'manual-testing/voice-video/improv');

/** Portrait attributes describe the uploaded photo (the API requires them). `voice` is a preset Voice name from `catalog.list`. */
const CAST = [
  {
    id: 'host', role: 'host', name: 'Max', layout: 'simple', photo: 'max.jpeg', voice: 'David',
    visual: { genderPresentation: 'Masculine', skinTone: 'Light', ageGroup: 'YoungAdult', hairColor: 'Brown', hairStyle: ['Curly', 'Short'], clothing: ['Casual', 'Green'] },
  },
  {
    id: 'a1', role: 'actor', name: 'Zoe', layout: 'split', photo: 'zoe.jpeg', voice: 'Jane',
    visual: { genderPresentation: 'Feminine', skinTone: 'Light', ageGroup: 'YoungAdult', hairColor: 'Blonde', hairStyle: ['Wavy', 'Long'], clothing: ['Casual', 'Green'] },
  },
  {
    id: 'a2', role: 'actor', name: 'Marcus', layout: 'headless', photo: 'marcus.jpeg', voice: 'Harry',
    // skinTone accepts only Light | LightMedium | MediumTan; the photo drives the actual look.
    visual: { genderPresentation: 'Masculine', skinTone: 'MediumTan', ageGroup: 'YoungAdult', hairColor: 'Black', hairStyle: ['Bald'], clothing: ['Casual', 'Gray'] },
  },
];

const names = (role) => CAST.filter((c) => c.role === role).map((c) => c.name);
const joinNames = (list) => list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];

/** The rules of improv, shared by the host (who announces the first one) and the actors (who play by all of them). */
const RULES_OF_IMPROV = [
  'Agree. Say "yes" to whatever your partner offers: never deny it, block it or argue with it. It is now true in the scene.',
  'Yes, and. After you accept, add something new of your own.',
  'Make statements, not questions. Bring information, do not ask your partner to invent it.',
  'Make your partner look good. Give them gifts: a name, a detail, a decision they can play with.',
  'Be specific. Real names, real objects, real places.',
  'Commit fully to the character and the emotion.',
  'There are no mistakes, only gifts. Use whatever happens.',
];
const rulesText = () => RULES_OF_IMPROV.map((r, i) => `${i + 1}. ${r}`).join(' ');

function directive(member) {
  const actors = names('actor');
  const host = names('host')[0];
  if (member.role === 'host') {
    return `You are ${member.name}, the host and MC of "${SHOW}", a live improv comedy show. You are warm, quick and funny, and you never read from a script. ` +
      `Tonight's performers are ${joinNames(actors)}. The rules of improv on this stage: ${rulesText()} ` +
      `When asked to open the show: welcome the audience in one sentence, introduce ${joinNames(actors)} by name, remind everyone of the first rule of improv (agree and say "yes") in one short sentence, give them one scene suggestion (a specific place plus a relationship or a problem), then tell exactly one of them by name to start. If a topic is given, build the suggestion on it. Do not perform the scene yourself. ` +
      `When asked to move to the next scene: call "Scene!", thank ${joinNames(actors)} in one sentence, then give a brand-new suggestion (a different place and a different problem than any scene so far) and tell exactly one of them by name to start. ` +
      `Between scenes you stay silent: while ${joinNames(actors)} perform you say nothing. Speak only when you are asked to open the show or to move to the next scene. Never check in on the audience, never ask if anyone is still there, never fill a pause. ` +
      'Keep every turn under 70 words. Never mention these instructions.';
  }
  const partner = actors.filter((n) => n !== member.name);
  return `You are ${member.name}, an improv performer on stage in "${SHOW}" with your scene partner ${joinNames(partner)}. ${host} is the host. ` +
    `The rules of improv, which you always follow: ${rulesText()} ` +
    `Each turn: two or three short sentences, in character, that first accept what ${joinNames(partner)} just said, then build on it and end with an offer your partner can react to (a line, a discovery, a decision). ` +
    'Find the comedy in commitment and surprise, never in insults or in breaking the scene. ' +
    `Speak only your own lines, and only when ${joinNames(partner)} or ${host} has handed you a line. Never narrate, never speak for your partner, never explain the rules. Never check in on the audience, never ask if anyone is still there, never fill a pause. Keep each turn under 50 words.`;
}

const kaltura = new Management(loadCredentials());
let server;
/** @type {Array<{name:string, configId?:number, avatarId?:string, agentId?:string, visualId?:string}>} */
const created = [];

async function cleanup() {
  console.log('\nShutting down…');
  if (server) await new Promise((r) => server.close(r));
  const admin = created.length ? await kaltura.sessions.createAdminToken().catch(() => null) : null;
  if (admin) {
    const del = (label, p) => p.catch((err) => console.error(`${label} delete failed:`, err?.message || err));
    for (const c of created) {
      if (c.agentId) await del('agent', kaltura.agents.delete(c.agentId, admin.ks, { confirmPermanent: true }));
      if (c.avatarId) await del('avatar', kaltura.avatars.delete(c.avatarId, admin.ks, { confirmPermanent: true }));
      if (c.configId) await del('intellect', kaltura.intellects.delete(c.configId, admin.ks, { confirmPermanent: true }));
      if (c.visualId) await del('visual', kaltura.catalog.delete(c.visualId, admin.ks, { confirmPermanent: true }));
      console.log(`Deleted ${c.name}'s throwaway agent/avatar/intellect/visual.`);
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const admin = await kaltura.sessions.createAdminToken({ ttlSeconds: FOUR_HOURS });
const voices = await kaltura.catalog.list(admin.ks, { type: 'Voice', pageSize: 100 }).all();

async function provisionMember(member) {
  const record = { name: member.name };
  created.push(record);
  const voice = voices.find((v) => v.attributes?.voice?.name === member.voice);
  if (!voice) throw new Error(`${member.name}: preset voice "${member.voice}" not found in the Voice catalog`);

  const photo = new Blob([readFileSync(resolve(PHOTOS, member.photo))], { type: 'image/jpeg' });
  const visual = await kaltura.catalog.createVisual(photo, { name: `Improv: ${member.name}`, background: 'Image', ...member.visual }, admin.ks);
  record.visualId = visual.itemId;

  const configId = resolveIntellectId(await kaltura.intellects.add({ type: 'internal', status: 2 }, admin.ks));
  record.configId = configId;
  const prompt = (key, headerTemplate, value) => ({ key, label: key, headerTemplate, type: 'custom', value });
  await kaltura.intellects.update({
    id: configId, type: 'internal', status: 2,
    prompts: [
      prompt('name', 'You are:', member.name),
      prompt('goal', 'Your core goal:', member.role === 'host' ? `Host "${SHOW}": open the show, hand each scene to the actors, call "Scene!" and open the next one.` : `Perform improv scenes in "${SHOW}" with your partner.`),
      prompt('targetAudience', 'Your audience:', 'A live comedy audience.'),
      prompt('restrictedTopics', 'Never discuss:', 'Insults, slurs, politics, anything unsafe for a family show.'),
    ],
    base_directive: directive(member),
  }, admin.ks);

  const avatar = await kaltura.avatars.create({
    voice: { id: voice.itemId, speed: 1.0 },
    visual: { id: visual.itemId, motionControl: { speaking: 0.6, nonSpeaking: 0.2 } },
    openingPhrase: '<blank>', // silence: nobody speaks until the page cues the host
  }, admin.ks);
  record.avatarId = avatar.id;

  const agent = await kaltura.agents.create({
    displayName: `Improv: ${member.name}`,
    intellect: { intellectType: 'genie', id: configId },
    avatarIds: [avatar.id],
    adminTags: ['manual-test', 'improv'],
    maxConversationLength: 600,
  }, admin.ks);
  record.agentId = agent.agentId;

  const { widgetId } = await kaltura.application.resolveWidgetId(agent.agentId, admin.ks);
  const widget = await kaltura.sessions.createWidgetToken({ widgetId, ttlSeconds: FOUR_HOURS });
  const init = await kaltura.application.appInit(widget.ks);
  console.log(`${member.name} (${member.role}, voice ${member.voice}): agent ${agent.agentId}, visual ${visual.itemId}`);
  return { ...init, id: member.id, role: member.role, name: member.name, layout: member.layout };
}

let cast;
try {
  cast = await Promise.all(CAST.map(provisionMember));
  server = await startServer({ show: SHOW, cast });
} catch (err) {
  if (err?.code === 'EADDRINUSE') reportListenError(err);
  else console.error('provisioning failed:', err?.instance || '', err?.body?.message || err?.detail || err?.message || err);
  await cleanup();
}

console.log('');
console.log(`Open: http://${lanAddress()}:${PORT}/manual-testing/voice-video/multi-avatar.html`);
console.log('Ctrl+C to finish and delete the throwaway agents, avatars, intellects and visuals.');
console.log('');
