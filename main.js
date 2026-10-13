'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./src/sessions');
const transcript = require('./src/transcript');
const launch = require('./src/launch');
const reply = require('./src/reply');
const team = require('./src/team');
const manager = require('./src/manager');
const requests = require('./src/requests');
const { Agent } = require('./src/agent');
const cliopts = require('./src/cliopts');
const rules = require('./src/rules');

// Le helper SUID de Chromium n'est pas installe pour une appli empaquetee (AppImage / npm). L'appli ne
// charge que ses fichiers locaux (CSP "default-src 'none'") : on desactive donc le sandbox Chromium.
app.commandLine.appendSwitch('no-sandbox');
// Meme dossier de donnees en developpement et en version compilee (sinon couleurs et roles seraient separes).
app.setPath('userData', path.join(app.getPath('appData'), 'claude-sessions'));

// Une seule appli a la fois : deux instances lanceraient deux managers.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let stopFollow = null;
let liveTimer = null;
let stopRequests = null;
// Preferences : couleur par session, role/tache des sessions d'equipe, modeles de role, reglages, manager.
let meta = { colors: {}, specs: {}, templates: [], managerName: team.DEFAULT_MANAGER_NAME, settings: { ...team.DEFAULT_SETTINGS }, manager: null, reopen: [], titles: {}, efforts: {}, rules: [], rulesPaused: false, queues: {}, grants: [], options: {}, tick: { count: 0, lastAt: null, noop: 0, sig: '' } };

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const UUID_RE = sessions.UUID_RE;

function metaFile() { return path.join(app.getPath('userData'), 'meta.json'); }
// Fichier lu par le manager : etat de toutes les sessions de l'equipe.
function registryFile() { return path.join(app.getPath('userData'), 'registry.json'); }
function managerDir() { return path.join(app.getPath('userData'), 'manager'); }
function hookFile() { return path.join(app.getPath('userData'), 'hooks', 'only-manager.py'); }
function ctx() { return { registryPath: registryFile(), hookPath: hookFile(), maxWorkers: meta.settings.maxWorkers }; }

function loadMeta() {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    if (m && typeof m === 'object') {
      meta = {
        colors: m.colors && typeof m.colors === 'object' ? m.colors : {},
        specs: m.specs && typeof m.specs === 'object' ? m.specs : {},
        templates: Array.isArray(m.templates) ? m.templates : [],
        managerName: typeof m.managerName === 'string' && team.NAME_RE.test(m.managerName) ? m.managerName : team.DEFAULT_MANAGER_NAME,
        settings: team.normalizeSettings(m.settings),
        titles: m.titles && typeof m.titles === 'object' ? m.titles : {}, // noms d'affichage des sessions ordinaires
        // Regles « SI ... ALORS ... » entre agents (voir src/rules.js) ; rulesPaused = pause globale.
        rules: Array.isArray(m.rules) ? m.rules.filter(r => r && typeof r.id === 'string' && r.agent && r.trigger && r.action).map(r => ({ ...r, count: Number.isInteger(r.count) ? r.count : 0 })) : [],
        rulesPaused: !!m.rulesPaused,
        // File d'attente de messages par agent (FIFO), autorisations permanentes, options de la CLI activees/desactivees par session.
        queues: Object.fromEntries(Object.entries(m.queues && typeof m.queues === 'object' ? m.queues : {}).filter(([k, v]) => UUID_RE.test(k) && Array.isArray(v)).map(([k, v]) => [k, v.filter(x => x && typeof x.text === 'string' && typeof x.qid === 'string')])),
        grants: Array.isArray(m.grants) ? m.grants.filter(g => g && g.gid && UUID_RE.test(String(g.agentId)) && g.tool && g.scope === 'always') : [],
        options: m.options && typeof m.options === 'object' ? m.options : {},
        tick: { count: 0, lastAt: null, noop: 0, sig: '', ...(m.tick && typeof m.tick === 'object' ? m.tick : {}) },
        // Effort de reflexion choisi par session : id -> low|medium|high|xhigh|max (absent = celui par defaut).
        efforts: Object.fromEntries(Object.entries(m.efforts && typeof m.efforts === 'object' ? m.efforts : {}).filter(([k, v]) => UUID_RE.test(k) && team.EFFORTS.includes(v))),
        manager: m.manager && typeof m.manager.id === 'string' && UUID_RE.test(m.manager.id) ? { id: m.manager.id } : null,
        // Workers ouverts quand l'appli a ete fermee, a rouvrir au prochain demarrage : [{ id, busy }].
        reopen: Array.isArray(m.reopen) ? m.reopen.filter(r => r && typeof r.id === 'string' && UUID_RE.test(r.id)).map(r => ({ id: r.id, busy: !!r.busy })) : [],
      };
    }
  } catch { /* premiere utilisation */ }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function saveMeta() { writeAtomic(metaFile(), JSON.stringify(meta)); }

// Le controle qui limite les workers a ecrire au manager (applique par Claude Code, meme sans confirmations).
function writeHook() {
  try {
    if (fs.readFileSync(hookFile(), 'utf8') === team.ONLY_MANAGER_HOOK) return;
  } catch { /* a creer */ }
  writeAtomic(hookFile(), team.ONLY_MANAGER_HOOK);
}

let lastRegistry = '';
function refreshRegistry(force) {
  const reg = team.buildRegistry({
    specs: meta.specs,
    sessions: sessions.listSessions(),
    live: sessions.liveSessions(),
    managerName: meta.managerName,
  });
  const body = JSON.stringify(reg, null, 2);
  if (!force && body === lastRegistry) return; // rien n'a change : pas d'ecriture inutile
  lastRegistry = body;
  writeAtomic(registryFile(), JSON.stringify({ updatedAt: new Date().toISOString(), ...reg }, null, 2));
}

// Options de la CLI propres a une session d'equipe (nom, role, permissions), ou null pour une session ordinaire.
// Le manager a TOUS les droits (bypass) ; un worker suit le mode de l'equipe sauf si son mode a ete impose a la creation.
// On resynchronise a chaque lancement ou reprise.
function flagsFor(id) {
  const spec = meta.specs[id];
  if (!spec) return null;
  if (spec.kind === 'manager') spec.mode = 'bypass';
  else if (!spec.modePinned) spec.mode = meta.settings.teamMode;
  return finalFlags(id, team.sessionFlags({ ...spec, effort: effortFor(id) }, ctx()));
}

// Options qu'on ne peut pas modifier : elles font marcher l'appli (entrees/sorties, identite, controle des workers, prompts).
const LOCKED_FLAGS = new Set(['-p', '--print', '--input-format', '--output-format', '--verbose', '--session-id', '-r', '--resume', '-c', '--continue', '-n', '--name', '--settings', '--append-system-prompt', '--system-prompt', '--system-prompt-file', '--append-system-prompt-file', '--permission-prompt-tool', '--permission-prompts', '--add-dir', '--effort', '--fork-session']);
// Options sensibles : confirmation native et journal a chaque changement.
const SENSITIVE_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode']);

// --chrome par defaut, puis les options que l'utilisateur a desactivees (retirees) ou activees (ajoutees) pour cette session.
function finalFlags(id, flags) {
  const o = meta.options[id] || { on: {}, off: [] };
  let out = ['--chrome', ...flags];
  for (const f of o.off || []) {
    const i = out.indexOf(f);
    if (i < 0) continue;
    const takes = cliopts.takesValue(f);
    out.splice(i, takes && out[i + 1] && !out[i + 1].startsWith('-') ? 2 : 1);
  }
  for (const [f, v] of Object.entries(o.on || {})) { if (!out.includes(f)) out.push(f, ...(v === true ? [] : [String(v)])); }
  return out;
}

