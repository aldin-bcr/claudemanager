'use strict';
// Transforme les lignes JSONL d'une session en elements d'affichage, et suit le fichier en direct.
const fs = require('fs');
const { isNoise } = require('./sessions');

const MAX_RESULT = 4000;   // taille max d'un resultat d'outil envoye a l'interface
const MAX_INPUT = 1500;    // idem pour les parametres d'un appel d'outil

function clip(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + `\n... (${s.length - n} caracteres masques)` : s;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  }
  return '';
}

// Convertit une entree JSONL en 0..n elements { kind, ... }.
function toItems(o) {
  const items = [];
  if (o.type !== 'user' && o.type !== 'assistant') return items;
  const m = o.message;
  if (!m) return items;
  const base = { uuid: o.uuid, ts: o.timestamp, side: !!o.isSidechain };

  if (o.type === 'user') {
    if (typeof m.content === 'string') {
      items.push({ ...base, kind: 'user', text: m.content, meta: !!o.isMeta || isNoise(m.content) });
      return items;
    }
    for (const b of m.content || []) {
      if (b.type === 'text') {
        items.push({ ...base, kind: 'user', text: b.text, meta: !!o.isMeta || isNoise(b.text) });
      } else if (b.type === 'tool_result') {
        items.push({ ...base, kind: 'tool_result', toolUseId: b.tool_use_id, error: !!b.is_error, text: clip(resultText(b.content), MAX_RESULT) });
      } else if (b.type === 'image') {
        items.push({ ...base, kind: 'user', text: '[image]', meta: true });
      }
    }
    return items;
  }

  for (const b of m.content || []) {
    if (b.type === 'text' && b.text && b.text.trim()) {
      items.push({ ...base, kind: 'assistant', text: b.text, model: m.model });
    } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
      items.push({ ...base, kind: 'thinking', text: b.thinking });
    } else if (b.type === 'tool_use') {
      const inp = b.input || {};
      const summary = [inp.command, inp.file_path, inp.path, inp.pattern, inp.url, inp.query, inp.description, inp.skill, inp.prompt]
        .find(v => typeof v === 'string' && v) || '';
      const send = b.name === 'SendMessage' && b.input ? { sendTo: String(b.input.to || ''), sendText: String(b.input.message || '').slice(0, 20000) } : {};
      items.push({ ...base, ...send, kind: 'tool_use', toolUseId: b.id, name: b.name, summary: summary.replace(/\s+/g, ' ').slice(0, 160), input: clip(b.input, MAX_INPUT) });
    }
  }
  return items;
}

// Lit tout le fichier et renvoie { items, offset }. Les resultats sont rattaches par l'interface.
function readAll(file) {
  const text = fs.readFileSync(file, 'utf8');
  const items = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) break; // derniere ligne incomplete : on la relira plus tard
    const line = text.slice(start, end);
    start = end + 1;
    if (!line) continue;
    try { items.push(...toItems(JSON.parse(line))); } catch { /* ligne invalide */ }
  }
  return { items, offset: Buffer.byteLength(text.slice(0, start), 'utf8') };
}

// Suivi en direct : appelle onItems(nouveauxElements) a chaque ajout dans le fichier.
function follow(file, offset, onItems) {
  let pos = offset;
  let busy = false;
  let again = false;
  let rest = '';

  const pump = () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const size = fs.statSync(file).size;
      if (size < pos) { pos = 0; rest = ''; }       // fichier reecrit
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          pos = size;
          const chunk = rest + buf.toString('utf8');
          const parts = chunk.split('\n');
          rest = parts.pop();                       // fin potentiellement incomplete
          const items = [];
          for (const l of parts) {
            if (!l) continue;
            try { items.push(...toItems(JSON.parse(l))); } catch { /* ignore */ }
          }
          if (items.length) onItems(items);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch { /* fichier disparu */ }
    busy = false;
    if (again) { again = false; pump(); }
  };

  const watcher = fs.watch(file, { persistent: false }, pump);
  const timer = setInterval(pump, 2000); // filet de securite si fs.watch rate un evenement
  return () => { watcher.close(); clearInterval(timer); };
}

module.exports = { readAll, follow, toItems };
