'use strict';
// Verification rapide de la couche de donnees, sans Electron : npm run test:data
const sessions = require('./sessions');
const transcript = require('./transcript');

let t = Date.now();
const list = sessions.listSessions();
console.log(`liste : ${list.length} sessions en ${Date.now() - t} ms (1er passage)`);
t = Date.now();
sessions.listSessions();
console.log(`liste : ${Date.now() - t} ms (avec cache)`);

const live = sessions.liveSessions();
console.log('sessions vivantes :', Object.entries(live).map(([id, l]) => `${id.slice(0, 8)} ${l.status} pid=${l.pid}`));

for (const s of list.slice(0, 5)) {
  console.log(`- ${s.id.slice(0, 8)} | ${s.lastActivity} | ${(s.size / 1024).toFixed(0)} Ko | ${s.cwd} | ${s.title}`);
}

const big = [...list].sort((a, b) => b.size - a.size)[0];
t = Date.now();
const { items } = transcript.readAll(big.file);
const kinds = {};
for (const i of items) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
console.log(`plus gros (${(big.size / 1e6).toFixed(1)} Mo) : ${items.length} elements en ${Date.now() - t} ms`, kinds);

const noTitle = list.filter(s => s.title === '(sans titre)').length;
const noCwd = list.filter(s => !s.cwd).length;
console.log(`sans titre : ${noTitle}, sans dossier : ${noCwd}`);

// ---- equipe : prompts, arguments, registre, controle des workers ----
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const team = require('./team');
const CTX = { registryPath: '/tmp/x/registry.json', hookPath: '/tmp/x/hooks/only-manager.py', maxWorkers: 6 };
const home = os.homedir();

// worker : mode impose par l'appelant, hook limite a "chef", dossier du registre NON accessible
const w = team.validateSpec({ kind: 'worker', name: 'api-auth', managerName: 'chef', cwd: home, role: 'Pas de push.', task: 'Faire le login', mode: 'bypass' }, new Set());
const wargs = team.createArgs('11111111-2222-3333-4444-555555555555', w, CTX);
assert.deepStrictEqual(wargs.slice(0, 3), ['-n', 'api-auth', '--dangerously-skip-permissions']);
assert.strictEqual(wargs[wargs.indexOf('--session-id') + 1], '11111111-2222-3333-4444-555555555555');
assert.deepStrictEqual(wargs.slice(-2), ['--session-id', '11111111-2222-3333-4444-555555555555'], "la tache n'est plus en argument : elle part par l'entree standard");
assert.ok(!wargs.includes('--') && !wargs.includes('Faire le login'));
assert.ok(!wargs.includes('--add-dir'), "un worker n'a pas besoin du dossier de l'equipe");
const wset = JSON.parse(wargs[wargs.indexOf('--settings') + 1]);
assert.strictEqual(wset.hooks.PreToolUse[0].matcher, 'SendMessage');
assert.ok(wset.hooks.PreToolUse[0].hooks[0].command.includes('only-manager.py') && wset.hooks.PreToolUse[0].hooks[0].command.includes('"chef"'));
const wp = wargs[wargs.indexOf('--append-system-prompt') + 1];
assert.ok(wp.startsWith('Pas de push.') && wp.includes('to: "chef"') === false && wp.includes('« chef »') && wp.includes('[api-auth]') && wp.includes('SEUL interlocuteur'));

// manager : cree par l'appli (jamais par un formulaire), --add-dir suivi d'une option, modele facultatif
const mgr = { kind: 'manager', name: 'manager', managerName: 'manager', cwd: home, role: team.MANAGER_ROLE, task: '', mode: 'acceptEdits', model: 'sonnet' };
const mflags = team.sessionFlags(mgr, CTX);
assert.deepStrictEqual(mflags.slice(0, 8), ['--add-dir', '/tmp/x', '-n', 'manager', '--permission-mode', 'acceptEdits', '--model', 'sonnet']);
const mp = mflags[mflags.indexOf('--append-system-prompt') + 1];
assert.ok(mp.includes('/tmp/x/requests/') && mp.includes('/tmp/x/responses/') && mp.includes('"action":"create"') && mp.includes('relaie'));
assert.throws(() => team.validateSpec({ kind: 'manager', name: 'manager', cwd: home }, new Set()), /Type de session invalide/);
assert.ok(mp.includes('TOUS les droits') && mp.includes('"bypass"') && mp.includes('Au plus 6'), 'le manager sait qu\'il a tous les droits et peut choisir le mode d\'un worker');
assert.ok(team.sessionFlags(mgr, { ...CTX, maxWorkers: 0 }).join(' ').includes('Pas de limite au nombre de workers'), '0 = pas de limite annoncee au manager');
assert.deepStrictEqual(team.sessionFlags({ ...mgr, mode: 'bypass', model: '' }, CTX).slice(0, 5), ['--add-dir', '/tmp/x', '-n', 'manager', '--dangerously-skip-permissions']);