// Effort de reflexion d'une session : son choix, sinon le defaut du manager ou des workers, sinon celui de Claude Code ('').
function effortFor(id) {
  const own = meta.efforts[id];
  if (own && team.EFFORTS.includes(own)) return own;
  if (id === managerId()) return meta.settings.managerEffort || '';
  return meta.specs[id] ? (meta.settings.workerEffort || '') : '';
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function closeTranscript() {
  if (stopFollow) stopFollow();
  stopFollow = null;
}

// ---------- le manager ----------

let externalManager = null; // un manager deja ouvert ailleurs (autre terminal) : on ne lance pas de doublon

function managerId() { return meta.manager && meta.manager.id; }

function managerInfo() {
  return { id: managerId(), name: meta.managerName, cwd: managerDir(), external: externalManager, ...manager.status() };
}

function ensureManagerSpec() {
  let id = managerId();
  if (!id) { id = crypto.randomUUID(); meta.manager = { id }; }
  const prev = meta.specs[id];
  meta.specs[id] = {
    kind: 'manager', name: meta.managerName, managerName: meta.managerName, cwd: managerDir(), role: team.MANAGER_ROLE,
    task: '', mode: 'bypass', model: meta.settings.managerModel,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  };
  saveMeta();
  return { id, spec: meta.specs[id] };
}

function startManager() {
  fs.mkdirSync(managerDir(), { recursive: true });
  const live = sessions.liveSessions();
  const mine = managerId();
  const other = Object.entries(live).find(([id, l]) => String(l.name || '').toLowerCase() === meta.managerName.toLowerCase() && id !== mine);
  externalManager = other ? { id: other[0], pid: other[1].pid } : null;
  if (externalManager || (mine && live[mine])) { send('manager:state', managerInfo()); return; }
  const { id, spec } = ensureManagerSpec();
  manager.start(
    { id, cwd: managerDir(), flags: finalFlags(id, team.sessionFlags({ ...spec, effort: effortFor(id) }, ctx())), resume: !!sessions.findSessionFile(id), onPermission: (req) => onPermission(id, req) },
    () => send('manager:state', managerInfo()),
  );
  watchSession(id);
  send('manager:state', managerInfo());
}

// ---------- les agents de l'equipe : des sessions EN ARRIERE-PLAN, jamais de terminal ----------

const agents = new Map(); // id de session -> Agent (workers et sessions simples demarres par l'appli)

function agentsInfo() {
  const o = {};
  for (const [id, a] of agents) o[id] = a.status();
  return o;
}

// Demarre (ou reprend) la session d'equipe `id` en arriere-plan. `message` = premier message envoye a son demarrage.
function startAgent(id, message) {
  const spec = meta.specs[id];
  if (!spec || spec.kind === 'manager') throw new Error("Cette session ne fait pas partie de l'équipe");
  const old = agents.get(id);
  if (old && old.status().running) return old.status();
  const a = new Agent({
    id, cwd: spec.cwd, flags: flagsFor(id), resume: !!sessions.findSessionFile(id), firstMessage: message || '',
    onPermission: (req) => onPermission(id, req),
    onChange: (st) => {
      send('agents:state', agentsInfo());
      if (!st.running) dropPendingPerms(id);
      if (st.error && st.error !== a.lastError) fireRules({ type: 'error', agent: meta.specs[id] ? meta.specs[id].name : id, message: st.error });
      a.lastError = st.error;
    },
  });
  agents.set(id, a);
  const st = a.start();
  watchSession(id);
  send('agents:state', agentsInfo());
  return st;
}

// Envoie un message a une session d'equipe : si elle n'est pas demarree, ce message la demarre.
function sendToAgent(id, text, opts) {
  const spec = meta.specs[id];
  if (!spec || spec.kind === 'manager') throw new Error("Cette session ne fait pas partie de l'équipe");
  const a = agents.get(id);
  if (a && a.status().running) return { sent: true, ...submit(id, text, opts) };
  const live = sessions.liveSessions()[id];
  if (live) throw new Error(`Cette session est ouverte ailleurs (pid ${live.pid}) : réponds-y directement.`);
  if (spec.kind === 'worker') checkCapacity();
  const st = startAgent(id, String(text));
  if (!st.running) throw new Error(st.error || 'Démarrage impossible');
  return { sent: true, started: true };
}

// ---------- creation de sessions d'equipe (formulaire ou demande du manager) ----------

function usedNames() {
  return new Set([
    ...Object.values(meta.specs).map(s => s.name.toLowerCase()),
    ...Object.values(sessions.liveSessions()).map(l => String(l.name || '').toLowerCase()),
  ]);
}

function openWorkerCount() {
  const live = sessions.liveSessions();
  const now = Date.now();
  return Object.entries(meta.specs).filter(([id, s]) =>
    s.kind === 'worker' && (live[id] || (now - Date.parse(s.createdAt) < 90000 && !sessions.findSessionFile(id)))).length;
}

function checkCapacity() {
  if (meta.settings.maxWorkers > 0 && openWorkerCount() >= meta.settings.maxWorkers) {
    throw new Error(`Limite atteinte : ${meta.settings.maxWorkers} workers ouverts en même temps (réglable dans les réglages de l'équipe)`);
  }
}

// Enregistre la session puis la demarre en arriere-plan (aucune fenetre). Rien n'est garde si le demarrage echoue.
function launchNewSession(spec, effort) {
  const id = crypto.randomUUID();
  meta.specs[id] = { ...spec, createdAt: new Date().toISOString() };
  if (team.EFFORTS.includes(effort)) meta.efforts[id] = effort;
  saveMeta();
  const st = startAgent(id, spec.task);
  if (!st.running) {
    agents.delete(id);
    delete meta.specs[id];
    delete meta.efforts[id];
    saveMeta();
    throw new Error(st.error || 'Démarrage impossible');
  }
  refreshRegistry(true);
  return { id, name: spec.name };
}

// Rattache une session EXISTANTE a l'equipe (comme worker). Si elle est deja ouverte, ses options de lancement (nom, prompt,
// controle des workers) ne peuvent plus changer : elles s'appliqueront a sa prochaine ouverture. Tant qu'elle tourne dans un
// terminal de l'utilisateur, l'appli ne la ferme jamais ; une fois fermee, elle est demarree en arriere-plan comme les autres.
function adoptSession({ id, name, role }) {
  if (!UUID_RE.test(id)) throw new Error('Identifiant de session invalide');
  if (id === managerId()) throw new Error("Le manager fait déjà partie de l'équipe");
  if (meta.specs[id]) throw new Error("Cette session fait déjà partie de l'équipe");
  const info = sessions.listSessions().find(s => s.id === id);
  if (!info) throw new Error('Session introuvable');
  const live = sessions.liveSessions();
  const taken = new Set([
    ...Object.values(meta.specs).map(s => s.name.toLowerCase()),
    ...Object.entries(live).filter(([k]) => k !== id).map(([, l]) => String(l.name || '').toLowerCase()),
  ]);
  const spec = team.validateSpec(
    { kind: 'worker', name, cwd: info.cwd, role, task: '', managerName: meta.managerName, mode: meta.settings.teamMode },
    taken,
  );
  checkCapacity();
  meta.specs[id] = { ...spec, createdAt: new Date().toISOString(), adopted: true };
  saveMeta();
  refreshRegistry(true);
  const address = live[id] && live[id].name ? live[id].name : spec.name;
  if (manager.status().running) {
    toManager(team.adoptMessage(spec, address));
  }
  send('team:event', { text: `« ${spec.name} » a rejoint l'équipe` });
  return { id, name: spec.name, address };
}

async function handleManagerRequest(raw) {
  const r = team.checkRequest(raw);
  if (r.action === 'grant') return grantByManager(String(r.alert), r.scope || 'once');
  if (r.action === 'rules') {
    if (r.op === 'pause_all') meta.rulesPaused = true;
    else if (r.op === 'resume_all') meta.rulesPaused = false;
    else {
      const rule = meta.rules[Number(r.name) - 1];
      if (!rule) throw new Error(`Aucune règle numéro ${r.name}`);
      rule.enabled = false;
    }
    saveMeta();
    send('rules:changed', null);
    return { ok: true, action: 'rules', op: r.op, paused: meta.rulesPaused };
  }
  if (r.action === 'adopt') {
    const out = adoptSession({ id: String(r.id), name: r.name, role: r.role });
    return { ok: true, action: 'adopt', ...out, message: "Session rattachée à l'équipe." };
  }
  if (r.action === 'create') {
    // Le manager cree toujours des workers ; il peut choisir leur mode (sinon : celui de l'equipe).
    if (r.mode != null && !team.MODES[r.mode]) throw new Error('mode inconnu (attendu : standard, acceptEdits, auto ou bypass)');
    const spec = team.validateSpec(
      { kind: 'worker', name: r.name, cwd: r.cwd, role: r.role, task: r.task, managerName: meta.managerName, mode: r.mode || meta.settings.teamMode },
      usedNames(),
    );
    if (r.effort != null && !team.EFFORTS.includes(r.effort)) throw new Error('effort inconnu (attendu : low, medium, high, xhigh ou max)');
    spec.modePinned = !!r.mode;
    checkCapacity();
    const out = launchNewSession(spec, r.effort);
    send('team:event', { text: `Le manager a ouvert le worker « ${spec.name} »` });
    return { ok: true, action: 'create', name: out.name, id: out.id, message: "Worker démarré en arrière-plan (aucune fenêtre) ; il t'écrira à son démarrage." };
  }
  const found = Object.entries(meta.specs).find(([, s]) => s.kind === 'worker' && s.name.toLowerCase() === r.name.trim().toLowerCase());
  if (!found) throw new Error(`Aucun worker nommé « ${r.name} »`);
  const [id, spec] = found;
  const running = agents.get(id) && agents.get(id).status().running;
  if (running || sessions.liveSessions()[id]) return { ok: true, action: 'resume', name: spec.name, message: 'Ce worker est déjà ouvert.' };
  if (!sessions.findSessionFile(id)) throw new Error(`Le worker « ${spec.name} » n'a jamais démarré : crée-le avec "create"`);
  checkCapacity();
  const st = startAgent(id);
  if (!st.running) throw new Error(st.error || 'Démarrage impossible');
  send('team:event', { text: `Le manager a rouvert le worker « ${spec.name} »` });
  return { ok: true, action: 'resume', name: spec.name, message: 'Worker rouvert en arrière-plan.' };
}

// ---------- fenetre ----------

function createWindow() {
  clearInterval(liveTimer); // pas de doublon si la fenetre est recreee apres une fermeture annulee
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'claudemanager',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // le preload n'utilise que ipcRenderer ; le sandbox Chromium est gere par --no-sandbox
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; closeTranscript(); });

  // Etat live pousse toutes les 2 s (fichiers ~/.claude/sessions/<pid>.json) ; le registre suit.
  liveTimer = setInterval(() => {
    send('live:update', sessions.liveSessions());
    applyPendingEfforts();
    detectIdle();
    drainQueues();
    tickLoop();
    try { refreshRegistry(false); } catch { /* ecriture impossible : on reessaiera */ }
  }, 2000);
}

