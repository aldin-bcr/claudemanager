'use strict';
// Repond a une session sans terminal : `claude -p --resume <id>` ajoute le tour a la meme session.
// La reponse n'est pas lue ici : elle arrive dans l'interface par le suivi du fichier .jsonl.
const fs = require('fs');
const { spawn } = require('child_process');
const { UUID_RE } = require('./sessions');
const { which, cleanEnv } = require('./launch');
const { EFFORTS } = require('./team');

const MAX_TEXT = 200000;
const running = new Map(); // id -> processus en cours

function isRunning(id) { return running.has(id); }
function runningIds() { return [...running.keys()]; }

// onDone({ id, ok, error }) est appele une fois, a la fin du processus.
// flags : options d'equipe de la session (nom, role, permissions), a repasser a chaque reponse.
function send({ id, cwd, text, skipPermissions, flags, effort }, onDone) {
  if (!UUID_RE.test(id)) throw new Error('Identifiant de session invalide');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Message vide');
  if (text.length > MAX_TEXT) throw new Error('Message trop long');
  if (running.has(id)) throw new Error('Une reponse est deja en cours pour cette session');
  if (!cwd || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Dossier introuvable : ' + cwd);

  const claude = which('claude');
  if (!claude) throw new Error('Commande claude introuvable');
  const args = ['-p', '--chrome', ...(flags || []), ...(EFFORTS.includes(effort) ? ['--effort', effort] : []), '--resume', id, '--output-format', 'json'];
  if (!flags && skipPermissions) args.push('--dangerously-skip-permissions');

  // Le message passe par l'entree standard : pas de limite d'arguments, pas d'ambiguite avec les options.
  const child = spawn(claude, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  running.set(id, child);

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { if (out.length < 2e6) out += d; });
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  child.stdin.on('error', () => {});
  child.stdin.end(text);

  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    running.delete(id);
    onDone({ id, ok: !error, error: error || null });
  };
  child.on('error', (e) => finish(e.message));
  child.on('close', (code, signal) => {
    if (signal) return finish('Reponse interrompue');
    let res = null;
    try { res = JSON.parse(out.trim().split('\n').pop()); } catch { /* sortie non JSON */ }
    if (res && res.is_error) return finish(String(res.result || 'Erreur de Claude').slice(0, 500));
    if (code !== 0) return finish((err.trim() || 'claude a quitte avec le code ' + code).slice(-500));
    finish(null);
  });
}

function stop(id) {
  const child = running.get(id);
  if (child) child.kill('SIGTERM');
}

function stopAll() { for (const c of running.values()) c.kill('SIGTERM'); }

module.exports = { send, stop, stopAll, isRunning, runningIds };