// validation
for (const bad of [{ name: 'a b' }, { name: '' }, { name: '-x' }, { name: 'x'.repeat(41) }, { name: 'ok', kind: 'inconnu' }, { name: 'ok', cwd: '/nexiste/pas' }]) {
  assert.throws(() => team.validateSpec({ kind: 'worker', cwd: home, managerName: 'chef', ...bad }, new Set()), `devrait refuser ${JSON.stringify(bad)}`);
}
assert.throws(() => team.validateSpec({ kind: 'worker', name: 'Api-Auth', managerName: 'chef', cwd: home }, new Set(['api-auth'])), /déjà utilisé/);
assert.throws(() => team.validateSpec({ kind: 'worker', name: 'chef', managerName: 'CHEF', cwd: home }, new Set()), /nom du manager/);

// reglages et demandes du manager
assert.deepStrictEqual(team.normalizeSettings({}), team.DEFAULT_SETTINGS);
assert.deepStrictEqual(team.normalizeSettings({ teamMode: 'nimporte', maxWorkers: 'abc', managerModel: 'a b;rm', autostart: 'oui' }), { teamMode: 'bypass', autostart: true, maxWorkers: 6, managerModel: '', closeWorkersOnQuit: true, managerEffort: '', workerEffort: '', managerCanGrant: false, grantCategories: [], tickEnabled: false, tickMinutes: 3, tickStopAfter: 3, tickPauseOnBlocked: true, tickText: team.DEFAULT_TICK_TEXT });
assert.strictEqual(team.normalizeSettings({ closeWorkersOnQuit: false }).closeWorkersOnQuit, false);
assert.strictEqual(team.normalizeSettings({ maxWorkers: 99 }).maxWorkers, 50, 'borne haute');
assert.strictEqual(team.normalizeSettings({ maxWorkers: 0 }).maxWorkers, 0, '0 = illimite');
assert.strictEqual(team.normalizeSettings({ maxWorkers: -5 }).maxWorkers, 0, 'jamais negatif');
assert.strictEqual(team.normalizeSettings({ maxWorkers: 3, managerModel: 'sonnet' }).managerModel, 'sonnet');
assert.throws(() => team.checkRequest({ action: 'delete', name: 'x' }), /action inconnue/);
assert.throws(() => team.checkRequest({ action: 'create' }), /name manquant/);
assert.throws(() => team.checkRequest([]), /objet JSON/);
assert.strictEqual(team.checkRequest({ action: 'resume', name: 'api' }).action, 'resume');
assert.throws(() => team.checkRequest({ action: 'adopt', name: 'x', id: 'pas-un-uuid' }), /id de session/);
assert.strictEqual(team.checkRequest({ action: 'adopt', name: 'x', id: '11111111-2222-3333-4444-555555555555' }).action, 'adopt');
assert.ok(team.adoptMessage({ name: 'dev' }, 'home-ubuntu-8f').includes('home-ubuntu-8f'));