function templates() { return [...team.BUILTIN_TEMPLATES, ...meta.templates]; }

ipcMain.handle('sessions:list', () => ({
  sessions: sessions.listSessions(),
  live: sessions.liveSessions(),
  colors: meta.colors,
  titles: meta.titles,
  efforts: meta.efforts,
  queues: meta.queues,
  specs: meta.specs,
  templates: templates(),
  managerName: meta.managerName,
  manager: managerInfo(),
  settings: meta.settings,
  registryPath: registryFile(),
  replying: reply.runningIds(),
  agents: agentsInfo(),
  home: os.homedir(),
}));

ipcMain.handle('transcript:open', (_e, rawId) => {
  closeTranscript();
  const id = String(rawId);
  const follow = (file, offset) => transcript.follow(file, offset, (news) => send('transcript:append', { id, items: news }));
  const file = sessions.findSessionFile(id);
  if (!file) {
    if (id !== managerId()) throw new Error('Session introuvable');
    // Le manager n'a pas de transcription avant son premier message : on attend qu'elle apparaisse.
    const t = setInterval(() => {
      const f = sessions.findSessionFile(id);
      if (!f) return;
      clearInterval(t);
      const r = transcript.readAll(f);
      if (r.items.length) send('transcript:append', { id, items: r.items });
      stopFollow = follow(f, r.offset);
    }, 1000);
    stopFollow = () => clearInterval(t);
    return { id, items: [] };
  }
  const { items, offset } = transcript.readAll(file);
  stopFollow = follow(file, offset);
  return { id, items };
});

ipcMain.handle('transcript:close', () => { closeTranscript(); });

// ---- agents : ecrire a une session d'equipe (la demarre au besoin), l'arreter ----
ipcMain.handle('agent:send', (_e, rawId, text, opts) => sendToAgent(String(rawId), text, { from: 'user', urgent: !!(opts && opts.urgent) }));
ipcMain.handle('agent:stop', async (_e, rawId) => {
  const a = agents.get(String(rawId));
  if (a) await a.stop();
  send('agents:state', agentsInfo());
  return agentsInfo();
});

