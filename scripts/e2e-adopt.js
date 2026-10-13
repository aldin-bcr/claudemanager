'use strict';
// Test ISOLE (faux dossier personnel, faux processus, aucun jeton) : rattacher une session a l'equipe (bouton et demande),
// renommer, retirer, disposition de la liste, et la fermeture de l'appli qui n'arrete JAMAIS une session rattachee.
// Usage : HOME=<faux dossier> npx electron scripts/e2e-adopt.js --no-sandbox <dossier_sortie>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const HOME = os.homedir();
if (!HOME.endsWith('fakehome')) { console.error('refus : HOME doit etre un faux dossier personnel (…/fakehome)'); process.exit(2); }
const out = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());

// ---------- fabrication des donnees ----------
fs.rmSync(HOME, { recursive: true, force: true });
const uid = () => crypto.randomUUID();
const ids = { W1: uid(), W2: uid(), O1: uid(), O2: uid(), L1: uid(), L2: uid() };
const now = Date.now();
function fakeSession(id, dirName, title, custom, minutesAgo) {
  const cwd = path.join(HOME, 'projets', dirName);
  fs.mkdirSync(cwd, { recursive: true });
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(HOME, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(now - m * 60000).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Bonjour, peux-tu m\'aider ?' }, cwd, sessionId: id, timestamp: t(minutesAgo + 2) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Oui, avec plaisir.' }] }, cwd, sessionId: id, timestamp: t(minutesAgo) },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  if (custom) lines.push({ type: 'custom-title', customTitle: custom, sessionId: id });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return cwd;
}
const cwdOf = {};
cwdOf.W1 = fakeSession(ids.W1, 'recherche', 'Analyse comparative très détaillée des offres de stage en ingénierie logicielle', null, 5);
cwdOf.W2 = fakeSession(ids.W2, 'api', 'Correction du bug de pagination', null, 20);
cwdOf.O1 = fakeSession(ids.O1, 'notes', 'Titre automatique ignoré', 'mon-nom-claude', 40);
cwdOf.O2 = fakeSession(ids.O2, 'site', 'Refonte de la page d\'accueil du portfolio', null, 60);
cwdOf.L1 = fakeSession(ids.L1, 'appli', 'Développement de l\'application Claude Sessions', null, 1);
cwdOf.L2 = fakeSession(ids.L2, 'gamma', 'Travail du worker gamma', null, 2);

// faux processus "claude" ouverts (visibles comme sessions vivantes)
const procs = {};
function fakeLive(key, name) {
  const p = spawn('bash', ['-c', 'sleep 200; true', 'claude-fake-' + key], { stdio: 'ignore', detached: true });
  p.unref();
  procs[key] = p.pid;
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', p.pid + '.json'), JSON.stringify({ pid: p.pid, sessionId: ids[key], cwd: cwdOf[key], name, status: 'idle', kind: 'interactive', updatedAt: Date.now() }));
}
fakeLive('L1', 'home-ubuntu-ff');
fakeLive('L2', 'gamma-live');
fs.writeFileSync(path.join(HOME, 'pids.json'), JSON.stringify({ ids, procs }));

const spec = (name, key, extra = {}) => ({ kind: 'worker', name, managerName: 'manager', cwd: cwdOf[key], role: '', task: '', mode: 'acceptEdits', createdAt: new Date().toISOString(), ...extra });
fs.mkdirSync(path.join(HOME, '.config', 'claude-sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.config', 'claude-sessions', 'meta.json'), JSON.stringify({
  colors: {}, titles: {}, templates: [], managerName: 'manager', manager: null, reopen: [],
  queues: { [ids.W1]: [{ qid: 'q1', text: "Postule à l'offre n°3 : ingénieur données", from: 'rule', at: new Date().toISOString() }, { qid: 'q2', text: 'Relance : fais le point en 3 lignes', from: 'user', urgent: true, at: new Date().toISOString() }] },
  specs: { [ids.W1]: spec('alpha-recherche-documentaire', 'W1'), [ids.W2]: spec('beta', 'W2'), [ids.L2]: spec('gamma-live', 'L2') },
  settings: { teamMode: 'acceptEdits', autostart: false, maxWorkers: 0, managerModel: '', closeWorkersOnQuit: true },
}));

