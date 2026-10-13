'use strict';
// Regles « SI condition ALORS action » entre agents : validation, correspondance, modeles. Pur (sans Electron),
// l'execution (envoi des messages, journal, garde-fous) est dans main.js.
const TRIGGERS = ['message', 'idle', 'error'];
const MODES = ['contains', 'startsWith', 'regex'];
const ACTIONS = ['send', 'notify', 'pause'];
const MAX_TEXT = 500;
const MAX_TEMPLATE = 2000;
const MAX_ITER_LIMIT = 1000;
const DEFAULT_MAX = 20;
const SAME_LIMIT = 3; // meme message produit N fois de suite par une regle : boucle sans progres

function validateRule(raw, names) {
  if (!raw || typeof raw !== 'object') throw new Error('Règle invalide');
  const lower = new Set(names.map(n => n.toLowerCase()));
  const agent = String(raw.agent || '');
  if (!lower.has(agent.toLowerCase())) throw new Error(`Agent inconnu : « ${agent} »`);
  const t = raw.trigger || {};
  const a = raw.action || {};
  if (!TRIGGERS.includes(t.type)) throw new Error('Déclencheur inconnu');
  const trigger = { type: t.type, mode: 'contains', text: '' };
  if (t.type === 'message') {
    if (!MODES.includes(t.mode)) throw new Error('Type de comparaison inconnu');
    trigger.mode = t.mode;
    trigger.text = String(t.text == null ? '' : t.text).slice(0, MAX_TEXT);
    if (t.mode === 'regex') {
      if (!trigger.text) throw new Error('Expression régulière vide');
      try { new RegExp(trigger.text, 'iu'); } catch (e) { throw new Error('Expression régulière invalide : ' + e.message); }
    }
  }
  if (!ACTIONS.includes(a.type)) throw new Error('Action inconnue');
  const action = { type: a.type, to: '', template: '' };
  if (a.type === 'send') {
    action.to = String(a.to || '');
    if (!lower.has(action.to.toLowerCase())) throw new Error(`Destinataire inconnu : « ${action.to} »`);
    action.template = String(a.template == null ? '' : a.template).slice(0, MAX_TEMPLATE);
    if (!action.template.trim()) throw new Error('Le message à envoyer est vide');
  } else if (a.type === 'notify') {
    action.template = String(a.template == null ? '' : a.template).slice(0, MAX_TEMPLATE) || '{agent} : {message}';
  }
  // Condition d'arret obligatoire : un nombre maximum de declenchements, toujours fini.
  const max = raw.max == null || Number.isNaN(raw.max) ? DEFAULT_MAX : raw.max;
  if (!Number.isInteger(max) || max < 1 || max > MAX_ITER_LIMIT) throw new Error(`Le maximum de déclenchements doit être entre 1 et ${MAX_ITER_LIMIT}`);
  return { agent, trigger, action, max, enabled: raw.enabled !== false };
}

function matches(rule, ev) {
  if (!rule.enabled || rule.trigger.type !== ev.type || rule.agent.toLowerCase() !== String(ev.agent).toLowerCase()) return false;
  if (ev.type !== 'message') return true;
  const text = String(ev.message || '').slice(0, 20000);
  const q = rule.trigger.text;
  if (!q) return true;
  if (rule.trigger.mode === 'startsWith') return text.trimStart().toLowerCase().startsWith(q.toLowerCase());
  if (rule.trigger.mode === 'contains') return text.toLowerCase().includes(q.toLowerCase());
  try { return new RegExp(q, 'iu').test(text.slice(0, 5000)); } catch { return false; }
}

function render(template, ev, to) {
  return String(template).replace(/\{message\}/g, ev.message || '').replace(/\{agent\}/g, ev.agent || '').replace(/\{to\}/g, to || '');
}

function describe(rule) {
  const t = rule.trigger;
  const when = t.type === 'message'
    ? `message ${{ contains: 'contenant', startsWith: 'commençant par', regex: 'correspondant à' }[t.mode]} « ${t.text || '(n\'importe lequel)'} »`
    : t.type === 'idle' ? 'devient au repos' : 'erreur';
  const a = rule.action;
  const then = a.type === 'send' ? `envoyer à ${a.to} : « ${a.template.slice(0, 60)} »` : a.type === 'notify' ? 'prévenir l\'utilisateur' : 'tout mettre en pause';
  return `SI ${rule.agent} : ${when} ALORS ${then}`;
}

module.exports = { TRIGGERS, MODES, ACTIONS, DEFAULT_MAX, SAME_LIMIT, validateRule, matches, render, describe };