ipcMain.handle('dialog:chooseDir', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Dossier de la session',
    defaultPath: defaultPath ? String(defaultPath) : os.homedir(),
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// ---- manager : demarrer, arreter, lui ecrire, reglages ----

ipcMain.handle('manager:send', (_e, text, opts) => {
  if (externalManager) throw new Error(`Le manager est ouvert dans un terminal (pid ${externalManager.pid}) : écris-lui là-bas.`);
  return { sent: true, ...submit(managerId(), text, { from: 'user', urgent: !!(opts && opts.urgent) }) };
});
ipcMain.handle('manager:start', () => { manager.resetCrashes(); startManager(); return managerInfo(); });
ipcMain.handle('manager:stop', async () => { await manager.stop(); return managerInfo(); });
ipcMain.handle('manager:restart', async () => { await manager.stop(); manager.resetCrashes(); startManager(); return managerInfo(); });

ipcMain.handle('settings:set', (_e, raw) => {
  const before = meta.settings;
  meta.settings = team.normalizeSettings({ ...meta.settings, ...raw }); // un champ absent garde sa valeur
  saveMeta();
  const needsRestart = manager.status().running && before.managerModel !== meta.settings.managerModel;
  return { settings: meta.settings, needsRestart };
});

// ---- sessions d'equipe : formulaire ----

ipcMain.handle('team:create', (_e, raw) => {
  if (!raw || typeof raw !== 'object') throw new Error('Formulaire invalide');
  const isWorker = raw.kind === 'worker';
  // Aucun terminal : toute session creee ici tourne en arriere-plan, avec le mode de l'equipe.
  const spec = team.validateSpec(
    { ...raw, managerName: meta.managerName, mode: meta.settings.teamMode },
    usedNames(),
  );
  if (isWorker) checkCapacity();
  if (raw.effort && !team.EFFORTS.includes(raw.effort)) throw new Error('Effort inconnu');
  return launchNewSession(spec, raw.effort);
});

ipcMain.handle('team:adopt', (_e, opts) => adoptSession({ id: String(opts && opts.id), name: String((opts && opts.name) || ''), role: opts && opts.role }));

// Retire de l'equipe une session RATTACHEE (elle redevient une session ordinaire).
ipcMain.handle('team:leave', (_e, rawId) => {
  const id = String(rawId);
  const spec = meta.specs[id];
  if (!spec || !spec.adopted) throw new Error("Seules les sessions rattachées à l'équipe peuvent en être retirées.");
  delete meta.specs[id];
  saveMeta();
  refreshRegistry(true);
  return { specs: meta.specs };
});

ipcMain.handle('team:saveTemplate', (_e, name, role) => {
  name = String(name || '').trim();
  role = String(role || '').trim();
  if (!name || name.length > 60) throw new Error('Nom de modèle invalide (1 à 60 caractères)');
  if (!role || role.length > 20000) throw new Error('Le rôle du modèle est vide ou trop long');
  if (team.BUILTIN_TEMPLATES.some(t => t.name === name)) throw new Error('Ce nom est réservé à un modèle fourni');
  meta.templates = [...meta.templates.filter(t => t.name !== name), { name, role }];
  saveMeta();
  return templates();
});

ipcMain.handle('team:deleteTemplate', (_e, name) => {
  meta.templates = meta.templates.filter(t => t.name !== String(name));
  saveMeta();
  return templates();
});

// ---- repondre depuis l'appli ----

ipcMain.handle('reply:send', (_e, opts) => {
  const id = String(opts.id);
  if (id === managerId()) throw new Error('Pour parler au manager, utilise sa zone de message.');
  if (meta.specs[id]) return sendToAgent(id, opts.text, { from: 'user' });
  const live = sessions.liveSessions()[id];
  if (live && !reply.isRunning(id)) {
    // Deux processus qui ecrivent dans la meme transcription la corrompraient.
    throw new Error(`Cette session est ouverte dans un terminal (pid ${live.pid}) : reponds-y directement.`);
  }
  reply.send(
    { id, cwd: String(opts.cwd || ''), text: opts.text, skipPermissions: !!opts.skipPermissions, flags: flagsFor(id), effort: meta.efforts[id] },
    (result) => send('reply:done', result),
  );
  send('reply:state', { id, running: true });
  return { started: true };
});

ipcMain.handle('reply:stop', (_e, id) => { reply.stop(String(id)); });

// ---- renommer ----

ipcMain.handle('session:rename', async (_e, rawId, rawName) => {
  const id = String(rawId);
  const name = String(rawName == null ? '' : rawName).trim();
  if (!UUID_RE.test(id)) throw new Error('Identifiant de session invalide');
  const result = () => ({ titles: meta.titles, specs: meta.specs, managerName: meta.managerName });
  const spec = meta.specs[id];

  if (!spec) {
    // Session ordinaire : simple nom d'affichage dans l'appli (on n'ecrit jamais dans la transcription de Claude Code).
    if (!sessions.findSessionFile(id)) throw new Error('Session introuvable');
    if (name.length > 80) throw new Error('Nom trop long (80 caractères maximum)');
    if (name) meta.titles[id] = name; else delete meta.titles[id];
    saveMeta();
    return result();
  }

  // Session d'equipe : son nom est son ADRESSE pour les autres sessions, et il est fixe a l'ouverture.
  team.checkName(name, 'Nom');
  if (name === spec.name) return result();
  const live = sessions.liveSessions();
  const taken = new Set([
    ...Object.entries(meta.specs).filter(([k]) => k !== id).map(([, s]) => s.name.toLowerCase()),
    ...Object.entries(live).filter(([k]) => k !== id).map(([, l]) => String(l.name || '').toLowerCase()),
  ]);
  if (taken.has(name.toLowerCase())) throw new Error(`Le nom « ${name} » est déjà utilisé`);

  const isManager = id === managerId();
  if (isManager) {
    if (externalManager) throw new Error('Le manager est ouvert dans un terminal : ferme-le avant de le renommer.');
    if (runningWorkers().length) throw new Error("Des workers sont ouverts et connaissent l'ancien nom du manager : ferme-les d'abord.");
    await manager.stop();
    meta.managerName = name;
    for (const s of Object.values(meta.specs)) if (s.kind === 'worker') s.managerName = name; // ils l'apprendront a leur prochaine ouverture
    ensureManagerSpec();
  } else {
    const ag = agents.get(id);
    const open = ag && ag.status().running ? { pid: ag.status().pid } : live[id]; // l'agent peut tourner avant que son fichier de session n'apparaisse
    if (open && !spec.adopted) throw new Error(`Cette session est ouverte (pid ${open.pid}) : ferme-la d'abord, son nom est fixé à l'ouverture.`);
    spec.name = name;
  }
  saveMeta();
  refreshRegistry(true);
  if (isManager) { manager.resetCrashes(); startManager(); }
  return result();
});

// ---- options de la CLI : lues depuis `claude --help`, etat = ce qui est vraiment passe a cette session ----
ipcMain.handle('cli:options', async (_e, rawId) => {
  const id = String(rawId);
  const data = await cliopts.loadHelp();
  let active;
  const struct = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (id === managerId()) {
    const spec = meta.specs[id] || ensureManagerSpec().spec;
    active = [...struct, ...finalFlags(id, team.sessionFlags({ ...spec, mode: 'bypass', effort: effortFor(id) }, ctx())), '--resume', id];
  } else if (meta.specs[id]) {
    active = [...struct, ...flagsFor(id), '--resume', id];
  } else {
    active = ['-p', '--chrome', ...(meta.efforts[id] ? ['--effort', meta.efforts[id]] : []), '--resume', id, '--output-format', 'json'];
  }
  const r = cliopts.withState(data, active);
  const team_ = id === managerId() || !!meta.specs[id];
  r.options = r.options.map(o => ({ ...o, locked: !team_ || o.names.some(n => LOCKED_FLAGS.has(n)), sensitive: o.names.some(n => SENSITIVE_FLAGS.has(n)) }));
  return { ...r, switchable: team_ };
});

// ---------- regles « SI ... ALORS ... » entre agents ----------
// Les agents ne passent pas par l'appli pour se parler : on lit ce qu'ils ecrivent (leurs SendMessage dans leur conversation),
// et les regles s'executent ICI, de facon deterministe, sans dependre du contexte du manager. Le manager recoit une copie.

let ruleLog = []; // 200 derniers declenchements

function pushLog(entry) {
  ruleLog.push({ t: new Date().toISOString(), ...entry });
  if (ruleLog.length > 200) ruleLog.shift();
  try { writeAtomic(path.join(app.getPath('userData'), 'rules-log.json'), JSON.stringify(ruleLog)); } catch { /* journal facultatif */ }
  send('rules:changed', null);
}

function ruleNames() { return [...new Set([...Object.values(meta.specs).map(s => s.name), meta.managerName])]; }

function idByName(name) {
  if (String(name).toLowerCase() === meta.managerName.toLowerCase()) return managerId();
  const e = Object.entries(meta.specs).find(([, s]) => s.name.toLowerCase() === String(name).toLowerCase());
  return e ? e[0] : null;
}

function deliver(toName, text) {
  const id = idByName(toName);
  if (!id) throw new Error(`destinataire introuvable : ${toName}`);
  if (id === managerId()) { submit(id, text, { from: 'rule' }); return; }
  sendToAgent(id, text, { from: 'rule' });
}

function fireRules(ev) {
  if (meta.rulesPaused) return;
  meta.rules.forEach((rule, i) => {
    if (!rules.matches(rule, ev)) return;
    const n = i + 1;
    const stop = (why) => { rule.enabled = false; saveMeta(); pushLog({ n, agent: ev.agent, result: `règle désactivée : ${why}` }); send('team:event', { text: `Règle n°${n} désactivée : ${why}` }); };
    if (rule.count >= rule.max) return stop(`maximum de ${rule.max} déclenchements atteint`);
    const to = rule.action.to;
    const text = rules.render(rule.action.template, ev, to);
    // Anti-boucle sans progres : meme message produit plusieurs fois de suite par cette regle.
    if (rule.action.type === 'send') {
      if (rule.last === text) rule.same = (rule.same || 0) + 1; else { rule.last = text; rule.same = 1; }
      if (rule.same >= rules.SAME_LIMIT) return stop(`le même message répété ${rules.SAME_LIMIT} fois (boucle sans progrès)`);
    }
    rule.count++;
    let result = 'ok';
    try {
      if (rule.action.type === 'send') {
        deliver(to, text);
        // Le hub reste informe : le manager recoit une copie et peut tout mettre en pause.
        if (to.toLowerCase() !== meta.managerName.toLowerCase()) {
          toManager(`${team.APP_MESSAGE_PREFIX} Règle n°${n} déclenchée (${rule.count}/${rule.max}) : ${ev.agent} → ${to} : ${text.slice(0, 300)}. Pour tout arrêter : {"action":"rules","op":"pause_all"} ; pour cette règle : {"action":"rules","op":"disable","name":"${n}"}.`);
        }
      } else if (rule.action.type === 'notify') {
        send('team:event', { text: rules.render(rule.action.template, ev, '') });
      } else {
        meta.rulesPaused = true;
        send('team:event', { text: `Règles en pause (règle n°${n})` });
      }
    } catch (e) { result = 'échec : ' + e.message; }
    saveMeta();
    pushLog({ n, agent: ev.agent, to: rule.action.type === 'send' ? to : '', text: text.slice(0, 200), count: `${rule.count}/${rule.max}`, result });
  });
}

// Lecture des messages ecrits par un agent (SendMessage) dans sa conversation, a partir de maintenant.
const watchers = new Map();
function nameOfSession(id) { return id === managerId() ? meta.managerName : (meta.specs[id] ? meta.specs[id].name : id); }
function watchSession(id, onlyIfExists) {
  if (watchers.has(id)) return;
  const attach = (file, fromStart) => {
    let size = 0;
    if (!fromStart) { try { size = fs.statSync(file).size; } catch { return; } }
    const recentTools = new Map();
    watchers.set(id, transcript.follow(file, size, (items) => {
      for (const it of items) {
        if (it.kind === 'tool_use') { recentTools.set(it.toolUseId, { name: it.name, summary: it.summary }); if (recentTools.size > 200) recentTools.delete(recentTools.keys().next().value); }
        if (it.kind === 'tool_result' && it.error) detectDenial(id, it, recentTools);
        if (id === managerId() && it.kind === 'assistant' && it.text) onManagerReply(it.text);
        if (it.kind === 'tool_use' && it.name === 'SendMessage' && it.sendText) fireRules({ type: 'message', agent: nameOfSession(id), to: it.sendTo, message: it.sendText });
      }
    }));
  };
  const f = sessions.findSessionFile(id);
  if (f) { attach(f, false); return; }
  if (onlyIfExists) return;
  const t = setInterval(() => { const g = sessions.findSessionFile(id); if (g) { clearInterval(t); watchers.delete(id); attach(g, true); } }, 1000);
  watchers.set(id, () => clearInterval(t));
}

// Un agent qui passe de « occupe » a « au repos » declenche les regles de type idle.
const prevBusy = new Map();
function detectIdle() {
  const live = sessions.liveSessions();
  for (const [id, l] of Object.entries(live)) {
    if (!meta.specs[id]) continue;
    const busy = l.status === 'busy';
    if (prevBusy.get(id) && !busy) {
      const info = sessions.listSessions().find(x => x.id === id);
      fireRules({ type: 'idle', agent: nameOfSession(id), message: info ? info.lastAssistant : '' });
    }
    prevBusy.set(id, busy);
  }
}

const rulesState = () => ({ rules: meta.rules, paused: meta.rulesPaused, log: ruleLog, names: ruleNames(), defaultMax: rules.DEFAULT_MAX });
ipcMain.handle('rules:get', () => rulesState());
ipcMain.handle('rules:save', (_e, raw) => {
  const clean = rules.validateRule(raw, ruleNames());
  const i = raw.id ? meta.rules.findIndex(r => r.id === raw.id) : -1;
  if (i >= 0) meta.rules[i] = { ...meta.rules[i], ...clean };
  else meta.rules.push({ id: crypto.randomUUID(), ...clean, count: 0 });
  saveMeta();
  return rulesState();
});
ipcMain.handle('rules:delete', (_e, id) => { meta.rules = meta.rules.filter(r => r.id !== String(id)); saveMeta(); return rulesState(); });
ipcMain.handle('rules:move', (_e, id, dir) => {
  const i = meta.rules.findIndex(r => r.id === String(id));
  const j = i + (dir < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < meta.rules.length) { [meta.rules[i], meta.rules[j]] = [meta.rules[j], meta.rules[i]]; saveMeta(); }
  return rulesState();
});
ipcMain.handle('rules:toggle', (_e, id, enabled) => {
  const r = meta.rules.find(x => x.id === String(id));
  if (r) { r.enabled = !!enabled; if (enabled) { r.count = 0; r.same = 0; r.last = ''; } saveMeta(); }  // reactiver = repartir de zero
  return rulesState();
});
ipcMain.handle('rules:pause', (_e, paused) => { meta.rulesPaused = !!paused; saveMeta(); return rulesState(); });
ipcMain.handle('rules:simulate', (_e, ev) => { // test d'une regle avec un message d'essai (meme chemin que les vrais messages)
  fireRules({ type: String(ev.type), agent: String(ev.agent), message: String(ev.message || '') });
  return rulesState();
});

// ---------- file d'attente de messages (une par agent, FIFO) ----------
// Un agent occupe n'est jamais interrompu : tout message (utilisateur, regle, manager, appli) attend son passage au repos.

const lastDeliver = new Map();
const RECENT_MS = Number(process.env.CM_RECENT_MS) >= 0 && process.env.CM_RECENT_MS !== undefined ? Number(process.env.CM_RECENT_MS) : 4000; // delai de grace apres une livraison
function agentRunning(id) { return id === managerId() ? manager.status().running : !!(agents.get(id) && agents.get(id).status().running); }
function isBusy(id) { const l = sessions.liveSessions()[id]; return !!l && l.status === 'busy'; }
function rawSend(id, text) {
  if (id === managerId()) { manager.send(text); return; }
  const a = agents.get(id);
  if (!a || !a.status().running) throw new Error("L'agent est arrêté");
  a.send(text);
}
function queueChanged() { saveMeta(); send('queue:changed', meta.queues); }

// urgent : livre tout de suite (Claude l'injecte a son prochain appel d'outil, sans couper son travail).
function submit(id, text, opts = {}) {
  const q = meta.queues[id] || [];
  const recent = Date.now() - (lastDeliver.get(id) || 0) < RECENT_MS; // le statut « occupe » apparait avec un leger retard
  if (!opts.urgent && agentRunning(id) && (isBusy(id) || q.length || recent)) {
    (meta.queues[id] = q).push({ qid: crypto.randomUUID(), text: String(text), from: opts.from || 'app', at: new Date().toISOString(), ...(opts.tick ? { tick: true } : {}) });
    queueChanged();
    return { queued: true, position: q.length };
  }
  rawSend(id, text);
  lastDeliver.set(id, Date.now());
  if (opts.tick) tickDelivered();
  return { queued: false };
}

function toManager(text) { if (manager.status().running) { try { submit(managerId(), text, { from: 'app' }); } catch { /* indisponible */ } } }

function drainQueues() {
  for (const [id, q] of Object.entries(meta.queues)) {
    if (!q.length || !agentRunning(id) || isBusy(id) || Date.now() - (lastDeliver.get(id) || 0) < RECENT_MS) continue;
    const i = Math.max(0, q.findIndex(x => x.urgent));
    const [item] = q.splice(i, 1);
    try { rawSend(id, item.text); lastDeliver.set(id, Date.now()); if (item.tick) tickDelivered(); } catch { q.splice(i, 0, item); }
    queueChanged();
  }
}

const findQ = (id, qid) => { const q = meta.queues[String(id)] || []; return { q, i: q.findIndex(x => x.qid === String(qid)) }; };
ipcMain.handle('queue:get', () => meta.queues);
ipcMain.handle('queue:remove', (_e, id, qid) => { const { q, i } = findQ(id, qid); if (i >= 0) { q.splice(i, 1); queueChanged(); } return meta.queues; });
ipcMain.handle('queue:move', (_e, id, qid, dir) => { const { q, i } = findQ(id, qid); const j = i + (dir < 0 ? -1 : 1); if (i >= 0 && j >= 0 && j < q.length) { [q[i], q[j]] = [q[j], q[i]]; queueChanged(); } return meta.queues; });
ipcMain.handle('queue:urgent', (_e, id, qid) => { const { q, i } = findQ(id, qid); if (i > 0) { const [it] = q.splice(i, 1); it.urgent = true; q.unshift(it); queueChanged(); } return meta.queues; });
ipcMain.handle('queue:sendNow', (_e, id, qid) => {
  const { q, i } = findQ(id, qid);
  if (i < 0) return meta.queues;
  const [it] = q.splice(i, 1);
  try { rawSend(String(id), it.text); lastDeliver.set(String(id), Date.now()); } catch (e) { q.splice(i, 0, it); queueChanged(); throw e; }
  queueChanged();
  return meta.queues;
});

// ---------- planificateur : un « tick » regulier envoye au manager ----------
// Econome : jamais empile (au plus un tick en attente), passe par la file d'attente (jamais livre a un manager occupe),
// saute si rien n'a change, se met en pause si un agent attend une decision de l'utilisateur, s'arrete seul si le manager
// repond « rien a faire » plusieurs fois de suite.

let tickNextAt = null;
let tickAwaiting = false;
let tickLog = [];

function tickLogPush(result) {
  tickLog.push({ t: new Date().toISOString(), n: meta.tick.count, result });
  if (tickLog.length > 100) tickLog.shift();
  try { writeAtomic(path.join(app.getPath('userData'), 'tick-log.json'), JSON.stringify(tickLog)); } catch { /* journal facultatif */ }
  send('tick:changed', null);
}
function tickDelivered() { tickAwaiting = true; }

function tickSignature() {
  const live = sessions.liveSessions();
  const sess = sessions.listSessions();
  const parts = Object.keys(meta.specs).sort().map((id) => {
    const s = sess.find(x => x.id === id);
    return [id, live[id] ? live[id].status : 'closed', s ? s.lastActivity : '', s ? s.lastAssistant : '', (meta.queues[id] || []).length].join('|');
  });
  return parts.join(';') + `#${alertsList().length}`;
}

function doTick(force) {
  const st = meta.settings;
  const skip = (why) => { tickLogPush('sauté : ' + why); return { skipped: why }; };
  if (!manager.status().running) return skip('le manager est arrêté');
  if (!force && meta.rulesPaused) return skip('pause globale');
  if ((meta.queues[managerId()] || []).some(x => x.tick)) return skip('un tick attend déjà dans la file');
  if (!force && st.tickPauseOnBlocked && pendingPerms.size) return skip('un agent attend une autorisation (alerte à la place)');
  const sig = tickSignature();
  const live = sessions.liveSessions();
  const idleAgent = Object.entries(meta.specs).some(([id, s]) => s.kind === 'worker' && live[id] && live[id].status !== 'busy');
  if (!force && sig === meta.tick.sig && !idleAgent) return skip("rien n'a changé et aucun agent au repos");
  const hhmm = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  meta.tick.sig = sig;
  meta.tick.count++;
  meta.tick.lastAt = new Date().toISOString();
  saveMeta();
  const r = submit(managerId(), st.tickText.replace(/\{heure\}/g, hhmm), { from: 'tick', tick: true });
  tickLogPush(r.queued ? 'envoyé (en file : le manager est occupé)' : 'envoyé');
  return { sent: true, queued: r.queued };
}

function tickLoop() {
  const st = meta.settings;
  if (!st.tickEnabled) { tickNextAt = null; return; }
  const now = Date.now();
  if (!tickNextAt) tickNextAt = now + st.tickMinutes * 60000;
  if (now >= tickNextAt) { tickNextAt = now + st.tickMinutes * 60000; doTick(false); }
}

// Reponse du manager apres un tick : « rien a faire » repete N fois = on arrete le planificateur.
function onManagerReply(text) {
  if (!tickAwaiting) return;
  tickAwaiting = false;
  if (/rien à faire/i.test(text)) meta.tick.noop++; else meta.tick.noop = 0;
  saveMeta();
  if (meta.tick.noop >= meta.settings.tickStopAfter) {
    meta.settings.tickEnabled = false;
    meta.tick.noop = 0;
    saveMeta();
    tickLogPush(`planificateur arrêté : « rien à faire » ${meta.settings.tickStopAfter} fois de suite`);
    send('team:event', { text: `Planificateur arrêté : le manager répond « rien à faire » ${meta.settings.tickStopAfter} fois de suite` });
  } else tickLogPush('réponse du manager : ' + (/rien à faire/i.test(text) ? 'rien à faire' : 'action engagée'));
}

ipcMain.handle('tick:get', () => ({ enabled: meta.settings.tickEnabled, minutes: meta.settings.tickMinutes, nextAt: tickNextAt, lastAt: meta.tick.lastAt, count: meta.tick.count, noop: meta.tick.noop, log: tickLog }));
ipcMain.handle('tick:now', () => doTick(true));

// ---------- autorisations des agents ----------
// L'agent demande une autorisation (control_request) et ATTEND la reponse de l'appli. Les refus du classificateur du mode
// automatique sont lus dans sa conversation : l'utilisateur peut alors lui donner une autorisation explicite.

const pendingPerms = new Map();   // aid -> { alert, resolve, input }
let deniedAlerts = [];            // refus du classificateur en attente de decision
const sessionGrants = [];         // autorisations « pour la session » (perdues a la fermeture de l'appli)
let permLog = [];

const shortId = () => crypto.randomBytes(3).toString('hex');
const summarizeInput = (i) => String((i && (i.command || i.file_path || i.url || i.path)) || JSON.stringify(i || {})).replace(/\s+/g, ' ').slice(0, 300);
function allGrants() { return [...meta.grants, ...sessionGrants]; }

function permLogPush(entry) {
  permLog.push({ t: new Date().toISOString(), ...entry });
  if (permLog.length > 200) permLog.shift();
  try { writeAtomic(path.join(app.getPath('userData'), 'perm-log.json'), JSON.stringify(permLog)); } catch { /* journal facultatif */ }
  send('perm:changed', null);
}

function alertsList() { return [...[...pendingPerms.values()].map(p => p.alert), ...deniedAlerts]; }

function announceAlert(alert) {
  send('perm:changed', null);
  send('team:event', { text: `Autorisation demandée par ${alert.agent} : ${alert.tool} ${alert.detail.slice(0, 80)}` });
  const can = meta.settings.managerCanGrant && alert.agentId !== managerId();
  toManager(`${team.APP_MESSAGE_PREFIX} Autorisation ${alert.kind === 'prompt' ? 'demandée' : 'refusée'} pour ${alert.agent} (id ${alert.aid}) : ${alert.tool} ${alert.detail.slice(0, 200)}${alert.reason ? ' — motif : ' + alert.reason : ''}. ` +
    (can ? `L'utilisateur t'a autorisé à accorder certaines catégories (${meta.settings.grantCategories.join(', ') || 'aucune'}) : {"action":"grant","alert":"${alert.aid}","scope":"once"}. Préviens-le.` : "Tu ne peux pas l'accorder : informe l'utilisateur, seul lui peut le faire."));
}

function onPermission(id, req) {
  const tool = req.tool_name;
  const g = allGrants().find(x => x.agentId === id && x.tool === tool);
  if (g) { permLogPush({ agent: nameOfSession(id), tool, detail: summarizeInput(req.input), result: `autorisé automatiquement (${g.scope})`, by: g.by }); return Promise.resolve({ behavior: 'allow', updatedInput: req.input }); }
  return new Promise((resolve) => {
    const alert = { aid: shortId(), kind: 'prompt', agentId: id, agent: nameOfSession(id), tool, detail: summarizeInput(req.input), reason: String(req.description || '').slice(0, 200), at: new Date().toISOString() };
    pendingPerms.set(alert.aid, { alert, resolve, input: req.input });
    announceAlert(alert);
  });
}

function dropPendingPerms(id) {
  for (const [aid, p] of [...pendingPerms]) if (p.alert.agentId === id) { pendingPerms.delete(aid); p.resolve({ behavior: 'deny', message: "L'agent a été arrêté" }); }
  send('perm:changed', null);
}

// Refus du classificateur du mode automatique, lu dans la conversation de l'agent.
const DENIAL_RE = /denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/;
function detectDenial(id, it, recentTools) {
  const m = String(it.text || '').match(DENIAL_RE);
  if (!m) return;
  const tu = recentTools.get(it.toolUseId) || {};
  const alert = { aid: shortId(), kind: 'denied', agentId: id, agent: nameOfSession(id), tool: tu.name || 'outil', detail: String(tu.summary || ''), reason: m[1], at: new Date().toISOString() };
  deniedAlerts.push(alert);
  if (deniedAlerts.length > 30) deniedAlerts.shift();
  announceAlert(alert);
}

function addGrant(alert, scope, by) {
  const g = { gid: crypto.randomUUID(), agentId: alert.agentId, agent: alert.agent, tool: alert.tool, scope, by, at: new Date().toISOString() };
  if (scope === 'always') { meta.grants.push(g); saveMeta(); } else sessionGrants.push(g);
  return g;
}

// decision : once | session | always | deny ; by : user | manager
function decide(aid, decision, by) {
  const p = pendingPerms.get(aid);
  const d = deniedAlerts.find(x => x.aid === aid);
  const alert = p ? p.alert : d;
  if (!alert) throw new Error('Demande introuvable (déjà traitée ?)');
  const detail = `${alert.tool} ${alert.detail.slice(0, 120)}`;
  if (decision === 'deny') {
    if (p) { pendingPerms.delete(aid); p.resolve({ behavior: 'deny', message: "Refusé par l'utilisateur" }); } else deniedAlerts = deniedAlerts.filter(x => x !== d);
    permLogPush({ agent: alert.agent, tool: alert.tool, detail: alert.detail.slice(0, 120), result: 'refusé', by });
    return;
  }
  if (p) {
    pendingPerms.delete(aid);
    if (decision === 'session' || decision === 'always') addGrant(alert, decision, by);
    p.resolve({ behavior: 'allow', updatedInput: p.input });
  } else {
    deniedAlerts = deniedAlerts.filter(x => x !== d);
    // Le classificateur tient compte de l'intention de l'utilisateur : on la lui donne explicitement.
    submit(alert.agentId, `${team.APP_MESSAGE_PREFIX} L'utilisateur autorise explicitement l'action que le système avait refusée : ${detail} (motif : ${alert.reason}). Tu peux la refaire maintenant.`, { from: 'app' });
  }
  permLogPush({ agent: alert.agent, tool: alert.tool, detail: alert.detail.slice(0, 120), result: `autorisé (${decision})`, by });
}

// Le manager n'accorde que si l'UTILISATEUR l'a active dans les reglages, par categories, jamais a lui-meme, jamais « toujours ».
function grantByManager(ref, scope) {
  if (!meta.settings.managerCanGrant) throw new Error("Le manager n'a pas le droit d'accorder des autorisations (réglage désactivé par l'utilisateur)");
  const alert = alertsList().find(a => a.aid === ref);
  if (!alert) throw new Error(`Aucune demande « ${ref} »`);
  if (alert.agentId === managerId()) throw new Error('Le manager ne peut pas accorder une autorisation à lui-même');
  const cat = alert.kind === 'prompt' ? alert.tool : alert.reason;
  if (!meta.settings.grantCategories.some(c => c.toLowerCase() === String(cat).toLowerCase())) throw new Error(`La catégorie « ${cat} » n'est pas autorisée pour le manager (réglages)`);
  decide(ref, scope === 'session' && alert.kind === 'prompt' ? 'session' : 'once', 'manager');
  send('team:event', { text: `Le manager a autorisé « ${alert.tool} » pour ${alert.agent} (${scope})` });
  return { ok: true, action: 'grant', alert: ref, scope, message: "Autorisation accordée ; l'utilisateur est notifié et peut la révoquer." };
}

ipcMain.handle('perm:get', () => ({ alerts: alertsList(), grants: allGrants(), log: permLog, canGrant: meta.settings.managerCanGrant, categories: meta.settings.grantCategories }));
ipcMain.handle('perm:decide', (_e, aid, decision) => {
  if (!['once', 'session', 'always', 'deny'].includes(decision)) throw new Error('Décision inconnue');
  decide(String(aid), decision, 'user');
  return { alerts: alertsList(), grants: allGrants(), log: permLog };
});
ipcMain.handle('perm:revoke', (_e, gid) => {
  const g = allGrants().find(x => x.gid === String(gid));
  meta.grants = meta.grants.filter(x => x.gid !== String(gid));
  const i = sessionGrants.findIndex(x => x.gid === String(gid)); if (i >= 0) sessionGrants.splice(i, 1);
  saveMeta();
  if (g) permLogPush({ agent: g.agent, tool: g.tool, detail: '', result: 'autorisation révoquée', by: 'user' });
  return { alerts: alertsList(), grants: allGrants(), log: permLog };
});

// ---------- options de la CLI activables par session (manager et agents) ----------
ipcMain.handle('option:set', async (_e, rawId, flag, enabled, value) => {
  const id = String(rawId);
  flag = String(flag);
  if (id !== managerId() && !meta.specs[id]) throw new Error("Les options ne se modifient que pour le manager et les agents de l'équipe");
  if (LOCKED_FLAGS.has(flag)) throw new Error(`L'option ${flag} est verrouillée : l'application en a besoin`);
  const data = await cliopts.loadHelp();
  const opt = data.options.find(o => o.names.includes(flag));
  if (!opt) throw new Error(`Option inconnue : ${flag}`);
  let v = true;
  if (opt.arg) {
    v = String(value == null ? '' : value).trim();
    if (enabled && (!v || v.length > 200 || /[\r\n]/.test(v))) throw new Error(`L'option ${flag} demande une valeur ${opt.arg}`);
  }
  if (SENSITIVE_FLAGS.has(flag)) {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', title: 'Option sensible', message: `${enabled ? 'Activer' : 'Désactiver'} ${flag} pour « ${nameOfSession(id)} » ?`,
      detail: "Cette option change les permissions de l'agent. Deux modes de permissions différents ne peuvent plus s'écrire entre eux. L'agent redémarre (même conversation).",
      buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0,
    });
    if (r.response !== 1) return { canceled: true };
    permLogPush({ agent: nameOfSession(id), tool: 'option ' + flag, detail: enabled ? String(v) : '', result: enabled ? 'activée' : 'désactivée', by: 'user' });
  }
  const o = meta.options[id] || (meta.options[id] = { on: {}, off: [] });
  if (enabled) { o.off = o.off.filter(f => f !== flag); o.on[flag] = v; } else { delete o.on[flag]; if (!o.off.includes(flag)) o.off.push(flag); }
  saveMeta();
  return { options: meta.options, state: await restartState(id, 'ask') };
});