// effort de reflexion
assert.deepStrictEqual(team.EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
assert.ok(team.sessionFlags({ ...w, effort: 'high' }, CTX).join(' ').includes('--effort high'), 'effort transmis a la CLI');
assert.ok(!team.sessionFlags({ ...w, effort: 'nimporte' }, CTX).includes('--effort'), 'valeur inconnue : jamais transmise');
assert.ok(!team.sessionFlags(w, CTX).includes('--effort'), 'sans choix : celui par defaut de Claude Code');
assert.ok(team.sessionFlags({ ...mgr, effort: 'max' }, CTX).join(' ').includes('--effort max'));
assert.deepStrictEqual([team.normalizeSettings({ workerEffort: 'max', managerEffort: 'x' }).workerEffort, team.normalizeSettings({ workerEffort: 'max', managerEffort: 'x' }).managerEffort], ['max', ''], 'defauts d\'effort valides ou vides');

// regles SI ... ALORS ...
{
  const R = require('./rules');
  const names = ['collecteur', 'postulant', 'manager'];
  const ok = R.validateRule({ agent: 'collecteur', trigger: { type: 'message', mode: 'startsWith', text: '[collecteur] OFFRE' }, action: { type: 'send', to: 'postulant', template: 'Postule : {message}' }, max: 5 }, names);
  assert.strictEqual(ok.max, 5);
  assert.strictEqual(R.validateRule({ agent: 'collecteur', trigger: { type: 'idle' }, action: { type: 'pause' } }, names).max, 20, 'maximum par defaut : jamais de boucle sans fin');
  for (const bad of [{ agent: 'inconnu' }, { max: 0 }, { max: 5000 }, { max: 1.5 }, { action: { type: 'send', to: 'nimporte', template: 'x' } }, { action: { type: 'send', to: 'manager', template: '  ' } }, { trigger: { type: 'message', mode: 'regex', text: '(' } }, { trigger: { type: 'nimporte' } }]) {
    assert.throws(() => R.validateRule({ agent: 'collecteur', trigger: { type: 'message', mode: 'contains', text: 'a' }, action: { type: 'send', to: 'postulant', template: 'x' }, ...bad }, names), `doit refuser ${JSON.stringify(bad)}`);
  }
  const ev = (message, type = 'message', agent = 'collecteur') => ({ type, agent, message });
  assert.ok(R.matches(ok, ev('[collecteur] OFFRE : dev junior')));
  assert.ok(R.matches(ok, ev('  [COLLECTEUR] offre : x')), 'insensible a la casse');
  assert.ok(!R.matches(ok, ev('bonjour')) && !R.matches(ok, ev('[collecteur] OFFRE', 'message', 'postulant')) && !R.matches(ok, ev('[collecteur] OFFRE', 'idle')));
  assert.ok(!R.matches({ ...ok, enabled: false }, ev('[collecteur] OFFRE')));
  assert.ok(R.matches({ ...ok, trigger: { type: 'message', mode: 'regex', text: 'POSTUL(É|E)\\b' }, enabled: true }, ev('POSTULE')));
  assert.ok(R.matches({ ...ok, trigger: { type: 'message', mode: 'contains', text: '' } }, ev('n importe quoi')), 'texte vide = tout message');
  assert.strictEqual(R.render('De {agent} vers {to} : {message}', ev('OFFRE 1'), 'postulant'), 'De collecteur vers postulant : OFFRE 1');
  assert.ok(R.describe(ok).includes('ALORS envoyer à postulant'));
}

// registre
const reg = team.buildRegistry({
  specs: { id1: { name: 'api-auth', kind: 'worker', cwd: '/c', task: 't', mode: 'bypass', createdAt: new Date().toISOString() },
           mgr: { name: 'manager', kind: 'manager', cwd: '/m', task: '', mode: 'acceptEdits', createdAt: new Date().toISOString() },
           old: { name: 'perdu', kind: 'worker', cwd: '/c', task: 't', mode: 'standard', createdAt: '2020-01-01T00:00:00Z' } },
  sessions: [{ id: 'id1', lastActivity: '2026-10-12T10:00:00Z', lastAssistant: 'Fini.', file: '/f.jsonl' }],
  live: { id1: { status: 'busy', pid: 42 } },
  managerName: 'manager',
});
assert.deepStrictEqual(reg.sessions.map(r => r.name), ['manager', 'api-auth'], 'le manager est en tete, le lancement abandonne depuis plus de 24 h est masque');
assert.deepStrictEqual([reg.sessions[1].status, reg.sessions[1].pid, reg.sessions[1].lastMessage], ['busy', 42, 'Fini.']);
assert.ok(!('transcript' in reg.sessions[1]), "les transcriptions ne sont pas exposees au manager");
assert.strictEqual(reg.sessions[1].address, 'api-auth', "session fermee : l'adresse est son nom d'equipe");
const reg2 = team.buildRegistry({ specs: { a: { name: 'dev', kind: 'worker', adopted: true, cwd: '/c', task: '', mode: 'acceptEdits', createdAt: new Date().toISOString() } }, sessions: [], live: { a: { status: 'idle', pid: 7, name: 'home-ubuntu-8f' } }, managerName: 'manager' });
assert.deepStrictEqual([reg2.sessions[0].name, reg2.sessions[0].address, reg2.sessions[0].adopted], ['dev', 'home-ubuntu-8f', true], "session rattachee ouverte : l'adresse est son nom reel");

// variables d'identite de la session parente retirees
const env = require('./launch').cleanEnv({ CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_SESSION_ID: 'x', CLAUDECODE: '1', PATH: '/bin', HOME: '/h' });
assert.deepStrictEqual(Object.keys(env).sort(), ['HOME', 'PATH']);

// le controle des workers : vrai script, vrai python
const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-')), 'only-manager.py');
fs.writeFileSync(hook, team.ONLY_MANAGER_HOOK);
const run = (to) => spawnSync('python3', ['-I', hook, 'manager'], { input: JSON.stringify({ tool_name: 'SendMessage', tool_input: { to, message: 'x' } }), encoding: 'utf8' });
assert.strictEqual(run('manager').status, 0, 'le manager est autorise');
assert.strictEqual(run('Manager [abc123]').status, 0, 'avec sa reference et quelle que soit la casse');
for (const to of ['autre-worker', 'main', '', 'manager2', 'xmanager']) {
  const r = run(to);
  assert.strictEqual(r.status, 2, `doit refuser « ${to} »`);
  assert.ok(r.stderr.includes('manager'), 'le refus explique pourquoi');
}
fs.rmSync(path.dirname(hook), { recursive: true, force: true });
console.log('equipe : tous les controles passent');

// ---- AUCUN terminal : ni code, ni fonction ; controle du processus avant tout arret ----
{
  const launch2 = require('./launch');
  for (const f of ['openInTerminal', 'terminalScript', 'resume', 'startNew']) assert.strictEqual(launch2[f], undefined, `launch.${f} ne doit plus exister`);
  const root = path.join(__dirname, '..');
  for (const f of [path.join(root, 'main.js'), path.join(root, 'preload.js'), ...fs.readdirSync(__dirname).filter(n => n.endsWith('.js') && n !== 'selftest.js').map(n => path.join(__dirname, n)), path.join(root, 'renderer', 'app.js')]) {
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!/gnome-terminal|ptyxis|x-terminal-emulator|openInTerminal|xterm|konsole/.test(txt), `${path.basename(f)} ne doit contenir aucun lancement de terminal`);
  }
  const child = require('child_process').spawn('bash', ['-c', 'sleep 5; true', 'claude-x'], { stdio: 'ignore' });
  const other = require('child_process').spawn('sleep', ['5'], { stdio: 'ignore' });
  assert.strictEqual(launch2.isClaudeProcess(child.pid), true);
  assert.strictEqual(launch2.isClaudeProcess(other.pid), false, 'un autre programme ne doit jamais etre vise');
  assert.strictEqual(launch2.isClaudeProcess(999999999), false);
  child.kill(); other.kill();
  assert.ok(team.interruptedMessage({ managerName: 'manager' }).startsWith('[Application Claude Sessions]'));
}

