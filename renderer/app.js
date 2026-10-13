'use strict';

// Theme : clair / sombre / systeme, memorise (localStorage) et applique avant l'affichage.
function applyTheme() {
  let pref = 'system';
  try { pref = localStorage.getItem('theme') || 'system'; } catch { /* stockage indisponible */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return pref;
}
applyTheme();

const BATCH = 300; // elements du chat affiches par tranche

const $ = (id) => document.getElementById(id);
const state = {
  sessions: [],
  live: {},
  home: '',
  selectedId: null,
  items: [],          // elements du chat ouvert (sans les tool_result, ranges dans results)
  results: new Map(), // toolUseId -> { text, error }
  toolEls: new Map(), // toolUseId -> element <details> deja affiche
  from: 0,            // index du premier element affiche
  listSig: '',
  colors: {},         // couleurs choisies par l'utilisateur : id de session -> #rrggbb
  titles: {},         // noms d'affichage des sessions ordinaires : id -> nom
  efforts: {},        // effort de reflexion choisi par session : id -> low|medium|high|xhigh|max
  replying: new Set(),// sessions pour lesquelles une reponse part de cette appli
  lastSent: '',       // dernier message envoye, remis dans la zone si l'envoi echoue
  agents: {},         // sessions d'equipe demarrees par l'appli (en arriere-plan) : id -> { running, starting, error }
  queues: {},         // file d'attente de messages par agent : id -> [{ qid, text, from, urgent }]
  perms: { alerts: [], grants: [], log: [] }, // autorisations demandees / accordees
  specs: {},          // roles/taches des sessions d'equipe : id -> { name, kind, role, task, ... }
  templates: [],      // modeles de role (fournis + enregistres)
  managerName: 'manager',
  registryPath: '',
  manager: { id: null, running: false, starting: false, error: null, external: null, name: 'manager', cwd: '' },
  settings: { teamMode: 'acceptEdits', autostart: true, maxWorkers: 6, managerModel: '', closeWorkersOnQuit: true },
  openedManager: false, // le chat du manager s'ouvre une fois, au demarrage
};

// Chaque session a sa couleur (stable, tiree de son id) ; le dossier garde la sienne dans la pastille du chemin.
const PALETTE = ['#f97316', '#3b82f6', '#10b981', '#a855f7', '#ec4899', '#eab308', '#06b6d4', '#ef4444', '#84cc16', '#8b5cf6', '#14b8a6', '#f43f5e'];

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const MANAGER_COLOR = '#a78bfa';
function isManager(id) { return !!id && id === state.manager.id; }

function colorOf(s) {
  if (isManager(s.id)) return MANAGER_COLOR;
  return state.colors[s.id] || PALETTE[hash(s.id) % PALETTE.length];
}

function projectColor(s) {
  return PALETTE[hash(s.cwd || s.project || '') % PALETTE.length];
}

const TOOL_CATS = { Bash: 'bash', Read: 'read', Glob: 'read', Grep: 'read', Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', WebFetch: 'web', WebSearch: 'web', Agent: 'agent', Task: 'agent', Skill: 'agent', ToolSearch: 'agent' };
function toolCat(name) { return TOOL_CATS[name] || (name.startsWith('mcp__') ? 'web' : ''); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mini rendu markdown, sur du texte echappe : blocs de code, `code`, **gras**, titres.
function md(text) {
  return text.split(/(```[\s\S]*?```)/g).map((part) => {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      const body = part.slice(3, -3).replace(/^[\w+-]*\n/, '');
      return '<pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>';
    }
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4} (.+)$/gm, '<span class="h">$1</span>');
  }).join('');
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hm;
}
function fmtSize(b) {
  return b > 1e6 ? (b / 1e6).toFixed(1) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko';
}
function shortPath(p) {
  if (!p) return '?';
  return state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p;
}

let toastTimer = null;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- liste des sessions ----------

function liveLabel(l, id) {
  if (state.replying.has(id)) return { cls: 'busy', text: 'répond…' };
  if (!l) return null;
  return l.status === 'busy' ? { cls: 'busy', text: 'en cours' } : { cls: 'live', text: l.status === 'idle' ? 'ouverte' : l.status };
}

function renderProjectFilter() {
  const sel = $('project-filter');
  const current = sel.value;
  const dirs = [...new Set(state.sessions.map(s => s.cwd).filter(Boolean))].sort();
  sel.replaceChildren(new Option('Tous les dossiers', ''), ...dirs.map(d => new Option(shortPath(d), d)));
  sel.value = dirs.includes(current) ? current : '';
}

// Nom affiche : celui choisi dans l'appli, sinon celui de Claude Code (/rename ou titre automatique).
function displayTitle(s) { return state.titles[s.id] || s.title; }

function renderRow(s) {
  const l = liveLabel(state.live[s.id], s.id);
  const spec = state.specs[s.id];
  const li = el('li', 'row' + (s.id === state.selectedId ? ' selected' : ''));
  li.dataset.id = s.id;
  li.style.setProperty('--c', colorOf(s));
  li.style.setProperty('--p', projectColor(s));
  li.append(el('span', 'dot' + (l ? ' ' + l.cls : '')));
  // Ligne 1 : le nom seul, sur toute la largeur (session d'equipe : son adresse).
  li.append(el('div', 'title', spec ? spec.name : displayTitle(s)), el('div', 'when', fmtWhen(s.lastActivity)));
  // Ligne 2 : les badges (role, etat) sur leur propre ligne, jamais accoles au nom.
  const nq = (state.queues[s.id] || []).length;
  const na = state.perms.alerts.filter(a => a.agentId === s.id).length;
  if (spec || l || nq || na) {
    const badges = el('div', 'badges');
    if (spec) badges.append(el('span', 'badge kind-' + spec.kind, KIND_LABEL[spec.kind] + (spec.adopted ? ' · rattaché' : '')));
    if (l) badges.append(el('span', 'badge ' + l.cls, l.text));
    if (na) badges.append(el('span', 'badge alert', `🔒 ${na} autorisation${na > 1 ? 's' : ''} à décider`));
    if (nq) badges.append(el('span', 'badge queue', `⏳ ${nq} en file`));
    li.append(badges);
  }
  // Ligne 3 : le titre de la conversation (session d'equipe), en gris.
  if (spec) li.append(el('div', 'sub2', displayTitle(s)));
  // Ligne 4 : dossier et taille.
  const sub = el('div', 'sub');
  sub.append(el('span', 'chip', shortPath(s.cwd)), el('span', 'size', '· ' + fmtSize(s.size)));
  li.append(sub);
  const del = el('button', 'del', '🗑');
  del.title = 'Supprimer cette session';
  del.addEventListener('click', (ev) => { ev.stopPropagation(); deleteSession(s.id); });
  li.append(del);
  li.addEventListener('click', () => openSession(s.id));
  li.addEventListener('dblclick', () => openRename(s.id));
  return li;
}