// when : ask (ne redemarre pas si l'agent travaille) | now | after
async function restartState(id, when) {
  const running = agentRunning(id);
  const live = sessions.liveSessions()[id];
  if (!running) return live ? 'external' : 'next';
  if (isBusy(id)) {
    if (when === 'now') { await restartAgentForEffort(id); return 'applied'; }
    if (when === 'after') { pendingEfforts.add(id); return 'pending'; }
    return 'busy';
  }
  await restartAgentForEffort(id);
  return 'applied';
}
ipcMain.handle('agent:restart', async (_e, rawId, when) => ({ state: await restartState(String(rawId), when === 'now' ? 'now' : 'after') }));

// ---- effort de reflexion ----

// Un agent en arriere-plan ne peut pas changer d'effort en cours de route : on le redemarre (meme session, meme contexte)
// des qu'il est au repos. S'il travaille, le changement attend la fin de son tour (on n'interrompt jamais un travail).
const pendingEfforts = new Set();

async function restartAgentForEffort(id) {
  pendingEfforts.delete(id);
  if (id === managerId()) { await manager.stop(); manager.resetCrashes(); startManager(); return; }
  const a = agents.get(id);
  if (!a || !a.status().running) return;
  await a.stop();
  startAgent(id);
}

function applyPendingEfforts() {
  for (const id of [...pendingEfforts]) {
    const running = id === managerId() ? manager.status().running : (agents.get(id) && agents.get(id).status().running);
    if (!running) { pendingEfforts.delete(id); continue; }
    const live = sessions.liveSessions()[id];
    if (!live || live.status !== 'busy') restartAgentForEffort(id).catch(() => {});
  }
}

