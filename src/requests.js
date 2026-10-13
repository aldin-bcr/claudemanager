'use strict';
// Demandes du manager : il depose requests/<nom>.json (avec son outil Write), l'appli les traite et repond
// dans responses/<nom>.json. Fichiers simples, aucune ouverture reseau.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 100000;
const MAX_PER_MINUTE = 10;     // garde-fou contre une boucle du manager
const SETTLE_MS = 1500;        // un fichier tout juste ecrit peut etre incomplet : on laisse le temps de finir

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// dirs : { requests, responses }. handle(rawRequest) -> objet de reponse (peut etre asynchrone, peut lever).
// onResult(fichier, reponse) : appele apres chaque reponse (l'appli s'en sert pour prevenir le manager).
function start(dirs, handle, onResult) {
  fs.mkdirSync(dirs.requests, { recursive: true });
  fs.mkdirSync(dirs.responses, { recursive: true });
  const inFlight = new Set();
  let recent = [];

  const respond = (file, payload) => {
    try { writeAtomic(path.join(dirs.responses, file), JSON.stringify(payload, null, 2)); } catch { /* disque plein, etc. */ }
    try { fs.rmSync(path.join(dirs.requests, file), { force: true }); } catch { /* deja supprime */ }
    try { if (onResult) onResult(file, payload); } catch { /* le retour au manager est facultatif */ }
  };

  const process1 = async (file) => {
    const full = path.join(dirs.requests, file);
    let st;
    try { st = fs.statSync(full); } catch { return; }
    if (st.size > MAX_BYTES) return respond(file, { ok: false, error: 'Demande trop volumineuse' });
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
    let raw = null;
    try { raw = JSON.parse(text); } catch {
      if (Date.now() - st.mtimeMs < SETTLE_MS) return;   // peut-etre en cours d'ecriture : on reessaiera
      return respond(file, { ok: false, error: 'JSON invalide' });
    }
    const now = Date.now();
    recent = recent.filter(t => now - t < 60000);
    if (recent.length >= MAX_PER_MINUTE) return respond(file, { ok: false, error: 'Trop de demandes en une minute, réessaie plus tard' });
    recent.push(now);
    try {
      respond(file, await handle(raw));
    } catch (e) {
      respond(file, { ok: false, error: String(e.message || e).slice(0, 500) });
    }
  };

  const scan = () => {
    let files = [];
    try { files = fs.readdirSync(dirs.requests).filter(f => f.endsWith('.json') && !f.startsWith('.')); } catch { return; }
    for (const f of files) {
      if (inFlight.has(f)) continue;
      inFlight.add(f);
      process1(f).finally(() => inFlight.delete(f));
    }
  };

  let watcher = null;
  try { watcher = fs.watch(dirs.requests, { persistent: false }, () => setTimeout(scan, 400)); } catch { /* le minuteur suffit */ }
  const timer = setInterval(scan, 2000);
  scan();
  return () => { if (watcher) watcher.close(); clearInterval(timer); };
}

module.exports = { start };
