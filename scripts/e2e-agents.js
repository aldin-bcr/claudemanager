'use strict';
// Test ISOLE (faux dossier personnel, faux `claude`, aucun jeton) : plus AUCUN terminal, workers en arriere-plan.
//  phase 1 : conversion d'un ancien terminal, creation par le formulaire, creation par le manager, message, arret, relance, fermeture
//  phase 2 (--phase=start) : reouverture au demarrage
// Usage : HOME=<…/fakehome> STUB_DIR=<dossier> PATH=<dossier_stubs>:$PATH npx electron scripts/e2e-agents.js --no-sandbox [--phase=start]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = os.homedir();
if (!HOME.endsWith('fakehome')) { console.error('refus : HOME doit etre un faux dossier personnel (…/fakehome)'); process.exit(2); }
const STUB_DIR = process.env.STUB_DIR;
const phase2 = process.argv.includes('--phase=start');
const cfg = path.join(HOME, '.config', 'claude-sessions');
const uid = () => crypto.randomUUID();
let fx;

if (!phase2) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(STUB_DIR, { recursive: true });
  for (const f of fs.readdirSync(STUB_DIR)) if (/\.(args|stdin)$|^TERMINAL/.test(f)) fs.rmSync(path.join(STUB_DIR, f));
  const T1 = uid();
  const cwd = path.join(HOME, 'projets', 'ancien');
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - 600000).toISOString();
  fs.writeFileSync(path.join(dir, T1 + '.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'Bonjour' }, cwd, sessionId: T1, timestamp: t },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Salut' }] }, cwd, sessionId: T1, timestamp: t },
    { type: 'ai-title', aiTitle: 'Ancien worker laisse dans un terminal', sessionId: T1 },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  // ancien terminal : un processus "claude" ouvert (visible comme session vivante), au repos
  const p = spawn('bash', ['-c', 'sleep 200; true', 'claude-fake-ancien'], { stdio: 'ignore', detached: true });
  p.unref();
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', p.pid + '.json'), JSON.stringify({ pid: p.pid, sessionId: T1, cwd, name: 'ancien', status: 'idle', kind: 'interactive', updatedAt: Date.now() }));
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'meta.json'), JSON.stringify({
    colors: {}, titles: {}, templates: [], managerName: 'manager', manager: null, reopen: [],
    specs: { [T1]: { kind: 'worker', name: 'ancien', managerName: 'manager', cwd, role: '', task: '', mode: 'bypass', createdAt: new Date().toISOString() } },
    settings: { teamMode: 'bypass', autostart: false, maxWorkers: 0, managerModel: '', closeWorkersOnQuit: true },
  }));
  fx = { T1, pid: p.pid, cwd };
  fs.writeFileSync(path.join(HOME, 'fx.json'), JSON.stringify(fx));
} else {
  fx = JSON.parse(fs.readFileSync(path.join(HOME, 'fx.json'), 'utf8'));
}