ipcMain.handle('session:setEffort', async (_e, rawId, rawLevel) => {
  const id = String(rawId);
  const level = String(rawLevel || '');
  if (!UUID_RE.test(id)) throw new Error('Identifiant de session invalide');
  if (level && !team.EFFORTS.includes(level)) throw new Error('Effort inconnu (attendu : low, medium, high, xhigh ou max)');
  // Une session d'equipe tout juste demarree n'a pas encore de transcription : elle est connue par son role.
  if (id !== managerId() && !meta.specs[id] && !sessions.findSessionFile(id)) throw new Error('Session introuvable');
  if (level) meta.efforts[id] = level; else delete meta.efforts[id];
  saveMeta();
  const isManager = id === managerId();
  const running = isManager ? manager.status().running : !!(agents.get(id) && agents.get(id).status().running);
  const live = sessions.liveSessions()[id];
  let state = 'next';                                  // pris en compte au prochain demarrage / a la prochaine reponse
  if (running) {
    if (live && live.status === 'busy') { pendingEfforts.add(id); state = 'pending'; }
    else { await restartAgentForEffort(id); state = 'applied'; }
  } else if (live) {
    state = 'external';                                // ouverte dans un terminal de l'utilisateur : on ne peut pas la modifier
  }
  return { efforts: meta.efforts, state };
});