function sectionHeader(text, cls) {
  const li = el('li', 'row sect' + (cls ? ' ' + cls : ''), text);
  return li;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const proj = $('project-filter').value;
  const rows = state.sessions.filter((s) => {
    if (isManager(s.id)) return false; // le manager a sa carte en haut
    if (proj && s.cwd !== proj) return false;
    if (!q) return true;
    const spec = state.specs[s.id];
    return (displayTitle(s) + ' ' + s.title + ' ' + (spec ? spec.name : '') + ' ' + s.firstPrompt + ' ' + (s.cwd || '') + ' ' + s.id).toLowerCase().includes(q);
  });
  // Les sessions vivantes d'abord, puis par activite recente (deja triees).
  rows.sort((a, b) => (state.live[b.id] ? 1 : 0) - (state.live[a.id] ? 1 : 0));
  const workers = rows.filter(s => state.specs[s.id] && state.specs[s.id].kind === 'worker');
  const others = rows.filter(s => !workers.includes(s));

  const ul = $('session-list');
  const scroll = ul.scrollTop;
  const nodes = [];
  if (workers.length) { nodes.push(sectionHeader(`ÉQUIPE · ${workers.length} worker${workers.length > 1 ? 's' : ''}`, 'team')); nodes.push(...workers.map(renderRow)); }
  if (others.length) { nodes.push(sectionHeader(workers.length ? `AUTRES SESSIONS · ${others.length}` : `SESSIONS · ${others.length}`)); nodes.push(...others.map(renderRow)); }
  ul.replaceChildren(...nodes);
  ul.scrollTop = scroll;
  const nLive = Object.keys(state.live).length;
  $('count').textContent = `${rows.length} session${rows.length > 1 ? 's' : ''}` + (nLive ? ` · ${nLive} active${nLive > 1 ? 's' : ''}` : '');
  renderManagerCard();
}

async function refreshList() {
  try {
    const r = await window.api.list();
    state.home = r.home;
    state.live = r.live;
    state.colors = r.colors || {};
    state.titles = r.titles || {};
    state.efforts = r.efforts || {};
    state.queues = r.queues || {};
    state.specs = r.specs || {};
    state.agents = r.agents || {};
    state.templates = r.templates || [];
    state.managerName = r.managerName || 'manager';
    state.registryPath = r.registryPath || '';
    state.manager = r.manager || state.manager;
    state.settings = r.settings || state.settings;
    state.replying = new Set(r.replying || []);
    const sig = r.sessions.map(s => s.id + s.lastActivity + s.size).join('|');
    if (sig !== state.listSig) {
      state.listSig = sig;
      state.sessions = r.sessions;
      renderProjectFilter();
    }
    renderList();
    updateHead();
    // Le manager est mis en avant : son chat est ouvert au demarrage.
    if (!state.openedManager && state.manager.id) { state.openedManager = true; openSession(state.manager.id); }
  } catch (e) {
    toast('Lecture des sessions impossible : ' + e.message, true);
  }
}

// ---------- chat ----------

// Avant son premier message, le manager n'a pas encore de transcription : on affiche quand meme son chat.
function managerStub() {
  return { id: state.manager.id, title: 'Manager', cwd: state.manager.cwd || state.home, project: '', size: 0, lastActivity: '', firstPrompt: '', file: null };
}

function currentSession() {
  const s = state.sessions.find(x => x.id === state.selectedId);
  if (s) return s;
  return state.selectedId && isManager(state.selectedId) ? managerStub() : undefined;
}

function updateHead() {
  const s = currentSession();
  if (!s) return;
  const l = state.live[s.id];
  const lab = liveLabel(l, s.id);
  const mgr = isManager(s.id);
  $('chat').classList.toggle('is-manager', mgr);
  const specH = state.specs[s.id];
  $('chat-title').textContent = mgr ? 'Manager · ' + state.manager.name : (specH ? specH.name : displayTitle(s));
  $('chat').style.setProperty('--c', colorOf(s));
  $('chat').style.setProperty('--p', projectColor(s));
  const meta = $('chat-meta');
  meta.textContent = '';
  meta.append(el('span', 'chip', shortPath(s.cwd)), document.createTextNode(mgr ? ` · pleins droits · ${s.id.slice(0, 8)}` : ` · ${fmtSize(s.size)} · ${s.id.slice(0, 8)}`));
  if (lab) meta.append(el('span', 'badge ' + lab.cls, lab.text + (l && l.pid ? ' · pid ' + l.pid : '')));
  $('btn-adopt').hidden = mgr || !!specH;
  $('btn-leave').hidden = !(specH && specH.adopted);
  const ag = state.agents[s.id];
  $('btn-agent-stop').hidden = mgr || !(ag && ag.running);
  $('btn-delete').hidden = mgr;
  $('swatches').hidden = mgr;
  $('btn-delete').disabled = !!l;
  $('btn-delete').title = l ? 'Session ouverte : ferme-la avant de la supprimer' : 'Mettre la session à la corbeille';
  renderSwatches(s);
  renderEffort(s);
  renderQueue();
  renderPermBanner();
  updateComposer(s);
  renderSpec(s);
}

const EFFORT_LABEL = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximum' };

// Remplit un sélecteur d'effort : la première option = « par défaut » (avec la valeur par défaut si on la connaît).
function fillEffortSelect(sel, defaultLevel, prefix) {
  sel.replaceChildren(
    new Option(`${prefix}par défaut${defaultLevel ? ' (' + EFFORT_LABEL[defaultLevel].toLowerCase() + ')' : ''}`, ''),
    ...Object.entries(EFFORT_LABEL).map(([v, label]) => new Option(prefix + label.toLowerCase(), v)),
  );
}

// Effort de reflexion de la session ouverte : sélecteur de l'en-tête.
function renderEffort(s) {
  const sel = $('effort-select');
  const spec = state.specs[s.id];
  const def = isManager(s.id) ? state.settings.managerEffort : (spec ? state.settings.workerEffort : '');
  fillEffortSelect(sel, def, 'Effort : ');
  const own = state.efforts[s.id] || '';
  sel.value = own;
  sel.classList.toggle('custom', !!own);
  sel.disabled = !!state.live[s.id] && !(state.agents[s.id] && state.agents[s.id].running) && !isManager(s.id); // ouverte ailleurs
}

async function changeEffort() {
  const id = state.selectedId;
  if (!id) return;
  const level = $('effort-select').value;
  try {
    const r = await window.api.setEffort(id, level);
    state.efforts = r.efforts;
    const name = level ? EFFORT_LABEL[level].toLowerCase() : 'par défaut';
    toast({
      applied: `Effort « ${name} » appliqué (la session a redémarré, avec tout son contexte)`,
      pending: `Effort « ${name} » enregistré : il sera appliqué quand la session aura fini son travail en cours`,
      next: `Effort « ${name} » enregistré : appliqué à la prochaine réponse ou au prochain démarrage`,
      external: `Effort « ${name} » enregistré, mais cette session est ouverte dans un terminal : il s'appliquera à sa prochaine ouverture`,
    }[r.state] || 'Effort enregistré');
    updateHead();
  } catch (e) {
    toast(errText(e), true);
    updateHead();
  }
}

const KIND_LABEL = { worker: 'worker', manager: 'manager', solo: 'session simple' };
const MODE_LABEL = { standard: 'standard', acceptEdits: 'modifications acceptées', auto: 'automatique', bypass: 'sans confirmations' };

function renderSpec(s) {
  const spec = state.specs[s.id];
  const box = $('spec');
  box.hidden = !spec;
  if (!spec) return;
  $('spec-sum').textContent = (spec.kind === 'manager' ? 'Rôle du manager' : `${spec.name} · ${KIND_LABEL[spec.kind]}`) + (spec.kind === 'worker' ? ` · rend compte à « ${spec.managerName} »` : '') + ` · permissions : ${MODE_LABEL[spec.mode]}`;
  $('spec-body').textContent = (spec.role ? 'RÔLE\n' + spec.role + '\n\n' : '') + (spec.task ? 'TÂCHE\n' + spec.task : '(pas de tâche de départ)');
}

function renderSwatches(s) {
  const box = $('swatches');
  const chosen = state.colors[s.id] || null;
  box.replaceChildren(...PALETTE.map((c) => {
    const b = el('button', 'sw' + (chosen === c ? ' on' : ''));
    b.style.setProperty('--s', c);
    b.title = 'Colorer cette session';
    b.addEventListener('click', () => setColor(s.id, c));
    return b;
  }));
  const auto = el('button', 'sw auto' + (chosen ? '' : ' on'));
  auto.title = 'Couleur automatique';
  auto.addEventListener('click', () => setColor(s.id, null));
  box.append(auto);
}