// ---------- scenario ----------
const { app, BrowserWindow } = require('electron');
require('../main.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (n) => fs.writeFileSync(path.join(out, n), (await win.webContents.capturePage()).toPNG());
  const res = {};
  const cfg = path.join(HOME, '.config', 'claude-sessions');
  const registry = () => JSON.parse(fs.readFileSync(path.join(cfg, 'registry.json'), 'utf8')).sessions;
  const row = (id) => `document.querySelector('.row[data-id="${id}"]')`;
  const err = (pre) => js(`document.getElementById('${pre}-error').hidden ? '' : document.getElementById('${pre}-error').textContent`);
  const pick = async (id) => { await js(`${row(id)}.click()`); await wait(700); };

  res.customTitle = await js(`${row(ids.O1)}.querySelector('.title').textContent`);
  res.disposition = await js(`(() => { const r = ${row(ids.W1)}; return { nom: r.querySelector('.title').textContent, badges: [...r.querySelectorAll('.badges .badge')].map(b => b.textContent), titre: r.querySelector('.sub2').textContent.slice(0, 30), cote_a_cote: r.querySelector('.title .badge') !== null }; })()`);
  await shot('a1-liste.png');

  // 1. bouton "Ajouter a l'equipe" (session fermee)
  await pick(ids.O2);
  res.boutonVisible = await js(`!document.getElementById('btn-adopt').hidden && document.getElementById('btn-leave').hidden`);
  await js(`document.getElementById('btn-adopt').click()`); await wait(400);
  res.nomPropose = await js(`document.getElementById('ad-name').value`);
  await shot('a2-dialogue.png');
  await js(`document.getElementById('adopt-form').requestSubmit()`); await wait(1500);
  res.apresAdopt = await js(`[...${row(ids.O2)}.querySelectorAll('.badges .badge')].map(b => b.textContent)`);
  res.registreO2 = registry().find(s => s.id === ids.O2);

  // 2. nom deja pris
  await pick(ids.O1);
  await js(`document.getElementById('btn-adopt').click()`); await wait(300);
  await js(`document.getElementById('ad-name').value = 'BETA'; document.getElementById('adopt-form').requestSubmit()`); await wait(900);
  res.doublon = await err('ad');
  await js(`document.getElementById('adopt-dialog').close()`);

  // 3. rattacher une session OUVERTE par une demande (comme le fait le manager)
  const reqDir = path.join(cfg, 'requests'), respDir = path.join(cfg, 'responses');
  fs.writeFileSync(path.join(reqDir, 'adopt-l1.json'), JSON.stringify({ action: 'adopt', id: ids.L1, name: 'dev-appli', role: 'Développeur de l\'application' }));
  for (let i = 0; i < 20 && !fs.existsSync(path.join(respDir, 'adopt-l1.json')); i++) await wait(500);
  res.reponse = JSON.parse(fs.readFileSync(path.join(respDir, 'adopt-l1.json'), 'utf8'));
  await wait(2500);
  const l1 = registry().find(s => s.id === ids.L1);
  res.registreL1 = { name: l1.name, address: l1.address, adopted: l1.adopted, status: l1.status };

  // 4. renommer : worker ouvert normal = refuse ; session rattachee ouverte = accepte (simple etiquette)
  res.renameOuvert = await (async () => { await pick(ids.L2); await js(`document.getElementById('btn-rename').click()`); await wait(300); await js(`document.getElementById('rn-name').value = 'delta'; document.getElementById('rename-form').requestSubmit()`); await wait(900); const e = await err('rn'); await js(`document.getElementById('rename-dialog').close()`); return e; })();
  res.renameRattache = await (async () => { await pick(ids.L1); await js(`document.getElementById('btn-rename').click()`); await wait(300); await js(`document.getElementById('rn-name').value = 'dev-appli-2'; document.getElementById('rename-form').requestSubmit()`); await wait(1200); return (await err('rn')) || 'ok'; })();
  res.nomApres = await js(`${row(ids.L1)}.querySelector('.title').textContent`);

  // 5. retirer de l'equipe
  await pick(ids.O2);
  res.leaveVisible = await js(`!document.getElementById('btn-leave').hidden`);
  await js(`document.getElementById('btn-leave').click()`); await wait(1500);
  res.apresLeave = await js(`${row(ids.O2)}.querySelector('.badges') === null`);
  await shot('a3-final.png');

  // captures des deux themes (file d'attente, alerte, options, autorisations, planificateur)
  await pick(ids.W1);
  await js(`state.perms.alerts = [{ aid: 'a1b2c3', kind: 'prompt', agentId: '${ids.W1}', agent: 'alpha-recherche-documentaire', tool: 'Bash', detail: 'git status && ls -la', reason: 'Liste les fichiers', at: new Date().toISOString() }, { aid: 'd4e5f6', kind: 'denied', agentId: '${ids.W2}', agent: 'beta', tool: 'Write', detail: 'rapport.xlsx', reason: 'External System Writes', at: new Date().toISOString() }]; renderPermBanner(); renderList(); renderManagerCard(); updateHead();`);
  await wait(600);
  for (const th of ['dark', 'light']) {
    await js(`localStorage.setItem('theme', '${th}'); applyTheme();`); await wait(400);
    await shot(`th-${th}-chat.png`);
    await js(`document.getElementById('btn-cli').click()`); await wait(1200); await shot(`th-${th}-options.png`); await js(`document.getElementById('cli-dialog').close()`);
    await js(`document.getElementById('mc-perms').click()`); await wait(500); await shot(`th-${th}-perms.png`); await js(`document.getElementById('perm-dialog').close()`);
    await js(`document.getElementById('mc-tick').click()`); await wait(700); await shot(`th-${th}-tick.png`); await js(`document.getElementById('tick-dialog').close()`);
  }
  console.log(JSON.stringify(res, null, 1));
  app.quit(); // closeWorkersOnQuit = true : le worker normal (gamma-live) doit etre ferme, JAMAIS la session rattachee (dev-appli)
});
