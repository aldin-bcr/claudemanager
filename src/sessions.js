'use strict';
// Lecture des sessions Claude Code : liste (~/.claude/projects) et etat live (~/.claude/sessions).
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK = 64 * 1024;

function readHead(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const len = Math.min(size, total);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, total - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // ligne coupee au milieu
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* ligne partielle */ }
  }
  return out;
}

// Texte brut d'un message utilisateur (string ou blocs).
function userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function isNoise(text) {
  const t = text.trim();
  return !t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted') || t.startsWith('[Application Claude Sessions]');
}

// Resume d'une session sans lire tout le fichier (certains font > 30 Mo).
function summarize(file, projectDir) {
  const st = fs.statSync(file);
  const id = path.basename(file, '.jsonl');
  const head = parseLines(readHead(file, CHUNK), false);
  const tail = parseLines(readTail(file, CHUNK), st.size > CHUNK);

  let cwd = null;
  let firstPrompt = '';
  let startedAt = null;
  for (const o of head) {
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!startedAt && o.timestamp) startedAt = o.timestamp;
    if (!firstPrompt && o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const t = userText(o.message);
      if (!isNoise(t)) firstPrompt = t.trim().replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  let title = '';
  let custom = '';   // nom donne par /rename dans Claude Code : prioritaire sur le titre automatique
  let lastTs = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const o = tail[i];
    if (!custom && o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    if (!title && o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (!lastTs && o.timestamp) lastTs = o.timestamp;
  }
  if (!custom) {
    const c = head.find(o => o.type === 'custom-title' && o.customTitle);
    if (c) custom = c.customTitle;
  }
  if (!title) {
    // ai-title absent de la fin : on cherche dans la tete
    const h = head.find(o => o.type === 'ai-title' && o.aiTitle);
    if (h) title = h.aiTitle;
  }
  if (!cwd) cwd = tail.map(o => o.cwd).filter(Boolean).pop() || null;

  // Dernier texte de Claude : permet de voir l'avancement d'une session sans ouvrir son chat.
  let lastAssistant = '';
  for (let i = tail.length - 1; i >= 0 && !lastAssistant; i--) {
    const o = tail[i];
    if (o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
    const t = o.message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
    if (t) lastAssistant = t.replace(/\s+/g, ' ').slice(0, 240);
  }

  return {
    id,
    project: projectDir,
    cwd,
    title: custom || title || firstPrompt.slice(0, 80) || '(sans titre)',
    firstPrompt,
    startedAt,
    lastActivity: lastTs || st.mtime.toISOString(),
    lastAssistant,
    mtimeMs: st.mtimeMs,
    size: st.size,
    file,
  };
}

const cache = new Map(); // fichier -> { mtimeMs, size, summary } : on ne relit que ce qui a change

function cachedSummary(file, projectDir) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const summary = summarize(file, projectDir);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

function listSessions() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      if (!UUID_RE.test(path.basename(f, '.jsonl'))) continue;
      try { out.push(cachedSummary(path.join(dir, f), d.name)); } catch { /* fichier illisible */ }
    }
  }
  // Tri sur le dernier vrai message : la date du fichier bouge aussi pour des metadonnees.
  out.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return out;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Sessions vivantes : un fichier <pid>.json par processus claude en cours.
function liveSessions() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(LIVE_DIR).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8'));
      if (!j.sessionId || !pidAlive(j.pid)) continue;
      out[j.sessionId] = {
        pid: j.pid,
        status: j.status || 'unknown',
        name: j.name || null,
        cwd: j.cwd || null,
        kind: j.kind || null,
        startedAt: j.startedAt || null,
        updatedAt: j.updatedAt || null,
      };
    } catch { /* fichier en cours d'ecriture */ }
  }
  return out;
}

function findSessionFile(id) {
  if (!UUID_RE.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d.name, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Tout ce qui appartient a une session : transcription, dossier compagnon, historique de fichiers, env.
// Les chemins sont construits a partir d'un UUID valide dans des dossiers connus (pas de ../ possible).
function sessionPaths(id) {
  const file = findSessionFile(id);
  if (!file) return [];
  const candidates = [
    file,
    path.join(path.dirname(file), id),
    path.join(CLAUDE_DIR, 'file-history', id),
    path.join(CLAUDE_DIR, 'session-env', id),
  ];
  return candidates.filter(p => fs.existsSync(p));
}

function forget(file) { cache.delete(file); }

module.exports = { PROJECTS_DIR, UUID_RE, listSessions, liveSessions, findSessionFile, sessionPaths, forget, userText, isNoise };