// ---- couleurs ----

ipcMain.handle('meta:setColor', (_e, id, color) => {
  id = String(id);
  if (!UUID_RE.test(id)) throw new Error('Identifiant de session invalide');
  if (color == null) delete meta.colors[id];
  else if (COLOR_RE.test(String(color))) meta.colors[id] = String(color).toLowerCase();
  else throw new Error('Couleur invalide');
  saveMeta();
  return meta.colors;
});

// ---- suppression ----

function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko'; }

ipcMain.handle('session:delete', async (_e, rawId) => {
  const id = String(rawId);
  if (id === managerId()) throw new Error("Le manager ne se supprime pas : il fait partie de l'application.");
  const file = sessions.findSessionFile(id);
  if (!file) throw new Error('Session introuvable');
  const ag = agents.get(id);
  const live = ag && ag.status().running ? { pid: ag.status().pid } : sessions.liveSessions()[id];
  if (live) throw new Error(`Session ouverte (pid ${live.pid}) : ferme-la avant de la supprimer.`);
  if (reply.isRunning(id)) throw new Error('Une reponse est en cours pour cette session.');

  const info = sessions.listSessions().find(s => s.id === id);
  const ask = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Supprimer la session',
    message: `Supprimer « ${info ? info.title : id} » ?`,
    detail: `${info ? fmtSize(info.size) + ' · ' : ''}La session sera mise à la corbeille, tu pourras la restaurer depuis là.`,
    buttons: ['Annuler', 'Mettre à la corbeille'],
    defaultId: 0,
    cancelId: 0,
  });
  if (ask.response !== 1) return { canceled: true };

  closeTranscript();
  const remaining = sessions.sessionPaths(id);
  const failed = [];
  for (const p of remaining) {
    try { await shell.trashItem(p); } catch (e) { failed.push({ p, msg: e.message }); }
  }
  if (failed.length) {
    // On ne supprime jamais en definitif sans le redemander.
    const again = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Corbeille indisponible',
      message: 'Impossible de mettre à la corbeille : ' + failed[0].msg,
      detail: 'Supprimer définitivement ? Cette action est irréversible.',
      buttons: ['Annuler', 'Supprimer définitivement'],
      defaultId: 0,
      cancelId: 0,
    });
    if (again.response !== 1) throw new Error('Suppression annulée (corbeille indisponible)');
    for (const f of failed) fs.rmSync(f.p, { recursive: true, force: true });
  }
  sessions.forget(file);
  agents.delete(id);
  if (meta.colors[id] || meta.specs[id] || meta.titles[id] || meta.efforts[id]) { delete meta.colors[id]; delete meta.specs[id]; delete meta.titles[id]; delete meta.efforts[id]; saveMeta(); }
  refreshRegistry(false);
  return { deleted: true };
});