async function setColor(id, color) {
  try {
    state.colors = await window.api.setColor(id, color);
    renderList();
    updateHead();
  } catch (e) { toast(errText(e), true); }
}

function errText(e) {
  return String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- reponse ----------

function updateManagerComposer(s) {
  const m = state.manager;
  const live = state.live[s.id];
  const busy = !!live && live.status === 'busy';
  const can = m.running && !m.external;
  const input = $('reply-input');
  input.disabled = !can;
  $('btn-send').hidden = false;
  $('btn-send').disabled = !can;
  $('btn-stop').hidden = true;
  const st = $('composer-status');
  st.hidden = !busy;
  st.textContent = 'Le manager travaille…';
  input.placeholder = can
    ? 'Parle au manager… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)'
    : m.external ? `Le manager est ouvert dans un terminal (pid ${m.external.pid}) : écris-lui là-bas.` : 'Le manager est arrêté : démarre-le avec le bouton de sa carte.';
  $('composer-hint').textContent = "Les workers ne parlent qu'au manager, qui relaie entre eux. Il peut ouvrir ou rouvrir des workers (pleins droits pour lui ; workers : " + MODE_LABEL[state.settings.teamMode] + ').';
}

function updateAgentComposer(s, spec) {
  const ag = state.agents[s.id];
  const running = !!(ag && ag.running);
  const live = state.live[s.id];
  const external = !!live && !running;               // ouverte dans un terminal que l'utilisateur a lui-meme ouvert
  const busy = running && !!live && live.status === 'busy';
  const input = $('reply-input');
  input.disabled = external;
  $('btn-send').hidden = false;
  $('btn-send').disabled = external;
  $('btn-stop').hidden = true;
  const st = $('composer-status');
  st.hidden = !busy;
  st.textContent = spec.name + ' travaille…';
  input.placeholder = external
    ? `Session ouverte dans un terminal (pid ${live.pid}) : réponds-y directement.`
    : running ? `Écrire à ${spec.name}… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)`
      : `Écrire à ${spec.name} : ton message la démarre en arrière-plan.`;
  $('composer-hint').textContent = external ? '' : (ag && ag.error ? ag.error + ' ' : '')
    + "Aucune fenêtre : cette session tourne en arrière-plan. " + (spec.kind === 'worker' ? 'Elle ne parle qu\'au manager.' : '');
}

function updateComposer(s) {
  if (isManager(s.id)) { updateManagerComposer(s); return; }
  const spec = state.specs[s.id];
  if (spec) { updateAgentComposer(s, spec); return; }
  const l = state.live[s.id];
  const busy = state.replying.has(s.id);
  const blocked = !!l && !busy; // ouverte dans un terminal : on ne peut pas y ecrire d'ici
  const input = $('reply-input');
  input.disabled = busy || blocked;
  $('btn-send').hidden = busy;
  $('btn-send').disabled = blocked;
  $('btn-stop').hidden = !busy;
  const st = $('composer-status');
  st.hidden = !busy;
  st.textContent = 'Claude répond…';
  input.placeholder = blocked
    ? `Session ouverte dans un terminal (pid ${l.pid}) : réponds-y directement.`
    : 'Répondre à Claude… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)';
  $('composer-hint').textContent = blocked ? '' : $('skip-perms').checked
    ? 'Mode sans confirmations : Claude peut modifier des fichiers et lancer des commandes sans demander.'
    : 'Les outils qui demandent une autorisation seront refusés (pas de terminal pour confirmer). Coche « sans confirmations » pour les autoriser.';
}

function autosize() {
  const t = $('reply-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  t.style.overflowY = t.scrollHeight > 160 ? 'auto' : 'hidden';
}

async function sendReply() {
  const s = currentSession();
  const input = $('reply-input');
  const text = input.value.trim();
  if (!s || !text || input.disabled) return;
  state.lastSent = text;
  input.value = '';
  autosize();
  try {
    const urgent = $('urgent').checked;
    let r = null;
    if (isManager(s.id)) r = await window.api.managerSend(text, { urgent });
    else if (state.specs[s.id]) r = await window.api.agentSend(s.id, text, { urgent });
    else await window.api.sendReply({ id: s.id, cwd: s.cwd, text, skipPermissions: $('skip-perms').checked });
    $('urgent').checked = false;
    if (r && r.queued) toast(`Message mis en file d'attente (n°${r.position}) : l'agent travaille, il le recevra à la fin de sa tâche`);
    const m = $('messages');
    m.scrollTop = m.scrollHeight; // on suit la reponse
  } catch (e) {
    input.value = text; // rien n'est perdu si l'envoi n'a pas demarre
    autosize();
    toast(errText(e), true);
  }
}

function onReplyState({ id, running }) {
  if (running) state.replying.add(id); else state.replying.delete(id);
  renderList();
  updateHead();
}

function onReplyDone({ id, ok, error }) {
  state.replying.delete(id);
  if (!ok && id === state.selectedId) {
    const input = $('reply-input');
    if (!input.value) { input.value = state.lastSent; autosize(); } // on rend le message pour pouvoir reessayer
    toast('Réponse échouée : ' + error, true);
  } else if (!ok) {
    toast('Réponse échouée : ' + error, true);
  }
  refreshList();
}

// ---------- suppression ----------

async function deleteSession(id) {
  try {
    const r = await window.api.deleteSession(id);
    if (r.canceled) return;
    if (id === state.selectedId) {
      state.selectedId = null;
      $('chat').hidden = true;
      $('empty').hidden = false;
    }
    state.listSig = '';
    await refreshList();
    toast('Session mise à la corbeille');
  } catch (e) { toast(errText(e), true); }
}

function toolState(d, res) {
  const st = d.querySelector('.state');
  d.classList.remove('pending', 'error');
  if (!res) { d.classList.add('pending'); st.textContent = 'en attente…'; return; }
  if (res.error) d.classList.add('error');
  st.textContent = res.error ? 'erreur' : 'ok';
  let pre = d.querySelector('pre.result');
  if (!pre) { pre = el('pre', 'result'); d.append(pre); }
  pre.textContent = res.text || '(vide)';
  d.dataset.search += ' ' + (res.text || '').toLowerCase().slice(0, 8000);
}

function buildEl(item) {
  let node;
  const when = fmtWhen(item.ts);
  if (item.kind === 'tool_use') {
    const cat = toolCat(item.name);
    node = el('details', 'tool' + (cat ? ' cat-' + cat : ''));
    const sum = el('summary');
    sum.append(el('span', 'name', item.name), el('span', 'sum', item.summary), el('span', 'state'));
    node.append(sum, Object.assign(el('pre', 'input'), { textContent: item.input }));
    node.dataset.search = (item.name + ' ' + item.summary + ' ' + item.input).toLowerCase();
    toolState(node, state.results.get(item.toolUseId));
    state.toolEls.set(item.toolUseId, node);
  } else if (item.kind === 'user' && item.meta) {
    node = el('details', 'meta');
    node.append(el('summary', null, 'message système · ' + item.text.trim().replace(/\s+/g, ' ').slice(0, 90)));
    node.append(Object.assign(el('pre', null), { textContent: item.text }));
    node.dataset.search = item.text.toLowerCase().slice(0, 20000);
  } else if (item.kind === 'user' || item.kind === 'assistant') {
    node = el('div', 'msg ' + item.kind);
    node.append(el('div', 'who', (item.kind === 'user' ? 'Toi' : 'Claude') + (when ? ' · ' + when : '')));
    const bubble = el('div', 'bubble');
    const text = el('div', 'text');
    text.innerHTML = md(item.text);
    bubble.append(text);
    node.append(bubble);
    node.dataset.search = item.text.toLowerCase().slice(0, 20000);
  } else if (item.kind === 'thinking') {
    node = el('details', 'meta');
    node.append(el('summary', null, 'réflexion'), Object.assign(el('pre', null), { textContent: item.text }));
    node.dataset.search = item.text.toLowerCase().slice(0, 20000);
  } else {
    return null;
  }
  if (item.side) node.classList.add('side');
  return node;
}

function applyChatFilter() {
  const q = $('chat-search').value.trim().toLowerCase();
  for (const n of $('messages').children) {
    if (n.dataset && n.dataset.search != null) n.classList.toggle('hidden-by-search', !!q && !n.dataset.search.includes(q));
  }
}

function applyToggles() {
  const m = $('messages');
  m.classList.toggle('hide-tools', !$('show-tools').checked);
  m.classList.toggle('hide-meta', !$('show-meta').checked);
}

function nearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}

function renderRange(start, end) {
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const n = buildEl(state.items[i]);
    if (n) frag.append(n);
  }
  return frag;
}

