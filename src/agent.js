'use strict';
// Un agent = un processus `claude` persistant SANS terminal : entrees / sorties stream-json.
// C'est ce qui evite toute fenetre (un terminal interactif demande « trust this folder », pas ce mode) et ce qui
// permet de le reveiller par un message d'une autre session (verifie : une session au repos se reveille).
// La duree de vie d'un agent est celle de l'appli ; au redemarrage on reprend la meme session (--resume).
const fs = require('fs');
const { spawn } = require('child_process');
const { which, cleanEnv } = require('./launch');
const { findSessionFile } = require('./sessions');

const MAX_RESTARTS = 3;          // sorties inattendues rapprochees tolerees avant d'abandonner
const RESTART_WINDOW_MS = 120000;
const STOP_GRACE_MS = 3000;

class Agent {
  // { id, cwd, flags, resume, firstMessage, onChange, restartDelayMs }
  //   flags : options d'equipe (nom, role, permissions, controle des workers) ; resume : reprendre la session `id`.
  constructor(o) {
    this.id = o.id;
    this.cwd = o.cwd;
    this.flags = o.flags || [];
    this.resume = !!o.resume;
    this.firstMessage = o.firstMessage || '';
    this.onChange = o.onChange || (() => {});
    this.restartDelayMs = o.restartDelayMs == null ? 1500 : o.restartDelayMs;
    this.onPermission = o.onPermission || null; // (demande) => Promise<reponse> : l'appli repond aux demandes d'autorisation
    this.child = null;
    this.stopping = false;
    this.crashes = [];
    this.state = { running: false, starting: false, pid: null, error: null };
  }

  status() { return { ...this.state }; }
  resetCrashes() { this.crashes = []; }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.status());
  }

  start() {
    if (this.child) return this.status();
    if (!fs.statSync(this.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      this._set({ running: false, starting: false, error: 'Dossier introuvable : ' + this.cwd });
      return this.status();
    }
    const claude = which('claude');
    if (!claude) {
      this._set({ running: false, starting: false, error: 'Commande claude introuvable' });
      return this.status();
    }
    this.stopping = false;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...(this.onPermission ? ['--permission-prompt-tool', 'stdio'] : []), ...this.flags, this.resume ? '--resume' : '--session-id', this.id];
    const p = spawn(claude, args, { cwd: this.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = p;

    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      // Il faut vider le tuyau (sinon claude se bloque) ; on ne garde que les erreurs de tour.
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (l.includes('"type":"control_request"')) { this._control(l); continue; }
        if (!l.includes('"type":"result"')) continue;
        try {
          const e = JSON.parse(l);
          if (e.is_error) this._set({ error: String(e.result || 'Erreur de l\'agent').slice(0, 300) });
          else if (this.state.error) this._set({ error: null });
        } catch { /* ligne partielle */ }
      }
      if (buf.length > 1e6) buf = '';
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdin.on('error', () => {});
    p.on('error', (e) => this._set({ error: e.message }));
    p.on('exit', (code, signal) => {
      if (this.child === p) this.child = null;
      const wasStopping = this.stopping;
      this._set({ running: false, starting: false, pid: null });
      if (wasStopping) return;
      // Sortie inattendue : on relance en reprenant la session, sauf si ca boucle.
      const now = Date.now();
      this.crashes = this.crashes.filter(t => now - t < RESTART_WINDOW_MS);
      this.crashes.push(now);
      const detail = (err.trim() || `code ${code}${signal ? ', signal ' + signal : ''}`).slice(-300);
      if (this.crashes.length > MAX_RESTARTS) {
        this._set({ error: "L'agent s'arrête en boucle : " + detail });
        return;
      }
      this._set({ error: "L'agent s'est arrêté (" + detail + '), redémarrage…' });
      setTimeout(() => {
        if (this.child || this.stopping) return;
        this.resume = !!findSessionFile(this.id);
        this.firstMessage = '';
        this.start();
      }, this.restartDelayMs);
    });

    if (this.firstMessage) { this._write(this.firstMessage); this.firstMessage = ''; }
    this._set({ running: true, starting: true, pid: p.pid, error: null });
    // Joignable (ListAgents) quelques secondes apres le lancement, meme sans message.
    setTimeout(() => { if (this.child === p) this._set({ starting: false }); }, 6000);
    return this.status();
  }

  // Demande d'autorisation d'un outil : l'agent attend la reponse de l'appli (autoriser / refuser).
  _control(line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type !== 'control_request' || !e.request || e.request.subtype !== 'can_use_tool' || !this.onPermission) return;
    const reply = (response) => {
      if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response } }) + '\n');
    };
    Promise.resolve().then(() => this.onPermission(e.request)).then(reply, () => reply({ behavior: 'deny', message: 'Erreur de l\'application' }));
  }

  _write(text) {
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  }

  send(text) {
    if (!this.child || !this.child.stdin.writable) throw new Error("L'agent est arrêté");
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message vide');
    if (text.length > 200000) throw new Error('Message trop long');
    this._write(text);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.child) return resolve();
      const p = this.child;
      this.stopping = true;
      p.once('exit', () => resolve());
      try { p.stdin.end(); } catch { /* deja ferme */ }
      setTimeout(() => { if (this.child === p) p.kill('SIGTERM'); }, STOP_GRACE_MS);
      setTimeout(() => resolve(), STOP_GRACE_MS + 2000);
    });
  }
}

module.exports = { Agent };
