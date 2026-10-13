'use strict';
// Options de la CLI `claude` lues depuis `claude --help` (jamais une liste figee) et etat pour une session donnee.
const { execFile } = require('child_process');
const { which, cleanEnv } = require('./launch');

let cache = null; // { at, data }

function parseHelp(text) {
  const options = [];
  const commands = [];
  let section = '';
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^(Options|Commands|Arguments):/.test(line)) { section = line.replace(':', ''); cur = null; continue; }
    if (!section || section === 'Arguments') continue;
    const m = line.match(/^ {2}(\S.*?)(?: {2,}(.*))?$/);
    if (m && !/^ {3,}/.test(line)) {
      const head = m[1];
      if (section === 'Options' && head.startsWith('-')) {
        const names = head.split(/[ ,]+/).filter(t => t.startsWith('-'));
        const arg = (head.match(/[<\[][^>\]]*[>\]]/) || [''])[0];
        cur = { names, arg, desc: m[2] || '' };
        options.push(cur);
      } else if (section === 'Commands') {
        cur = { name: head.split(' ')[0], desc: m[2] || '' };
        commands.push(cur);
      } else cur = null;
    } else if (cur && /^ {10,}\S/.test(line)) {
      cur.desc = (cur.desc + ' ' + line.trim()).trim();
    }
  }
  return { options, commands };
}

function loadHelp() {
  if (cache && Date.now() - cache.at < 3600e3) return Promise.resolve(cache.data);
  return new Promise((resolve, reject) => {
    const bin = which('claude');
    if (!bin) return reject(new Error('Commande claude introuvable'));
    execFile(bin, ['--help'], { env: cleanEnv(), timeout: 15000, maxBuffer: 2e6 }, (err, out) => {
      if (err && !out) return reject(err);
      const data = parseHelp(out);
      cache = { at: Date.now(), data };
      resolve(data);
    });
  });
}

// active : tableau d'arguments reellement passes a claude pour cette session.
function withState(data, active) {
  const used = new Map();
  active.forEach((a, i) => { if (a.startsWith('-')) used.set(a, active[i + 1] && !active[i + 1].startsWith('-') ? active[i + 1] : true); });
  const options = data.options.map((o) => {
    const hit = o.names.find(n => used.has(n));
    let value = hit ? used.get(hit) : null;
    if (typeof value === 'string' && value.length > 60) value = value.slice(0, 60) + '…';
    return { ...o, enabled: !!hit, value: value === true ? null : value };
  });
  return { options, commands: data.commands };
}

// L'option prend-elle une valeur ? (d'apres le dernier `claude --help` lu ; sinon : on suppose que oui si ce n'est pas un booleen connu)
function takesValue(flag) {
  const o = cache && cache.data.options.find(x => x.names.includes(flag));
  return o ? !!o.arg : false;
}

module.exports = { parseHelp, loadHelp, withState, takesValue };