function updateLoadMore() {
  const m = $('messages');
  let btn = m.querySelector('.load-more');
  if (state.from <= 0) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = el('button', 'load-more');
    btn.addEventListener('click', () => {
      const m2 = $('messages');
      const oldH = m2.scrollHeight;
      const start = Math.max(0, state.from - BATCH);
      const frag = renderRange(start, state.from);
      state.from = start;
      btn.after(frag);
      m2.scrollTop += m2.scrollHeight - oldH;
      updateLoadMore();
      applyChatFilter();
    });
    m.prepend(btn);
  }
  btn.textContent = `Afficher ${Math.min(BATCH, state.from)} éléments plus anciens (${state.from} masqués)`;
}

async function openSession(id) {
  state.selectedId = id;
  renderList();
  $('empty').hidden = true;
  $('chat').hidden = false;
  $('chat-search').value = '';
  updateHead();
  const m = $('messages');
  m.replaceChildren(el('div', 'muted', 'Chargement…'));
  state.loading = true;   // les ajouts recus pendant le chargement sont mis en attente
  state.queued = [];
  try {
    const r = await window.api.openTranscript(id);
    if (state.selectedId !== id) return; // l'utilisateur a change de session entre-temps
    state.results = new Map();
    state.toolEls = new Map();
    state.items = [];
    for (const it of r.items) {
      if (it.kind === 'tool_result') state.results.set(it.toolUseId, { text: it.text, error: it.error });
      else state.items.push(it);
    }
    state.from = Math.max(0, state.items.length - BATCH);
    m.replaceChildren(renderRange(state.from, state.items.length));
    if (!state.items.length && isManager(id)) m.append(el('div', 'muted placeholder', 'Le manager est prêt. Écris-lui ce que tu veux faire : il crée et pilote les workers.'));
    updateLoadMore();
    applyToggles();
    m.scrollTop = m.scrollHeight;
    $('btn-bottom').hidden = true;
    state.loading = false;
    for (const p of state.queued) onAppend(p);
    state.queued = [];
  } catch (e) {
    state.loading = false;
    m.replaceChildren(el('div', 'muted', 'Impossible de charger la session : ' + e.message));
  }
}

function onAppend(payload) {
  const { id, items } = payload;
  if (id !== state.selectedId) return;
  if (state.loading) { state.queued.push(payload); return; }
  const m = $('messages');
  const stick = nearBottom();
  const frag = document.createDocumentFragment();
  const ph = m.querySelector('.placeholder');
  if (ph) ph.remove();
  for (const it of items) {
    if (it.kind === 'tool_result') {
      const res = { text: it.text, error: it.error };
      state.results.set(it.toolUseId, res);
      const d = state.toolEls.get(it.toolUseId);
      if (d) toolState(d, res);
      continue;
    }
    state.items.push(it);
    const n = buildEl(it);
    if (n) frag.append(n);
  }
  m.append(frag);
  applyChatFilter();
  if (stick) { m.scrollTop = m.scrollHeight; } else { $('btn-bottom').hidden = false; }
}

// ---------- actions ----------


// ---------- ajouter a l'equipe ----------

// Propose un nom d'equipe valide a partir du titre de la session.
function slugify(text) {
  const s = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-._]+$/g, '');
  if (s.length <= 40) return s || 'worker';
  const cut = s.slice(0, 40);
  const i = cut.lastIndexOf('-');
  return i > 15 ? cut.slice(0, i) : cut; // on coupe a un tiret plutot qu'au milieu d'un mot
}

let adoptId = null;

function openAdopt(id) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  adoptId = id;
  const live = state.live[id];
  $('ad-name').value = slugify(displayTitle(s));
  $('ad-role').value = '';
  $('ad-note').textContent = (live
    ? `Cette session est déjà ouverte : son adresse reste « ${live.name || 'son nom actuel'} » jusqu'à sa prochaine ouverture. Le manager la prévient et lui rappelle les règles par un message d'accueil. `
    : "Le nom, le rôle et la règle « ne parler qu'au manager » s'appliqueront à sa prochaine ouverture. ")
    + "L'application ne fermera jamais cette session, ni à sa fermeture ni à son démarrage.";
  $('ad-error').hidden = true;
  $('adopt-dialog').showModal();
  $('ad-name').focus();
  $('ad-name').select();
}

async function submitAdopt(ev) {
  ev.preventDefault();
  if (!adoptId) return;
  try {
    const r = await window.api.adoptSession({ id: adoptId, name: $('ad-name').value, role: $('ad-role').value });
    $('adopt-dialog').close();
    toast(`« ${r.name} » a rejoint l'équipe`);
    state.listSig = '';
    await refreshList();
  } catch (e) {
    $('ad-error').textContent = errText(e);
    $('ad-error').hidden = false;
  }
}

async function leaveTeam(id) {
  try {
    const r = await window.api.leaveTeam(id);
    state.specs = r.specs || state.specs;
    toast("Session retirée de l'équipe");
    state.listSig = '';
    await refreshList();
  } catch (e) { toast(errText(e), true); }
}

// ---------- regles « SI ... ALORS ... » ----------

let rulesAgent = null; // nom de l'agent dont on edite les regles

async function refreshRulesBadge() {
  try {
    const r = await window.api.rulesGet();
    const b = $('mc-rules');
    b.textContent = r.paused ? 'Règles ⏸' : `Règles${r.rules.some(x => x.enabled) ? ' ▶' : ''}`;
    b.classList.toggle('danger', r.paused);
  } catch { /* appli en demarrage */ }
}

function syncRuleForm() {
  const t = $('ru-ttype').value, a = $('ru-atype').value;
  $('ru-mrow').hidden = t !== 'message';
  $('ru-trow').hidden = t !== 'message';
  $('ru-torow').hidden = a !== 'send';
  $('ru-tplrow').hidden = a === 'pause';
}

async function openRules(id) {
  if (!id) return;
  const spec = state.specs[id];
  rulesAgent = isManager(id) ? state.manager.name : (spec ? spec.name : null);
  if (!rulesAgent) { toast("Les règles s'appliquent aux agents de l'équipe : ajoute d'abord cette session à l'équipe.", true); return; }
  $('ru-agent').textContent = '· ' + rulesAgent;
  $('ru-error').hidden = true;
  $('rules-dialog').showModal();
  syncRuleForm();
  renderRules(await window.api.rulesGet());
}

