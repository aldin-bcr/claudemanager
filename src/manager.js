'use strict';
// Le manager : un agent (voir agent.js) lance par l'appli. L'utilisateur lui ecrit depuis l'appli ; les workers le
// reveillent avec SendMessage. Ce module garde une seule instance et expose une API simple a main.js.
const { Agent } = require('./agent');

let agent = null;
const STOPPED = { running: false, starting: false, pid: null, error: null };

function status() { return agent ? agent.status() : { ...STOPPED }; }

// { id, cwd, flags, resume } : flags = options d'equipe ; resume = reprendre la session id.
function start(opts, notify) {
  if (agent && agent.status().running) return agent.status();
  agent = new Agent({ ...opts, onChange: notify || (() => {}) });
  return agent.start();
}

function send(text) {
  if (!agent) throw new Error('Le manager est arrêté');
  agent.send(text);
}

function stop() { return agent ? agent.stop() : Promise.resolve(); }

function resetCrashes() { if (agent) agent.resetCrashes(); }

module.exports = { start, send, stop, status, resetCrashes };
