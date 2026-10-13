'use strict';
// Test complet : demarrage automatique du manager, chat, creation d'un worker demandee par le manager.
// Usage : XDG_CONFIG_HOME=<dossier> TRACE=<fichier> PATH=<stub>:$PATH npx electron scripts/e2e-manager.js --no-sandbox <sortie> <dossier_travail>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
require('../main.js');

const dirs = process.argv.filter((a, i) => i > 1 && !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());
const [out, work] = dirs;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, step = 1000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(step); } return false; };

app.whenReady().then(async () => {
  await wait(3000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (n) => fs.writeFileSync(path.join(out, n), (await win.webContents.capturePage()).toPNG());
  const res = {};

  res.managerReady = await until(() => js(`(async () => { const r = await window.api.list(); const m = r.manager; return !!(m && m.running && r.live[m.id]); })()`), 45000);
  await wait(1500);
  res.openedChat = await js(`document.getElementById('chat').classList.contains('is-manager')`);
  res.cardState = await js(`document.getElementById('mc-state').textContent`);
  res.cardSub = await js(`document.getElementById('mc-sub').textContent`);
  res.placeholder = await js(`document.querySelector('#messages .placeholder')?.textContent || null`);
  await shot('m1-demarrage.png');

  // l'utilisateur ecrit au manager depuis le chat
  const ask = `Crée un worker nommé w-test dans le dossier ${work}. Rôle : « ne touche à aucun fichier existant ». Tâche : « écrire bonjour dans bonjour.txt ». Ne fais rien d'autre, puis dis-moi en une phrase ce qui s'est passé.`;
  await js(`(() => { const t = document.getElementById('reply-input'); t.value = ${JSON.stringify(ask)}; t.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await wait(1500);
  res.sentError = await js(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`);
  res.workerLaunched = await until(() => fs.existsSync(process.env.TRACE), 120000, 2000);
  await wait(6000);
  res.reply = await js(`[...document.querySelectorAll('#messages .msg.assistant .text')].pop()?.textContent || null`);
  res.teamSection = await js(`document.querySelector('.row.sect.team')?.textContent || null`);
  await shot('m2-apres-demande.png');
  console.log(JSON.stringify(res, null, 1));
  app.quit();
});