const { app, BrowserWindow } = require('electron');
require('../main.js');
// Une erreur dans le scenario ne doit jamais laisser le test suspendu.
process.on('unhandledRejection', (err) => { console.log('ERREUR DU TEST :', err && err.message); app.exit(1); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runs = () => fs.readdirSync(STUB_DIR).filter(f => f.endsWith('.args')).map(f => {
  const base = f.slice(0, -5);
  const rd = (ext) => { try { return fs.readFileSync(path.join(STUB_DIR, base + ext), 'utf8'); } catch { return ''; } };
  return { pid: Number(base), args: rd('.args').trim(), stdin: rd('.stdin') };
}).sort((a, b) => a.pid - b.pid);

app.whenReady().then(async () => {
  const res = {};
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const out = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());

  if (phase2) {
    await wait(9000);
    res.rouverts = runs().filter(r => r.args.includes('--resume ' + fx.T1)).length;
    res.terminal = fs.existsSync(path.join(STUB_DIR, 'TERMINAL-CALLED'));
    console.log(JSON.stringify(res, null, 1));
    app.quit();
    return;
  }

  await wait(7000);
  // 1. ancien terminal : arrete et repris en arriere-plan
  res.ancienTerminalFerme = !alive(fx.pid);
  res.ancienRepris = runs().filter(r => r.args.includes('--resume ' + fx.T1) && r.args.includes('stream-json')).length;

  // 2. creation par le formulaire
  await js(`document.getElementById('btn-new').click()`); await wait(400);
  await js(`(() => { const set = (i, v) => { document.getElementById(i).value = v; };
    set('nf-kind', 'worker'); set('nf-name', 'delta'); set('nf-cwd', ${JSON.stringify(fx.cwd)}); set('nf-role', 'Pas de push.'); set('nf-task', 'Fais la mission X.'); })()`);
  res.formulaireModeVisible = await js(`!!document.getElementById('nf-mode')`);
  res.noteFormulaire = await js(`document.getElementById('nf-team-note').textContent.slice(0, 60)`);
  await js(`document.getElementById('new-form').requestSubmit()`); await wait(1800);
  const delta = runs().find(r => r.args.includes('-n delta'));
  res.delta = delta && { arriereplan: delta.args.includes('-p --input-format stream-json'), idImpose: /--session-id [0-9a-f-]{36}/.test(delta.args), hook: delta.args.includes('only-manager.py'), bypass: delta.args.includes('--dangerously-skip-permissions'), tache: delta.stdin.includes('Fais la mission X.'), sansTerminal: !delta.args.includes('--') || delta.args.indexOf(' -- ') < 0 };
  res.toast = await js(`document.getElementById('toast').textContent`);

  // 3. creation demandee par le manager (fichier)
  const reqDir = path.join(cfg, 'requests'), respDir = path.join(cfg, 'responses');
  fs.writeFileSync(path.join(reqDir, 'creer-epsilon.json'), JSON.stringify({ action: 'create', name: 'epsilon', cwd: fx.cwd, role: 'Lecture seule.', task: 'Analyse Y.' }));
  for (let i = 0; i < 20 && !fs.existsSync(path.join(respDir, 'creer-epsilon.json')); i++) await wait(500);
  res.reponseManager = JSON.parse(fs.readFileSync(path.join(respDir, 'creer-epsilon.json'), 'utf8')).message;
  await wait(800);
  const eps = runs().find(r => r.args.includes('-n epsilon'));
  res.epsilon = eps && { tache: eps.stdin.includes('Analyse Y.'), arriereplan: eps.args.includes('stream-json') };

  // 4. message, arret, relance (le message relance la session)
  const specs = (await js(`window.api.list()`)).specs;
  const deltaId = Object.keys(specs).find(k => specs[k].name === 'delta');
  await js(`window.api.agentSend(${JSON.stringify(deltaId)}, 'Message deux')`); await wait(500);
  res.messageRecu = runs().find(r => r.args.includes('-n delta')).stdin.includes('Message deux');
  const avantArret = runs().find(r => r.args.includes('-n delta')).pid;
  await js(`window.api.agentStop(${JSON.stringify(deltaId)})`); await wait(800);
  res.arrete = !alive(avantArret);
  res.etatApresArret = (await js(`window.api.list()`)).agents[deltaId].running;
  await js(`window.api.agentSend(${JSON.stringify(deltaId)}, 'Message trois')`); await wait(1500);
  res.relance = runs().filter(r => r.args.includes('-n delta') && r.stdin.includes('Message trois')).length;
  res.agentsEnCours = Object.entries((await js(`window.api.list()`)).agents).filter(([, a]) => a.running).length;

  // 5. effort de reflexion : le choix est enregistre et la session redemarre (meme session) avec --effort
  const nbAvant = runs().filter(r => r.args.includes('-n delta')).length;
  const r1 = await js(`window.api.setEffort(${JSON.stringify(deltaId)}, 'high')`);
  await wait(2500);
  const apres = runs().filter(r => r.args.includes('-n delta'));
  const dernier = apres[apres.length - 1];
  res.effort = { etat: r1.state, enregistre: r1.efforts[deltaId], redemarre: apres.length === nbAvant + 1, drapeau: dernier.args.includes('--effort high'), ancienArrete: !alive(apres[apres.length - 2].pid) };
  const r2 = await js(`window.api.setEffort(${JSON.stringify(deltaId)}, '')`);
  await wait(2500);
  const fin = runs().filter(r => r.args.includes('-n delta'));
  res.effortRetire = { etat: r2.state, plusDeDrapeau: !fin[fin.length - 1].args.includes('--effort'), enregistre: r2.efforts[deltaId] === undefined };
  res.effortInvalide = await js(`window.api.setEffort(${JSON.stringify(deltaId)}, 'nimporte').then(() => 'accepte', e => e.message)`);
  // l'effort par defaut des workers est applique aux nouveaux workers
  await js(`window.api.setSettings({ teamMode: 'bypass', autostart: false, maxWorkers: 0, managerModel: '', closeWorkersOnQuit: true, managerEffort: '', workerEffort: 'low' })`);
  fs.writeFileSync(path.join(reqDir, 'creer-zeta.json'), JSON.stringify({ action: 'create', name: 'zeta', cwd: fx.cwd, task: 'Z.', effort: 'xhigh' }));
  fs.writeFileSync(path.join(reqDir, 'creer-eta.json'), JSON.stringify({ action: 'create', name: 'eta', cwd: fx.cwd, task: 'E.' }));
  await wait(4000);
  const zeta = runs().find(r => r.args.includes('-n zeta')), eta = runs().find(r => r.args.includes('-n eta'));
  res.effortALaCreation = { zeta_choisi_par_le_manager: zeta && zeta.args.includes('--effort xhigh'), eta_defaut_des_workers: eta && eta.args.includes('--effort low') };

  // 6. regles : boucle collecteur -> postulant, retour, garde-fous (maximum, boucle sans progres, pause)
  const lastStdin = (n) => runs().filter(r => r.args.includes('-n ' + n)).map(r => r.stdin).join('');
  const rl = async (m, ...a) => js(`window.api.${m}(${a.map(x => JSON.stringify(x)).join(',')})`);
  const sim = (agent, message, type = 'message') => rl('rulesSimulate', { type, agent, message });
  await rl('rulesSave', { agent: 'delta', trigger: { type: 'message', mode: 'startsWith', text: '[delta] OFFRE' }, action: { type: 'send', to: 'epsilon', template: 'Postule : {message}' }, max: 2 });
  await rl('rulesSave', { agent: 'epsilon', trigger: { type: 'message', mode: 'startsWith', text: 'POSTULÉ' }, action: { type: 'send', to: 'delta', template: 'POSTULÉ' }, max: 10 });
  await sim('delta', '[delta] OFFRE 1'); await wait(500);
  res.regle_aller = lastStdin('epsilon').includes('Postule : [delta] OFFRE 1');
  await sim('epsilon', 'POSTULÉ'); await wait(500);
  res.regle_retour = lastStdin('delta').includes('POSTULÉ');
  await sim('delta', '[delta] OFFRE 2'); await sim('delta', '[delta] OFFRE 3'); await wait(500);
  let st = await rl('rulesGet');
  res.regle_maximum = { declenchements: st.rules[0].count, desactivee: st.rules[0].enabled === false, offre3_non_envoyee: !lastStdin('epsilon').includes('OFFRE 3') };
  await rl('rulesToggle', st.rules[0].id, true);
  await sim('delta', '[delta] OFFRE 4'); await wait(300);
  st = await rl('rulesGet');
  res.regle_reactivee_repart_a_zero = st.rules[0].count === 1;
  await rl('rulesPause', true);
  await sim('delta', '[delta] OFFRE 5'); await wait(400);
  res.regle_pause_globale = !lastStdin('epsilon').includes('OFFRE 5');
  await rl('rulesPause', false);
  await rl('rulesSave', { agent: 'epsilon', trigger: { type: 'idle' }, action: { type: 'send', to: 'delta', template: 'encore' }, max: 50 });
  for (let i = 0; i < 4; i++) await sim('epsilon', 'x', 'idle');
  await wait(400);
  st = await rl('rulesGet');
  res.regle_boucle_sans_progres = st.rules[2].enabled === false && /répété/.test(st.log[st.log.length - 1].result);
  res.journal = st.log.length > 5;
  res.noRule_inconnue = await js(`window.api.rulesSave({ agent: 'delta', trigger: { type: 'idle' }, action: { type: 'send', to: 'personne', template: 'x' } }).then(() => 'accepte', e => e.message)`);

  // 7. file d'attente : un agent occupe n'est pas interrompu, FIFO, urgent, supprimer
  const agentPid = async (id) => (await js(`window.api.list()`)).agents[id].pid;
  const setLive = async (id, name, status) => { const pid = await agentPid(id); fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.claude', 'sessions', pid + '.json'), JSON.stringify({ pid, sessionId: id, name, status, kind: 'interactive', updatedAt: Date.now() })); };
  const stdinOf = (n) => runs().filter(r => r.args.includes('-n ' + n)).map(r => r.stdin).join('');
  await rl('agentSend', deltaId, 'warmup'); await wait(600);
  await setLive(deltaId, 'delta', 'busy'); await wait(2500);
  const q1 = await js(`window.api.agentSend(${JSON.stringify(deltaId)}, 'Q1')`);
  const q2 = await js(`window.api.agentSend(${JSON.stringify(deltaId)}, 'Q2')`);
  const q3 = await js(`window.api.agentSend(${JSON.stringify(deltaId)}, 'Q3')`);
  await wait(500);
  let qq = (await rl('queueGet'))[deltaId];
  res.file = { misEnFile: q1.queued && q2.queued && q3.queued, pasLivre: !/Q1|Q2|Q3/.test(stdinOf('delta')), longueur: qq.length };
  await rl('queueMove', deltaId, qq[2].qid, -1);                       // Q1 Q3 Q2
  await rl('queueUrgent', deltaId, (await rl('queueGet'))[deltaId][2].qid);  // Q2 Q1 Q3
  await rl('queueRemove', deltaId, (await rl('queueGet'))[deltaId][2].qid);  // Q2 Q1
  qq = (await rl('queueGet'))[deltaId];
  res.file.ordre = qq.map(x => x.text).join(',');
  await rl('queueSendNow', deltaId, qq[1].qid);                         // Q1 envoye tout de suite
  res.file.envoiImmediat = stdinOf('delta').includes('Q1');
  await setLive(deltaId, 'delta', 'idle'); await wait(5000);
  res.file.livreAuRepos = stdinOf('delta').includes('Q2') && ((await rl('queueGet'))[deltaId] || []).length === 0;
  res.file.supprimeJamaisLivre = !stdinOf('delta').includes('Q3');
  res.file.ordreLivraison = stdinOf('delta').indexOf('Q1') < stdinOf('delta').indexOf('Q2');

  // 8. autorisations : demande d'un agent -> alerte -> decision ; le manager n'accorde que si l'utilisateur l'a active
  process.env.STUB_CTRL = '1';
  fs.writeFileSync(path.join(reqDir, 'creer-theta.json'), JSON.stringify({ action: 'create', name: 'theta', cwd: fx.cwd, task: 'T.' }));
  await wait(2500);
  let pm = await rl('permGet');
  const alertA = pm.alerts.find(a => a.agent === 'theta');
  res.autorisation = { alerte: !!alertA && alertA.tool === 'Bash' && alertA.detail === 'ls /tmp', manager_peut: pm.canGrant };
  fs.writeFileSync(path.join(reqDir, 'grant-1.json'), JSON.stringify({ action: 'grant', alert: alertA.aid }));
  await wait(2500);
  res.autorisation.manager_refuse_par_defaut = /pas le droit/.test(JSON.parse(fs.readFileSync(path.join(respDir, 'grant-1.json'), 'utf8')).error || '');
  await rl('permDecide', alertA.aid, 'session'); await wait(800);
  res.autorisation.reponse_envoyee_a_l_agent = stdinOf('theta').includes('"behavior":"allow"');
  pm = await rl('permGet');
  res.autorisation.octroi_session = pm.grants.length === 1 && pm.grants[0].tool === 'Bash' && pm.grants[0].scope === 'session';
  await rl('permRevoke', pm.grants[0].gid);
  res.autorisation.revocation = (await rl('permGet')).grants.length === 0;
  // le manager peut accorder SI l'utilisateur l'active, et seulement pour une categorie autorisee
  await js(`window.api.setSettings({ teamMode: 'bypass', autostart: false, maxWorkers: 0, managerModel: '', closeWorkersOnQuit: true, managerEffort: '', workerEffort: '', managerCanGrant: true, grantCategories: ['Write'] })`);
  fs.writeFileSync(path.join(reqDir, 'creer-iota.json'), JSON.stringify({ action: 'create', name: 'iota', cwd: fx.cwd, task: 'I.' }));
  await wait(2500);
  const alertB = (await rl('permGet')).alerts.find(a => a.agent === 'iota');
  fs.writeFileSync(path.join(reqDir, 'grant-2.json'), JSON.stringify({ action: 'grant', alert: alertB.aid }));
  await wait(2500);
  res.autorisation.categorie_refusee = /catégorie/.test(JSON.parse(fs.readFileSync(path.join(respDir, 'grant-2.json'), 'utf8')).error || '');
  await js(`window.api.setSettings({ teamMode: 'bypass', autostart: false, maxWorkers: 0, managerModel: '', closeWorkersOnQuit: true, managerEffort: '', workerEffort: '', managerCanGrant: true, grantCategories: ['Bash'] })`);
  fs.writeFileSync(path.join(reqDir, 'grant-3.json'), JSON.stringify({ action: 'grant', alert: alertB.aid, scope: 'once' }));
  await wait(2500);
  res.autorisation.manager_accorde = JSON.parse(fs.readFileSync(path.join(respDir, 'grant-3.json'), 'utf8')).ok === true && stdinOf('iota').includes('"behavior":"allow"');
  res.autorisation.journal = (await rl('permGet')).log.some(l => l.by === 'manager');
  delete process.env.STUB_CTRL;

  // 9. options activables : desactiver --chrome / activer --model pour un agent = redemarrage ; verrouillees refusees
  const before = runs().filter(r => r.args.includes('-n delta')).length;
  const o1 = await rl('optionSet', deltaId, '--chrome', false);
  await wait(2500);
  const lastD = runs().filter(r => r.args.includes('-n delta')); const ld = lastD[lastD.length - 1];
  res.options = { etat: o1.state, redemarre: lastD.length === before + 1, chromeRetire: !ld.args.includes('--chrome') };
  await rl('optionSet', deltaId, '--model', true, 'haiku'); await wait(2500);
  const l2 = runs().filter(r => r.args.includes('-n delta')); res.options.modele = /--model haiku/.test(l2[l2.length - 1].args);
  const co = await rl('cliOptions', deltaId);
  res.options.etatAffiche = { chrome: co.options.find(o => o.names.includes('--chrome')).enabled, modele: co.options.find(o => o.names.includes('--model')).value, verrou: co.options.find(o => o.names.includes('--verbose')).locked, sensible: co.options.find(o => o.names.includes('--dangerously-skip-permissions')).sensitive };
  res.options.verrouillee = await js(`window.api.optionSet(${JSON.stringify(deltaId)}, '--settings', false).then(() => 'accepte', e => e.message.replace(/^.*Error: /, ''))`);
  await rl('optionSet', deltaId, '--chrome', true); await rl('optionSet', deltaId, '--model', false); await wait(2000);

  // 11. planificateur : tick envoye au manager (ici un faux agent), saute quand rien ne change, file si manager occupe, arret apres « rien a faire »
  await js(`window.api.managerStart()`); await wait(1500);
  const mid = (await js(`window.api.list()`)).manager.id;
  const mstdin = () => runs().filter(r => r.args.includes('-n manager')).map(r => r.stdin).join('');
  const t1 = await rl('tickNow');
  await wait(600);
  res.tick = { envoye: t1.sent === true && /\[TICK AUTO \d\d:\d\d\]/.test(mstdin()) };
  // manager occupe : le tick part en file, et un seul
  const mpid = (await js(`window.api.list()`)).manager.pid;
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', mpid + '.json'), JSON.stringify({ pid: mpid, sessionId: mid, name: 'manager', status: 'busy', kind: 'interactive', updatedAt: Date.now() }));
  await wait(2500);
  const t2 = await rl('tickNow'); const t3 = await rl('tickNow');
  res.tick.enFile = t2.queued === true && /déjà/.test(t3.skipped || '');
  const nTicks = (mstdin().match(/TICK AUTO/g) || []).length;
  res.tick.pasLivreAuManagerOccupe = nTicks === 1;
  fs.writeFileSync(path.join(HOME, '.claude', 'sessions', mpid + '.json'), JSON.stringify({ pid: mpid, sessionId: mid, name: 'manager', status: 'idle', kind: 'interactive', updatedAt: Date.now() }));
  await wait(5000);
  res.tick.livreAuRepos = (mstdin().match(/TICK AUTO/g) || []).length === 2;
  const tg = await rl('tickGet');
  res.tick.compteur = tg.count === 2 && tg.log.length >= 3;
  res.tick.reglagesParDefaut = { actif: tg.enabled, minutes: tg.minutes };

  // 10. un message a une session ordinaire n'ouvre rien non plus ; le terminal piege ne doit JAMAIS avoir ete appele
  res.terminal = fs.existsSync(path.join(STUB_DIR, 'TERMINAL-CALLED'));
  if (out) fs.writeFileSync(path.join(out, 'agents-liste.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(HOME, 'apres-phase1.json'), JSON.stringify({ pids: runs().map(r => r.pid), ancien: fx.pid }));
  console.log(JSON.stringify(res, null, 1));
  app.quit();
});