// ---- agents en arriere-plan : demarrage, message initial, envoi, arret, reprise, plantage ----
(async () => {
  const { Agent } = require('./agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  // faux `claude` : note ses arguments, copie son entree standard, ne finit qu'a la fermeture de celle-ci
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "$@" >> "$STUB_LOG.args"\nif [ -n "$STUB_CRASH" ]; then exit 1; fi\ncat >> "$STUB_LOG.stdin"\n', { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.STUB_LOG = path.join(dir, 'log');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const read = (f) => { try { return fs.readFileSync(process.env.STUB_LOG + f, 'utf8'); } catch { return ''; } };

  const a = new Agent({ id: '11111111-2222-3333-4444-555555555555', cwd: dir, flags: ['-n', 'w1'], resume: false, firstMessage: 'Ta mission : ok.' });
  assert.strictEqual(a.start().running, true);
  await wait(500);
  assert.ok(/-p --input-format stream-json --output-format stream-json --verbose -n w1 --session-id 11111111/.test(read('.args')), 'arguments : mode sans terminal, id impose');
  a.send('Deuxieme message');
  await wait(300);
  const lines = read('.stdin').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(lines.map(l => l.message.content), ['Ta mission : ok.', 'Deuxieme message'], 'tache puis messages, au format stream-json');
  assert.ok(lines.every(l => l.type === 'user' && l.message.role === 'user'));
  assert.throws(() => a.send('   '), /Message vide/);
  await a.stop();
  assert.strictEqual(a.status().running, false);
  assert.throws(() => a.send('x'), /arrêté/);

  // reprise
  fs.writeFileSync(process.env.STUB_LOG + '.args', '');
  const b = new Agent({ id: '11111111-2222-3333-4444-555555555555', cwd: dir, flags: [], resume: true });
  b.start(); await wait(400);
  assert.ok(/--resume 11111111/.test(read('.args')) && !/--session-id/.test(read('.args')));
  await b.stop();

  // reponse d'une session ordinaire : l'effort choisi est transmis, une valeur inconnue jamais
  const reply = require('./reply');
  const rid = '22222222-2222-3333-4444-555555555555';
  fs.writeFileSync(process.env.STUB_LOG + '.args', '');
  reply.send({ id: rid, cwd: dir, text: 'Salut', effort: 'high' }, () => {});
  await wait(500);
  assert.ok(/-p --chrome --effort high --resume 22222222/.test(read('.args')), 'effort transmis a une reponse : ' + read('.args'));
  fs.writeFileSync(process.env.STUB_LOG + '.args', '');
  reply.send({ id: rid, cwd: dir, text: 'Salut', effort: 'nimporte' }, () => {});
  await wait(500);
  assert.ok(!/--effort/.test(read('.args')), 'valeur inconnue non transmise');

  // dossier absent : erreur claire, aucun processus
  const c = new Agent({ id: '11111111-2222-3333-4444-555555555555', cwd: '/nexiste/pas', flags: [] });
  const st = c.start();
  assert.ok(!st.running && /introuvable/.test(st.error));

  // plantage repete : relances limitees puis abandon (sans boucle infinie)
  process.env.STUB_CRASH = '1';
  const d = new Agent({ id: '11111111-2222-3333-4444-555555555555', cwd: dir, flags: [], restartDelayMs: 50 });
  d.start();
  for (let i = 0; i < 60 && !/en boucle/.test(d.status().error || ''); i++) await wait(100);
  assert.ok(/en boucle/.test(d.status().error), "un agent qui plante en boucle est abandonne : " + d.status().error);
  assert.strictEqual(d.status().running, false);
  delete process.env.STUB_CRASH;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('agents en arriere-plan : tous les controles passent');
})().catch((e) => { console.error(e); process.exit(1); });

// ---- demandes du manager : fichiers requests/ -> responses/ ----
(async () => {
  const requests = require('./requests');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'req-'));
  const dirs = { requests: path.join(base, 'requests'), responses: path.join(base, 'responses') };
  const seen = [];
  const stop = requests.start(dirs, async (raw) => {
    if (raw.name === 'boom') throw new Error('refuse');
    return { ok: true, echo: raw.name };
  }, (file, payload) => seen.push([file, payload.ok]));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (f) => { for (let i = 0; i < 40 && !fs.existsSync(f); i++) await wait(250); return fs.existsSync(f); };

  fs.writeFileSync(path.join(dirs.requests, 'a.json'), JSON.stringify({ action: 'create', name: 'w1' }));
  fs.writeFileSync(path.join(dirs.requests, 'b.json'), JSON.stringify({ action: 'create', name: 'boom' }));
  fs.writeFileSync(path.join(dirs.requests, 'c.json'), '{ pas du json');
  for (const f of ['a', 'b', 'c']) assert.ok(await waitFor(path.join(dirs.responses, f + '.json')), `reponse pour ${f}`);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dirs.responses, f + '.json'), 'utf8'));
  assert.deepStrictEqual(read('a'), { ok: true, echo: 'w1' });
  assert.deepStrictEqual(read('b'), { ok: false, error: 'refuse' });
  assert.strictEqual(read('c').ok, false);
  assert.strictEqual(fs.readdirSync(dirs.requests).length, 0, 'les demandes traitees sont retirees');
  assert.strictEqual(seen.length, 3, 'le retour au manager est appele pour chaque demande');
  stop();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('demandes du manager : tous les controles passent');
})().catch((e) => { console.error(e); process.exit(1); });