// ---------- workers : fermes avec l'appli, rouverts au demarrage ----------

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Sessions d'equipe actuellement demarrees par l'appli (jamais les sessions que l'utilisateur ouvre lui-meme).
function runningWorkers() {
  const live = sessions.liveSessions();
  return [...agents].filter(([, a]) => a.status().running).map(([id, a]) => ({
    id, name: meta.specs[id] ? meta.specs[id].name : id, busy: !!live[id] && live[id].status === 'busy', agent: a,
  }));
}

// Leurs processus sont des enfants de l'appli : arret propre en fermant leur entree.
async function closeWorkers(list) { await Promise.all(list.map(w => w.agent.stop())); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Plus aucun terminal : une session d'equipe laissee ouverte dans un TERMINAL par une ancienne version est arretee
// (sa fenetre se ferme avec elle) puis reprise en arriere-plan. Si elle travaille encore, on n'y touche pas.
async function convertTerminalWorkers() {
  const live = sessions.liveSessions();
  const stale = Object.entries(meta.specs).filter(([id, s]) =>
    s.kind !== 'manager' && !s.adopted && live[id] && !agents.has(id) && launch.isClaudeProcess(live[id].pid));
  const stopped = [];
  for (const [id, s] of stale) {
    if (live[id].status === 'busy') { send('team:event', { text: `« ${s.name} » travaille encore dans un ancien terminal : ferme-le quand il a fini` }); continue; }
    try { process.kill(live[id].pid, 'SIGTERM'); stopped.push([id, live[id].pid]); } catch { /* deja ferme */ }
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && stopped.some(([, pid]) => pidAlive(pid))) await delay(250);
  let n = 0;
  for (const [id, pid] of stopped) {
    if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* parti entre-temps */ } await delay(300); }
    try { if (sessions.findSessionFile(id) && startAgent(id).running) n++; } catch { /* on passe a la suivante */ }
  }
  if (n) send('team:event', { text: `${n} session${n > 1 ? 's' : ''} d'équipe passée${n > 1 ? 's' : ''} en arrière-plan (plus de terminal)` });
}

// Rouvre (en arriere-plan) les workers qui etaient ouverts a la fermeture. Un worker interrompu en plein travail recoit un
// message pour reprendre ; un worker au repos est simplement rouvert.
async function reopenWorkers() {
  const list = meta.reopen;
  meta.reopen = [];
  saveMeta();
  if (!list.length || !meta.settings.closeWorkersOnQuit) return;
  // On attend que le manager soit joignable, pour que les workers puissent lui ecrire des leur reprise.
  const mid = managerId();
  for (let i = 0; i < 30 && meta.settings.autostart && mid && !sessions.liveSessions()[mid]; i++) await delay(1000);
  let n = 0;
  for (const { id, busy } of list) {
    const spec = meta.specs[id];
    if (!spec || spec.kind === 'manager' || sessions.liveSessions()[id] || !sessions.findSessionFile(id)) continue;
    if (meta.settings.maxWorkers > 0 && n >= meta.settings.maxWorkers) break;
    try {
      if (startAgent(id, busy ? team.interruptedMessage(spec) : '').running) n++;
    } catch { /* dossier disparu : on passe au suivant */ }
    await delay(300);
  }
  if (n) send('team:event', { text: `${n} worker${n > 1 ? 's' : ''} rouvert${n > 1 ? 's' : ''} (ouvert${n > 1 ? 's' : ''} à la fermeture de l'application)` });
}

// ---------- cycle de vie ----------

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  if (!gotLock) return;
  loadMeta();
  try { ruleLog = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'rules-log.json'), 'utf8')).slice(-200); } catch { /* pas de journal */ }
  try { tickLog = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'tick-log.json'), 'utf8')).slice(-100); } catch { /* pas de journal */ }
  for (const id of Object.keys(meta.specs)) watchSession(id, true);
  try { writeHook(); } catch { /* sans le controle, les workers restent limites par leur prompt seulement */ }
  try { refreshRegistry(true); } catch { /* le registre sera recree au prochain cycle */ }
  stopRequests = requests.start(team.dirsOf(registryFile()), handleManagerRequest, (file, payload) => {
    // Le manager n'a pas a relire le fichier de reponse : on lui donne le resultat tout de suite.
    toManager(`${team.APP_MESSAGE_PREFIX} Résultat de ta demande « ${file} » : ${JSON.stringify(payload)}`);
  });
  createWindow();
  if (meta.settings.autostart) startManager();
  convertTerminalWorkers().catch(() => {}).then(() => reopenWorkers()).catch(() => {});
});

let quitting = false;
let forceQuit = false; // arret demande par un signal (SIGTERM / SIGINT) : on ferme sans demander de confirmation
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { forceQuit = true; app.quit(); });
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  shutdown().then((go) => {
    if (go) { app.exit(0); return; }
    quitting = false;                 // l'utilisateur a annule : l'appli continue
    if (!win) createWindow();
  });
});

async function shutdown() {
  const workers = runningWorkers();
  const busy = workers.filter(w => w.busy);
  if (busy.length && !forceQuit) {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning',
      title: 'Fermer claudemanager',
      message: `${busy.length} worker${busy.length > 1 ? 's travaillent' : ' travaille'} encore : ${busy.map(w => w.name).join(', ')}`,
      detail: "Fermer l'application arrête aussi les workers (ils tournent en arrière-plan). " + (meta.settings.closeWorkersOnQuit ? 'Ceux qui travaillaient seront rouverts au prochain démarrage et reprendront leur tâche.' : 'Ils ne seront pas rouverts automatiquement.'),
      buttons: ['Annuler', 'Tout fermer'],
      defaultId: 0,
      cancelId: 0,
    });
    if (r.response !== 1) return false;
  }
  clearInterval(liveTimer);
  if (stopRequests) stopRequests();
  reply.stopAll();
  // On note les workers ouverts AVANT de les arreter : c'est la liste a rouvrir au prochain lancement.
  meta.reopen = meta.settings.closeWorkersOnQuit ? workers.map(w => ({ id: w.id, busy: w.busy })) : [];
  saveMeta();
  // Le manager et les workers s'arretent en parallele (la session du manager est reprise au prochain lancement).
  await Promise.race([Promise.all([manager.stop(), closeWorkers(workers)]), delay(12000)]);
  return true;
}
app.on('window-all-closed', () => { app.quit(); });
