'use strict';
// Outil de test : lance l'appli, ouvre une session, enregistre des captures PNG.
// Usage : npx electron scripts/shot.js --no-sandbox <dossier_sortie> [id_session]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
require('../main.js');

const out = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && a !== '.' && fs.existsSync(a)) || '.';
const wantId = process.argv.find(a => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0];
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  const js = (code) => win.webContents.executeJavaScript(code);

  await shot('1-liste.png');
  const click = wantId
    ? `document.querySelector('.row[data-id="${wantId}"]').click()`
    : `document.querySelectorAll('.row')[1].click()`;
  await js(click);
  await wait(2500);
  await shot('2-chat.png');
  console.log(JSON.stringify(await js(`({
    rows: document.querySelectorAll('.row').length,
    msgs: document.querySelectorAll('#messages > *').length,
    tools: document.querySelectorAll('details.tool').length,
    title: document.getElementById('chat-title').textContent,
    meta: document.getElementById('chat-meta').textContent,
    resumeDisabled: document.getElementById('btn-resume').disabled,
    err: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent
  })`)));
  app.quit();
});
