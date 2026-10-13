'use strict';
// Test de bout en bout sur une session JETABLE : reponse, couleur, suppression (corbeille).
// Usage : npx electron scripts/e2e.js --no-sandbox <dossier_sortie> <id_session_jetable>
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
require('../main.js');

const id = process.argv.find(a => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a));
const out = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());
const wait = (ms) => new Promise(r => setTimeout(r, ms));
dialog.showMessageBox = async () => ({ response: 1 }); // confirmations auto-acceptees (test uniquement)

app.whenReady().then(async () => {
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (n) => fs.writeFileSync(path.join(out, n), (await win.webContents.capturePage()).toPNG());
  const res = {};

  await js(`document.querySelector('.row[data-id="${id}"]').click()`);
  await wait(1500);
  res.before = await js(`document.querySelectorAll('#messages .msg').length`);
  await shot('e1-ouverte.png');

  // reponse
  await js(`(() => { const t = document.getElementById('reply-input'); t.value = 'Réponds uniquement par le mot: trois'; t.dispatchEvent(new Event('input')); document.getElementById('btn-send').click(); })()`);
  await wait(1500);
  res.duringStatus = await js(`document.getElementById('composer-status').hidden ? 'cache' : document.getElementById('composer-status').textContent`);
  res.inputDisabledDuring = await js(`document.getElementById('reply-input').disabled`);
  await shot('e2-envoi.png');
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    if (await js(`document.getElementById('composer-status').hidden`)) break;
  }
  await wait(1500);
  res.after = await js(`document.querySelectorAll('#messages .msg').length`);
  res.lastAssistant = await js(`[...document.querySelectorAll('#messages .msg.assistant .text')].pop()?.textContent`);
  res.toast = await js(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`);
  await shot('e3-reponse.png');

  // couleur
  await js(`document.querySelectorAll('#swatches .sw')[3].click()`);
  await wait(800);
  res.color = await js(`getComputedStyle(document.querySelector('.row[data-id="${id}"]')).getPropertyValue('--c')`);
  await shot('e4-couleur.png');

  // suppression
  await js(`document.getElementById('btn-delete').click()`);
  await wait(2500);
  res.rowGone = await js(`!document.querySelector('.row[data-id="${id}"]')`);
  res.toastDelete = await js(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`);
  res.chatHidden = await js(`document.getElementById('chat').hidden`);
  await shot('e5-supprimee.png');
  console.log(JSON.stringify(res, null, 1));
  app.quit();
});