function renderRules(r) {
  $('ru-state').textContent = r.paused ? '⏸ Toutes les règles sont en pause' : 'Règles actives';
  $('ru-pause').textContent = r.paused ? 'Reprendre toutes les règles' : 'Pause globale';
  $('ru-ato').replaceChildren(...r.names.filter(n => n !== rulesAgent).map(n => new Option(n, n)));
  const d = (rule) => {
    const t = rule.trigger, a = rule.action;
    const when = t.type === 'message' ? `envoie un message ${{ contains: 'contenant', startsWith: 'commençant par', regex: 'correspondant à' }[t.mode]} « ${t.text || 'n\'importe lequel'} »` : t.type === 'idle' ? 'devient au repos' : 'rencontre une erreur';
    const then = a.type === 'send' ? `envoyer à <b>${a.to}</b> « ${a.template.slice(0, 80)} »` : a.type === 'notify' ? "prévenir l'utilisateur" : 'tout mettre en pause';
    return `SI <b>${rule.agent}</b> ${when} ALORS ${then}`;
  };
  const items = [];
  r.rules.forEach((rule, i) => {
    if (rule.agent.toLowerCase() !== rulesAgent.toLowerCase()) return;
    const row = el('div', 'ru-item' + (rule.enabled ? '' : ' off'));
    const tx = el('div', 'tx');
    tx.innerHTML = `<span class="muted">n°${i + 1}</span> ` + d(rule).replace(/<(?!\/?b>)/g, '&lt;') + `<br><span class="muted">${rule.count}/${rule.max} déclenchements${rule.enabled ? '' : ' · désactivée'}</span>`;
    const mk = (label, fn, title) => { const b = el('button', null, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', async () => renderRules(await fn())); return b; };
    row.append(tx,
      mk(rule.enabled ? 'Désactiver' : 'Activer', () => window.api.rulesToggle(rule.id, !rule.enabled), 'Réactiver remet le compteur à zéro'),
      mk('↑', () => window.api.rulesMove(rule.id, -1)), mk('↓', () => window.api.rulesMove(rule.id, 1)),
      mk('Tester', () => window.api.rulesSimulate({ type: rule.trigger.type, agent: rule.agent, message: rule.trigger.text || 'message d\'essai' }), 'Simule le déclencheur (l\'action est vraiment exécutée)'),
      mk('Supprimer', () => window.api.rulesDelete(rule.id)));
    items.push(row);
  });
  $('ru-list').replaceChildren(...(items.length ? items : [el('div', 'muted small', 'Aucune règle pour cet agent.')]));
  $('ru-log').replaceChildren(...(r.log.length ? r.log.slice(-40).reverse().map(l => el('div', 'ru-log-row', `${new Date(l.t).toLocaleTimeString()} · règle n°${l.n} · ${l.agent}${l.to ? ' → ' + l.to : ''}${l.count ? ' (' + l.count + ')' : ''} · ${l.result}${l.text ? ' · ' + l.text : ''}`)) : [el('div', 'muted small', 'Rien de déclenché pour le moment.')]));
}

async function submitRule(ev) {
  ev.preventDefault();
  $('ru-error').hidden = true;
  try {
    const type = $('ru-atype').value;
    renderRules(await window.api.rulesSave({
      agent: rulesAgent,
      trigger: { type: $('ru-ttype').value, mode: $('ru-tmode').value, text: $('ru-ttext').value },
      action: { type, to: $('ru-ato').value, template: $('ru-atpl').value },
      max: parseInt($('ru-max').value, 10),
    }));
    $('ru-ttext').value = ''; $('ru-atpl').value = '';
    refreshRulesBadge();
  } catch (e) { $('ru-error').textContent = errText(e); $('ru-error').hidden = false; }
}

// ---------- options de la CLI ----------

let cliData = null;

async function openCli() {
  if (!state.selectedId) return;
  const s = currentSession();
  $('cli-sess').textContent = '· ' + (state.specs[state.selectedId] ? state.specs[state.selectedId].name : (s ? displayTitle(s) : ''));
  $('cli-filter').value = '';
  $('cli-list').textContent = 'Chargement…';
  $('cli-dialog').showModal();
  try {
    cliData = await window.api.cliOptions(state.selectedId);
    $('cli-edit').textContent = cliData.switchable ? 'chaque interrupteur redémarre la session (même conversation) ; les options verrouillées servent au fonctionnement de l\'application' : 'lecture seule pour une session hors équipe';
    renderCli();
  } catch (e) { $('cli-list').textContent = errText(e); }
}

function renderCli() {
  if (!cliData) return;
  const q = $('cli-filter').value.trim().toLowerCase();
  const match = (t) => !q || t.toLowerCase().includes(q);
  const on = cliData.options.filter(o => o.enabled).length;
  const nodes = [el('div', 'cli-sec', `OPTIONS · ${on} activée${on > 1 ? 's' : ''} sur ${cliData.options.length}${cliData.switchable ? '' : ' · lecture seule (session hors équipe)'}`)];
  for (const o of cliData.options.filter(o => match(o.names.join(' ') + ' ' + o.desc)).sort((a, b) => b.enabled - a.enabled)) {
    const r = el('div', 'cli-row' + (o.enabled ? ' on' : ''));
    const left = el('div', 'st');
    let input = null;
    if (cliData.switchable && !o.locked) {
      const b = el('button', 'sw-btn' + (o.enabled ? ' on' : ''), o.enabled ? 'ACTIVÉ' : 'non activé');
      b.type = 'button';
      b.title = o.sensitive ? 'Option sensible : confirmation demandée' : 'Cliquer pour ' + (o.enabled ? 'désactiver' : 'activer');
      b.addEventListener('click', () => setOption(o, !o.enabled, input && input.value));
      left.append(b);
    } else left.textContent = o.enabled ? 'ACTIVÉ' : 'non activé';
    r.append(left);
    const mid = el('div', 'fl', o.names.join(', ') + (o.arg ? ' ' + o.arg : '') + (o.value && !(cliData.switchable && !o.locked) ? '  =  ' + o.value : ''));
    r.append(mid);
    if (cliData.switchable && !o.locked && o.arg) {
      input = el('input'); input.value = o.value || ''; input.placeholder = o.arg; input.title = 'Valeur de l\'option';
      const ctl = el('div', 'ctl'); ctl.append(input); r.append(ctl);
    }
    r.append(el('div', 'ds', o.desc + (o.locked && cliData.switchable ? '  🔒 verrouillée : l\'application en a besoin' : '') + (o.sensitive ? '  ⚠ sensible (permissions)' : '')));
    nodes.push(r);
  }
  const cmds = cliData.commands.filter(c => match(c.name + ' ' + c.desc));
  if (cmds.length) {
    nodes.push(el('div', 'cli-sec', 'SOUS-COMMANDES DE LA CLI'));
    for (const c of cmds) {
      const r = el('div', 'cli-row');
      r.append(el('div', 'st', ''), el('div', 'fl', 'claude ' + c.name), el('div', 'ds', c.desc));
      nodes.push(r);
    }
  }
  $('cli-list').replaceChildren(...nodes);
}

// Demande quand appliquer un changement qui redemarre un agent occupe.
function askWhen(title) {
  return new Promise((resolve) => {
    const d = $('when-dialog');
    $('wh-title').textContent = title;
    const done = (v) => { d.close(); resolve(v); };
    $('wh-now').onclick = () => done('now');
    $('wh-after').onclick = () => done('after');
    $('wh-cancel').onclick = () => done(null);
    d.showModal();
  });
}

async function setOption(o, enable, value) {
  const id = state.selectedId;
  const flag = o.names.find(n => n.startsWith('--')) || o.names[0];
  try {
    const r = await window.api.optionSet(id, flag, enable, value);
    if (r.canceled) return;
    let st = r.state;
    if (st === 'busy') {
      const w = await askWhen("Cet agent travaille : appliquer « " + flag + " » ?");
      if (w) st = (await window.api.agentRestart(id, w)).state; else st = 'later';
    }
    toast({ applied: `${flag} ${enable ? 'activée' : 'désactivée'} : la session a redémarré (même conversation)`, pending: `${flag} enregistrée : appliquée quand l'agent aura fini`, later: `${flag} enregistrée : appliquée au prochain redémarrage`, next: `${flag} enregistrée : appliquée au prochain démarrage`, external: `${flag} enregistrée (session ouverte ailleurs)` }[st] || 'Option enregistrée');
    cliData = await window.api.cliOptions(id);
    renderCli();
  } catch (e) { toast(errText(e), true); }
}

// ---------- file d'attente de messages ----------

const FROM_LABEL = { user: 'toi', rule: 'règle', app: 'appli', tick: 'planificateur' };

function renderQueue() {
  const box = $('queue-panel');
  const id = state.selectedId;
  const q = (id && state.queues[id]) || [];
  box.hidden = !q.length;
  if (!q.length) return;
  const done = (qs) => { state.queues = qs; renderQueue(); renderList(); };
  const btn = (label, title, fn) => { const b = el('button', null, label); b.type = 'button'; b.title = title; b.addEventListener('click', async () => { try { done(await fn()); } catch (e) { toast(errText(e), true); } }); return b; };
  box.replaceChildren(
    el('div', 'q-head', `⏳ File d'attente : ${q.length} message${q.length > 1 ? 's' : ''} (livré${q.length > 1 ? 's' : ''} dans l'ordre quand l'agent a fini sa tâche)`),
    ...q.map((m, i) => {
      const row = el('div', 'q-item' + (m.urgent ? ' urgent' : ''));
      row.append(el('span', 'from', `${i + 1}. ${FROM_LABEL[m.from] || m.from} ·`), el('span', 'tx', m.text.replace(/\s+/g, ' ')));
      row.lastChild.title = m.text;
      row.append(btn('↑', 'Monter', () => window.api.queueMove(id, m.qid, -1)), btn('↓', 'Descendre', () => window.api.queueMove(id, m.qid, 1)),
        btn('Urgent', 'Passer en tête', () => window.api.queueUrgent(id, m.qid)),
        btn('Envoyer maintenant', 'Livrer tout de suite, sans attendre', () => window.api.queueSendNow(id, m.qid)),
        btn('✕', 'Supprimer ce message', () => window.api.queueRemove(id, m.qid)));
      return row;
    }));
}

// ---------- autorisations ----------

async function refreshPerms() {
  try { state.perms = await window.api.permGet(); } catch { return; }
  renderManagerCard(); renderPermBanner(); renderList();
  if ($('perm-dialog').open) renderPermDialog();
}

function alertRow(a) {
  const row = el('div', 'perm-item');
  const tx = el('span', 'tx');
  tx.append(el('b', null, a.agent), document.createTextNode(a.kind === 'prompt' ? ' demande à utiliser ' : ' s\'est vu refuser '), el('code', null, a.tool), document.createTextNode(' '), el('code', null, a.detail.slice(0, 160)));
  if (a.reason) tx.append(document.createTextNode(' — ' + a.reason));
  row.append(tx);
  const mk = (label, d, cls) => { const b = el('button', cls || null, label); b.type = 'button'; b.addEventListener('click', () => decidePerm(a.aid, d)); return b; };
  if (a.kind === 'prompt') row.append(mk('Autoriser cette fois', 'once', 'primary'), mk('Pour la session', 'session'), mk('Toujours pour cet agent', 'always'), mk('Refuser', 'deny', 'danger'));
  else row.append(mk("Autoriser (l'agent est prévenu)", 'once', 'primary'), mk('Ignorer', 'deny'));
  return row;
}

async function decidePerm(aid, d) {
  try { const r = await window.api.permDecide(aid, d); state.perms = { ...state.perms, ...r }; } catch (e) { toast(errText(e), true); }
  renderManagerCard(); renderPermBanner(); renderList();
  if ($('perm-dialog').open) renderPermDialog();
}

function renderPermBanner() {
  const b = $('perm-banner');
  const mine = state.selectedId ? state.perms.alerts.filter(a => a.agentId === state.selectedId) : [];
  b.hidden = !mine.length;
  if (mine.length) b.replaceChildren(el('div', 'q-head', '🔒 Autorisation à décider (l\'agent attend)'), ...mine.map(alertRow));
}

function renderPermDialog() {
  const p = state.perms;
  $('pm-alerts').replaceChildren(...(p.alerts.length ? p.alerts.map(alertRow) : [el('div', 'muted small', 'Aucune demande en attente.')]));
  $('pm-grants').replaceChildren(...(p.grants.length ? p.grants.map((g) => {
    const row = el('div', 'perm-item');
    row.append(el('span', 'tx', `${g.agent} : ${g.tool} · ${g.scope === 'always' ? 'toujours' : 'cette session'} · accordé par ${g.by === 'manager' ? 'le manager' : 'toi'} (${new Date(g.at).toLocaleTimeString()})`));
    const b = el('button', 'danger', 'Révoquer'); b.type = 'button';
    b.addEventListener('click', async () => { state.perms = { ...state.perms, ...(await window.api.permRevoke(g.gid)) }; renderPermDialog(); renderManagerCard(); });
    row.append(b); return row;
  }) : [el('div', 'muted small', 'Aucune autorisation accordée.')]));
  $('pm-log').replaceChildren(...(p.log.length ? p.log.slice(-40).reverse().map(l => el('div', 'log-row', `${new Date(l.t).toLocaleTimeString()} · ${l.agent} · ${l.tool} ${l.detail || ''} · ${l.result} (${l.by === 'manager' ? 'manager' : 'utilisateur'})`)) : [el('div', 'muted small', 'Rien dans le journal.')]));
}

// ---------- planificateur ----------

let tickTimer = null;
async function renderTick() {
  const t = await window.api.tickGet();
  const st = state.settings;
  const hm = (iso) => iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  $('tk-info').textContent = `${t.enabled ? 'Actif' : 'Arrêté'} · dernier tick : ${hm(t.lastAt)} · prochain : ${t.enabled && t.nextAt ? hm(new Date(t.nextAt).toISOString()) : '—'} · ${t.count} tick${t.count > 1 ? 's' : ''} · « rien à faire » de suite : ${t.noop}/${st.tickStopAfter}`;
  $('tk-log').replaceChildren(...(t.log.length ? t.log.slice(-40).reverse().map(l => el('div', 'log-row', `${new Date(l.t).toLocaleTimeString()} · tick n°${l.n} · ${l.result}`)) : [el('div', 'muted small', 'Aucun tick pour le moment.')]));
}

function openTick() {
  const st = state.settings;
  $('tk-on').checked = !!st.tickEnabled; $('tk-min').value = st.tickMinutes; $('tk-stop').value = st.tickStopAfter;
  $('tk-block').checked = st.tickPauseOnBlocked !== false; $('tk-text').value = st.tickText || '';
  $('tk-error').hidden = true;
  $('tick-dialog').showModal();
  renderTick();
  clearInterval(tickTimer); tickTimer = setInterval(() => { if ($('tick-dialog').open) renderTick(); else clearInterval(tickTimer); }, 5000);
}

async function saveTick() {
  try {
    const r = await window.api.setSettings({ tickEnabled: $('tk-on').checked, tickMinutes: parseInt($('tk-min').value, 10), tickStopAfter: parseInt($('tk-stop').value, 10), tickPauseOnBlocked: $('tk-block').checked, tickText: $('tk-text').value });
    state.settings = r.settings;
    toast('Planificateur enregistré');
    renderManagerCard(); renderTick();
  } catch (e) { $('tk-error').textContent = errText(e); $('tk-error').hidden = false; }
}

// ---------- renommer ----------

let renameId = null;

function openRename(id) {
  const s = state.sessions.find(x => x.id === id) || (isManager(id) ? managerStub() : null);
  if (!s) return;
  renameId = id;
  const spec = state.specs[id];
  const live = state.live[id];
  $('rn-name').value = isManager(id) ? state.manager.name : spec ? spec.name : displayTitle(s);
  $('rn-name').maxLength = spec ? 40 : 80;
  $('rn-label').textContent = spec ? 'Nom (c\'est l\'adresse de la session pour les autres sessions)' : 'Nom affiché dans l\'application';
  $('rn-note').textContent = isManager(id)
    ? "Renommer le manager le redémarre. Les workers doivent être fermés : ils connaissent son ancien nom."
    : spec
      ? (live && !spec.adopted ? 'Cette session est ouverte : son nom est fixé à l\'ouverture, ferme-la d\'abord. ' : '')
        + "Le nouveau nom et le prompt mis à jour sont pris à sa prochaine ouverture ; l'ancien nom reste dans l'historique de sa conversation."
      : "Seul l'affichage dans l'application change, la session de Claude Code n'est pas modifiée. Laisse vide pour revenir au titre automatique.";
  $('rn-error').hidden = true;
  $('rename-dialog').showModal();
  $('rn-name').focus();
  $('rn-name').select();
}

async function submitRename(ev) {
  ev.preventDefault();
  if (!renameId) return;
  try {
    const r = await window.api.renameSession(renameId, $('rn-name').value);
    state.titles = r.titles || state.titles;
    state.specs = r.specs || state.specs;
    state.managerName = r.managerName || state.managerName;
    $('rename-dialog').close();
    toast('Session renommée');
    state.listSig = '';
    await refreshList();
  } catch (e) {
    $('rn-error').textContent = errText(e);
    $('rn-error').hidden = false;
  }
}

// ---------- manager : carte, demarrage, reglages ----------

function renderManagerCard() {
  const m = state.manager;
  const live = m.id ? state.live[m.id] : null;
  let cls = 'live';
  let text = 'au repos';
  if (m.external) { cls = 'live'; text = `ouvert dans un terminal · pid ${m.external.pid}`; }
  else if (!m.running) { cls = 'stopped'; text = m.id ? 'arrêté' : 'non démarré'; }
  else if (m.starting && !live) { cls = 'starting'; text = 'démarrage…'; }
  else if (live && live.status === 'busy') { cls = 'busy'; text = 'travaille…'; }
  const badge = $('mc-state');
  badge.className = 'badge ' + cls;
  badge.textContent = text;
  const nOpen = Object.entries(state.specs).filter(([id, sp]) => sp.kind === 'worker' && state.live[id]).length;
  $('mc-sub').textContent = `${m.name} · pleins droits · ${nOpen}${state.settings.maxWorkers > 0 ? '/' + state.settings.maxWorkers : ''} worker${nOpen > 1 ? 's' : ''} ouvert${nOpen > 1 ? 's' : ''}`;
  $('mc-toggle').textContent = m.running ? 'Redémarrer' : 'Démarrer';
  const pa = state.perms.alerts.length;
  $('mc-perms').textContent = pa ? `Autorisations (${pa})` : 'Autorisations';
  $('mc-perms').classList.toggle('danger', pa > 0);
  $('mc-tick').textContent = state.settings.tickEnabled ? `Planificateur ▶ ${state.settings.tickMinutes} min` : 'Planificateur';
  $('mc-toggle').hidden = !!m.external;
  $('mc-stop').hidden = !m.running;
  $('mc-open').disabled = !m.id && !m.running;
  const err = $('mc-error');
  err.hidden = !m.error;
  err.textContent = m.error || '';
  $('manager-card').classList.toggle('selected', isManager(state.selectedId));
}

function onManagerState(info) {
  state.manager = info;
  renderManagerCard();
  updateHead();
}

async function managerAction(fn) {
  try { onManagerState(await fn()); } catch (e) { toast(errText(e), true); }
}

function openSettings() {
  const st = state.settings;
  $('st-mode').value = st.teamMode;
  fillEffortSelect($('st-effort-manager'), '', '');
  fillEffortSelect($('st-effort-worker'), '', '');
  $('st-effort-manager').value = st.managerEffort || '';
  $('st-effort-worker').value = st.workerEffort || '';
  $('st-grant').checked = !!st.managerCanGrant;
  $('st-grant-cats').value = (st.grantCategories || []).join(', ');
  $('st-autostart').checked = st.autostart;
  $('st-follow').checked = st.closeWorkersOnQuit !== false;
  $('st-max').value = st.maxWorkers;
  $('st-model').value = st.managerModel || '';
  $('st-error').hidden = true;
  $('settings-dialog').showModal();
}

async function submitSettings(ev) {
  ev.preventDefault();
  try {
    const r = await window.api.setSettings({
      teamMode: $('st-mode').value,
      autostart: $('st-autostart').checked,
      closeWorkersOnQuit: $('st-follow').checked,
      managerCanGrant: $('st-grant').checked,
      grantCategories: $('st-grant-cats').value.split(',').map(x => x.trim()).filter(Boolean),
      managerEffort: $('st-effort-manager').value,
      workerEffort: $('st-effort-worker').value,
      maxWorkers: parseInt($('st-max').value, 10),
      managerModel: $('st-model').value,
    });
    state.settings = r.settings;
    $('settings-dialog').close();
    renderManagerCard();
    updateHead();
    toast(r.needsRestart ? 'Réglages enregistrés : redémarre le manager pour les appliquer' : 'Réglages enregistrés');
  } catch (e) {
    $('st-error').textContent = errText(e);
    $('st-error').hidden = false;
  }
}

// ---------- nouvelle session (formulaire) ----------

function fillTemplates(selected) {
  const sel = $('nf-template');
  sel.replaceChildren(new Option('— aucun —', ''), ...state.templates.map(t => new Option(t.name, t.name)));
  sel.value = state.templates.some(t => t.name === selected) ? selected : '';
  const t = state.templates.find(x => x.name === sel.value);
  $('nf-del-tpl').hidden = !t || !!t.builtin;
}

function syncKind() {
  $('nf-team-note').hidden = false;
}

function openNewForm() {
  const s = currentSession();
  $('nf-kind').value = 'worker';
  $('nf-name').value = '';
  $('nf-cwd').value = (s && s.cwd) || state.home;
  $('nf-role').value = '';
  $('nf-task').value = '';
  $('nf-tpl-name').value = '';
  fillEffortSelect($('nf-effort'), state.settings.workerEffort, 'Effort : ');
  $('nf-effort').value = '';
  $('nf-error').hidden = true;
  fillTemplates('');
  syncKind();
  $('new-dialog').showModal();
  $('nf-name').focus();
}

async function submitNewForm(ev) {
  ev.preventDefault();
  const btn = $('nf-submit');
  btn.disabled = true;
  $('nf-error').hidden = true;
  try {
    const r = await window.api.createTeamSession({
      kind: $('nf-kind').value,
      name: $('nf-name').value,
      cwd: $('nf-cwd').value,
      role: $('nf-role').value,
      task: $('nf-task').value,
      effort: $('nf-effort').value,
    });
    $('new-dialog').close();
    toast(`Session « ${r.name} » démarrée en arrière-plan`);
    state.listSig = '';
    setTimeout(refreshList, 2500); // le fichier de la session apparait quand elle demarre
  } catch (e) {
    $('nf-error').textContent = errText(e);
    $('nf-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function initNewForm() {
  $('btn-new').addEventListener('click', openNewForm);
  $('nf-cancel').addEventListener('click', () => $('new-dialog').close());
  $('new-form').addEventListener('submit', submitNewForm);
  $('nf-kind').addEventListener('change', syncKind);
  $('nf-browse').addEventListener('click', async () => {
    const dir = await window.api.chooseDir($('nf-cwd').value);
    if (dir) $('nf-cwd').value = dir;
  });
  $('nf-template').addEventListener('change', () => {
    const t = state.templates.find(x => x.name === $('nf-template').value);
    if (t) { $('nf-role').value = t.role; $('nf-tpl-name').value = t.builtin ? '' : t.name; }
    $('nf-del-tpl').hidden = !t || !!t.builtin;
  });
  $('nf-save-tpl').addEventListener('click', async () => {
    try {
      const name = $('nf-tpl-name').value.trim();
      state.templates = await window.api.saveTemplate(name, $('nf-role').value);
      fillTemplates(name);
      toast('Modèle enregistré');
    } catch (e) { $('nf-error').textContent = errText(e); $('nf-error').hidden = false; }
  });
  $('nf-del-tpl').addEventListener('click', async () => {
    try {
      state.templates = await window.api.deleteTemplate($('nf-template').value);
      fillTemplates('');
      toast('Modèle supprimé');
    } catch (e) { $('nf-error').textContent = errText(e); $('nf-error').hidden = false; }
  });
}

function init() {
  try { $('skip-perms').checked = localStorage.getItem('skipPerms') === '1'; } catch { /* stockage indisponible */ }
  $('skip-perms').addEventListener('change', () => {
    try { localStorage.setItem('skipPerms', $('skip-perms').checked ? '1' : '0'); } catch { /* ignore */ }
    updateHead();
  });
  $('composer').addEventListener('submit', (ev) => { ev.preventDefault(); sendReply(); });
  $('reply-input').addEventListener('input', autosize);
  $('reply-input').addEventListener('keydown', (ev) => {
    // Entree envoie, Maj+Entree saute une ligne ; on laisse la composition (accents, IME) tranquille.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendReply(); }
  });
  $('btn-stop').addEventListener('click', () => { if (state.selectedId) window.api.stopReply(state.selectedId); });
  $('btn-delete').addEventListener('click', () => { if (state.selectedId) deleteSession(state.selectedId); });
  $('search').addEventListener('input', renderList);
  $('project-filter').addEventListener('change', renderList);
  $('chat-search').addEventListener('input', applyChatFilter);
  $('show-tools').addEventListener('change', applyToggles);
  $('show-meta').addEventListener('change', applyToggles);
  $('btn-agent-stop').addEventListener('click', async () => { if (!state.selectedId) return; try { state.agents = await window.api.agentStop(state.selectedId); updateHead(); renderList(); toast('Session arrêtée'); } catch (e) { toast(errText(e), true); } });
  initNewForm();
  $('effort-select').addEventListener('change', changeEffort);
  $('btn-cli').addEventListener('click', openCli);
  const themeSel = $('theme-select');
  try { themeSel.value = localStorage.getItem('theme') || 'system'; } catch { /* ignore */ }
  themeSel.addEventListener('change', () => { try { localStorage.setItem('theme', themeSel.value); } catch { /* ignore */ } applyTheme(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  $('mc-perms').addEventListener('click', () => { renderPermDialog(); $('perm-dialog').showModal(); });
  $('pm-close').addEventListener('click', () => $('perm-dialog').close());
  $('mc-tick').addEventListener('click', openTick);
  $('tk-close').addEventListener('click', () => $('tick-dialog').close());
  $('tk-save').addEventListener('click', saveTick);
  $('tk-now').addEventListener('click', async () => { try { const r = await window.api.tickNow(); toast(r.skipped ? 'Tick sauté : ' + r.skipped : r.queued ? 'Tick envoyé (en file : le manager travaille)' : 'Tick envoyé'); renderTick(); } catch (e) { toast(errText(e), true); } });
  window.api.onQueueChanged((q) => { state.queues = q; renderQueue(); renderList(); renderManagerCard(); });
  window.api.onPermChanged(refreshPerms);
  window.api.onTickChanged(() => { if ($('tick-dialog').open) renderTick(); });
  refreshPerms();
  $('btn-rules').addEventListener('click', () => openRules(state.selectedId));
  $('mc-rules').addEventListener('click', async () => { try { const r = await window.api.rulesGet(); await window.api.rulesPause(!r.paused); refreshRulesBadge(); } catch (e) { toast(errText(e), true); } });
  $('ru-close').addEventListener('click', () => $('rules-dialog').close());
  $('ru-pause').addEventListener('click', async () => { const r = await window.api.rulesGet(); renderRules(await window.api.rulesPause(!r.paused)); refreshRulesBadge(); });
  $('ru-ttype').addEventListener('change', syncRuleForm);
  $('ru-atype').addEventListener('change', syncRuleForm);
  $('ru-form').addEventListener('submit', submitRule);
  window.api.onRulesChanged(() => { refreshRulesBadge(); if ($('rules-dialog').open) window.api.rulesGet().then(renderRules); });
  refreshRulesBadge();
  $('cli-close').addEventListener('click', () => $('cli-dialog').close());
  $('cli-filter').addEventListener('input', renderCli);
  $('btn-adopt').addEventListener('click', () => { if (state.selectedId) openAdopt(state.selectedId); });
  $('btn-leave').addEventListener('click', () => { if (state.selectedId) leaveTeam(state.selectedId); });
  $('ad-cancel').addEventListener('click', () => $('adopt-dialog').close());
  $('adopt-form').addEventListener('submit', submitAdopt);
  $('btn-rename').addEventListener('click', () => { if (state.selectedId) openRename(state.selectedId); });
  $('rn-cancel').addEventListener('click', () => $('rename-dialog').close());
  $('rename-form').addEventListener('submit', submitRename);
  $('mc-open').addEventListener('click', () => { if (state.manager.id) openSession(state.manager.id); });
  $('mc-toggle').addEventListener('click', () => managerAction(() => (state.manager.running ? window.api.managerRestart() : window.api.managerStart())));
  $('mc-stop').addEventListener('click', () => managerAction(() => window.api.managerStop()));
  $('mc-settings').addEventListener('click', openSettings);
  $('st-cancel').addEventListener('click', () => $('settings-dialog').close());
  $('settings-form').addEventListener('submit', submitSettings);
  $('btn-copy').addEventListener('click', async () => {
    if (!state.selectedId) return;
    try { await navigator.clipboard.writeText(state.selectedId); toast('Identifiant copié'); } catch { toast('Copie impossible', true); }
  });
  $('btn-bottom').addEventListener('click', () => { const m = $('messages'); m.scrollTop = m.scrollHeight; $('btn-bottom').hidden = true; });
  $('messages').addEventListener('scroll', () => { if (nearBottom()) $('btn-bottom').hidden = true; });

  window.api.onLive((live) => { state.live = live; renderList(); updateHead(); });
  window.api.onAppend(onAppend);
  window.api.onAgentsState((map) => { state.agents = map; renderList(); updateHead(); });
  window.api.onManagerState(onManagerState);
  window.api.onTeamEvent(({ text }) => { toast(text); state.listSig = ''; setTimeout(refreshList, 2500); });
  window.api.onReplyState(onReplyState);
  window.api.onReplyDone(onReplyDone);

  autosize();
  refreshList();
  setInterval(refreshList, 5000);
}

init();
