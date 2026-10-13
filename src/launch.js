'use strict';
// Utilitaires pour lancer `claude`. L'application n'ouvre JAMAIS de terminal : tout tourne en arriere-plan (agent.js, reply.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

function which(cmd) {
  // Une appli lancee depuis le menu n'a pas toujours ~/.local/bin dans son PATH (ou est installe claude).
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), ...extra]) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* suivant */ }
  }
  return null;
}

// Variables qui identifient la session Claude Code PARENTE (dont son adresse de messagerie). Une session
// lancee d'ici ne doit pas en heriter : elle ecrirait aux autres sessions sous la mauvaise identite.
const SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

function cleanEnv(env = process.env) {
  const e = { ...env };
  for (const k of SESSION_ENV) delete e[k];
  return e;
}

// Vrai si le processus est bien un claude : le fichier de session d'un processus plante pourrait pointer
// vers un pid reutilise par un autre programme, qu'on ne doit surtout pas arreter.
function isClaudeProcess(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').toLowerCase().includes('claude');
  } catch { return false; }
}

module.exports = { which, cleanEnv, isClaudeProcess };
