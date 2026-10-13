# claudemanager

**Application multi-agents construite autour de l'écosystème Claude Code, pensée pour une offre Claude de base.**

claudemanager réunit une **équipe d'agents** et un **manager d'équipe** pour mener **plusieurs projets en simultané**. Tu parles au manager depuis une seule fenêtre : il crée les agents, répartit le travail, suit leur avancement et te rend compte.

- Manager lancé automatiquement, agents en arrière-plan (aucun terminal), qui ne parlent qu'au manager.
- Règles « SI … ALORS … » entre agents, file d'attente de messages, planificateur, autorisations décidées depuis l'appli.
- Effort de réflexion et options de la CLI réglables par agent, thème clair / sombre.
- Uniquement les outils natifs de Claude Code ; Linux, Claude Code installé et connecté.

Lancer : `npm install` puis `npm start`. Tests : `node src/selftest.js`.

---
## Notes techniques

Fenetre desktop (Electron) pour gerer les sessions Claude Code : liste + recherche, chat, reponse, suivi en direct, couleurs, suppression, equipe manager/workers.

## Lancer
- Compile : `dist/linux-unpacked/claude-sessions`
- Dev : `npm start`
- Verif des donnees sans interface : `npm run test:data`

## Compiler
`npm run build` -> `dist/linux-unpacked/` (dossier executable) et `dist/claudemanager-*.AppImage`
(l'AppImage demande `libfuse2t64`, sinon : `APPIMAGE_EXTRACT_AND_RUN=1 ./Claude\ Sessions-*.AppImage`).

## Comment ca marche
- Sessions : `~/.claude/projects/<projet>/<id>.jsonl` (titre = entree `ai-title`, tri sur le dernier message).
- Etat live : `~/.claude/sessions/<pid>.json` (status `busy`/`idle`, pid vivant), relu toutes les 2 s.
- Chat en direct : `fs.watch` + lecture des octets ajoutes au `.jsonl`.
- Reponse : `claude -p --resume <id> --output-format json` (message sur stdin, meme session, meme .jsonl). Reservee aux sessions ORDINAIRES ; refusee si la session est deja ouverte ailleurs (2 processus corrompraient la transcription). Sans terminal pour confirmer, les outils soumis a autorisation sont refuses sauf case "sans confirmations".
- Suppression : `shell.trashItem` (corbeille, recuperable) du .jsonl + dossier compagnon + `file-history/<id>` + `session-env/<id>`, apres confirmation native. Jamais de suppression definitive sans 2e confirmation. Refusee si la session est ouverte.
- Couleurs : une couleur auto par session (hash de l'id), modifiable par pastilles, stockee dans `~/.config/claude-sessions/meta.json` ; pastille du dossier = couleur du dossier.
- **AUCUN TERMINAL, JAMAIS** : l'appli n'ouvre aucune fenetre de terminal (un `claude` interactif demande « trust this folder » a chaque dossier
  neuf ; le mode ci-dessous ne le demande pas). Garde-fou : `selftest.js` echoue si le code contient un lancement de terminal.
- **Agents** (`src/agent.js`) : tout ce que l'appli demarre est un processus `claude -p --input-format stream-json --output-format stream-json`
  PERSISTANT, sans terminal : on lui ecrit des messages JSON sur son entree standard, il reste vivant (et se reveille quand une autre session lui ecrit,
  verifie). Sa session est reprise (`--resume`) a chaque demarrage ; il redemarre seul s'il plante (3 max / 2 min). Ce sont des enfants de l'appli.
- **Manager** (architecture en etoile) : au demarrage l'appli lance UN agent manager (`src/manager.js`) avec TOUS les droits (bypass).
  L'utilisateur lui parle dans le chat de l'appli (carte violette en haut de la barre laterale).
  Reglages (engrenage) : permissions des WORKERS (defaut `bypass` : un message n'est livre qu'entre sessions de la meme classe de permissions et
  personne ne peut approuver sans terminal), lancement automatique du manager, nombre max de workers (0 = illimite), modele du manager.
  Cwd du manager : `~/.config/claude-sessions/manager`.
- **Workers** : bouton "+ Nouvelle session" (Worker ou Session simple) ou demande du manager = un agent en arriere-plan. Lancement :
  `claude -p --input-format stream-json ... -n <nom> <permissions> --settings <hook> --append-system-prompt <role + protocole> --session-id <uuid>`,
  la tache part comme PREMIER MESSAGE sur l'entree standard. L'utilisateur leur ecrit depuis l'appli (le message demarre une session arretee).
  Le NOM d'une session est son adresse (`ListAgents` / `SendMessage`). Un worker ne parle QU'au manager : regle dans son prompt ET controle technique
  (hook PreToolUse sur SendMessage, `~/.config/claude-sessions/hooks/only-manager.py`, refuse tout autre destinataire, meme en mode sans confirmations).
  Le manager relaie entre workers (regle de son prompt).
- **Le manager active des sessions** : il ecrit `~/.config/claude-sessions/requests/<nom>.json` (`{"action":"create","name","cwd","role","task"}` ou
  `{"action":"resume","name"}`) ; l'appli valide (memes regles que le formulaire, mode d'equipe impose, limite de workers, 10 demandes/min), demarre l'agent,
  ecrit `responses/<nom>.json` ET renvoie le resultat au manager dans un message `[Application Claude Sessions] ...` (affiche comme message systeme).
- **Fermeture / reouverture des workers** : les agents sont des enfants de l'appli, ils s'arretent avec elle (fermeture propre de leur entree).
  Si un worker TRAVAILLE, une confirmation s'affiche. Si le reglage "Rouvrir au demarrage..." est actif (defaut), la liste des workers ouverts est gardee dans
  `meta.json` (`reopen`) et ils repartent au demarrage suivant, apres le manager (`--resume`) ; un worker interrompu en plein travail recoit un message
  `[Application Claude Sessions]` pour reprendre, un worker au repos est simplement rouvert.
  Anciens terminaux : au demarrage, un worker d'equipe encore ouvert dans un TERMINAL (ancienne version) est arrete (sa fenetre se ferme) puis repris en
  arriere-plan ; s'il travaille encore, on n'y touche pas. Les sessions que l'utilisateur ouvre lui-meme et RATTACHE a l'equipe ne sont jamais fermees.
- Role/prompt/tache : `~/.config/claude-sessions/meta.json`, REPASSE a chaque reprise et chaque reponse. Le mode d'une session d'equipe suit toujours le reglage.
- Registre : `~/.config/claude-sessions/registry.json` (nom, tache, etat busy/idle/closed, dernier message), lu par le manager (inclut les sessions fermees).
  Les transcriptions ne sont pas exposees au manager.
- **Effort de reflexion** (option `--effort` de la CLI : low, medium, high, xhigh, max) : selecteur « Effort » dans l'en-tete de CHAQUE session
  (stocke dans `meta.json` : `efforts`), defauts pour le manager et pour les workers dans les reglages (engrenage), choix a la creation d'un worker
  (formulaire ou champ `effort` d'une demande du manager). Une session en arriere-plan est redemarree (meme session, meme contexte) pour l'appliquer,
  des qu'elle est au repos (jamais en plein travail : le changement attend la fin du tour) ; une session ordinaire l'applique a sa prochaine reponse.
- **Regles « SI ... ALORS ... »** (`src/rules.js`, bouton « Regles » de chaque agent, pause globale sur la carte du manager) : l'appli lit les `SendMessage`
  ecrits par un agent dans sa conversation (ou son passage au repos / une erreur) et execute l'action SANS le contexte du manager : envoyer un message a un
  agent (modele avec `{message}` `{agent}` `{to}`), prevenir l'utilisateur, ou tout mettre en pause. Garde-fous : maximum de declenchements OBLIGATOIRE par
  regle (defaut 20, reactiver remet a zero), meme message repete 3 fois = regle desactivee, pause globale, journal (200 derniers, `rules-log.json`), jamais de
  changement de permissions (une regle n'envoie que des messages). Le manager recoit une copie de chaque declenchement et peut deposer
  `{"action":"rules","op":"pause_all"|"resume_all"|"disable","name":"<n>"}`. Regles dans `meta.json` (`rules`, `rulesPaused`), conservees au redemarrage.
- **File d'attente** (une par agent, FIFO, `meta.queues`, persistante) : un agent occupe n'est jamais interrompu. Tout message (utilisateur, regle, manager, appli,
  tick) attend son passage au repos ; panneau dans le chat (monter/descendre, urgent, envoyer maintenant, supprimer), badge « en file » sur la ligne.
  « Urgent » livre tout de suite (Claude l'injecte a son prochain appel d'outil, sans couper son travail).
- **Autorisations** : les agents sont lances avec `--permission-prompt-tool stdio` ; leurs demandes arrivent a l'appli (`control_request`) et l'agent ATTEND ta reponse :
  autoriser cette fois / pour la session / toujours (par outil et par agent) / refuser. Les refus du classificateur du mode automatique (lus dans la conversation)
  donnent une alerte : « Autoriser » envoie a l'agent une autorisation explicite. Badge sur la ligne, banniere dans le chat, fenetre « Autorisations » (journal, revocation).
  Le manager n'accorde (`{"action":"grant","alert":"<id>","scope":"once|session"}`) que si l'UTILISATEUR l'a active dans les reglages, pour les categories qu'il a
  choisies, jamais a lui-meme, jamais « toujours » ; chaque octroi est journalise et notifie. Limite : un manager aux pleins droits peut techniquement modifier les
  fichiers de l'appli, ces regles protegent d'un comportement normal, pas d'un manager hostile.
- **Options de la CLI** (bouton « Options ») : interrupteur par option pour le manager et les agents (valeur saisissable) ; redemarrage de l'agent (meme conversation),
  « maintenant » ou « apres sa tache » s'il travaille. Verrouillees : celles dont l'appli a besoin (entrees/sorties, identite, hook, prompts, effort). Sensibles
  (permissions) : confirmation native + journal.
- **Planificateur** (bouton « Planificateur », ARRETE par defaut) : tick regulier au manager (3 min, texte modifiable), par la file d'attente, jamais empile, saute si
  rien n'a change et qu'aucun agent n'est au repos, pause si un agent attend une autorisation, s'arrete apres N reponses « rien a faire », respecte la pause globale.
- **Theme** clair / sombre / systeme (selecteur dans la barre laterale, memorise).
- Une seule instance de l'appli (verrou) : deux instances lanceraient deux managers.
- Environnement : les variables `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, etc. de la session parente sont RETIREES
  avant tout lancement (sinon une session lancee depuis une session Claude heriterait de son identite de messagerie).
- Limites : messages entre sessions seulement si les deux sont vivantes et de la meme classe de permissions (bypass / non-bypass).
- `--no-sandbox` est impose (script de lancement ajoute par `scripts/afterPack.js`), l'appli ne charge que ses fichiers locaux.

## Fichiers
`main.js` fenetre + IPC · `preload.js` pont securise · `src/sessions.js` liste/live · `src/transcript.js` chat + suivi ·
`src/launch.js` (which, cleanEnv, isClaudeProcess) · `src/agent.js` agents en arriere-plan · `renderer/` interface · `src/team.js` equipe (prompts, arguments, registre, hook) · `src/manager.js` manager persistant · `src/requests.js` demandes du manager · `src/reply.js` reponses · `scripts/shot.js` captures de test · `scripts/e2e.js` test reponse/couleur/suppression sur une session JETABLE · `scripts/e2e-agents.js` AUCUN terminal : faux claude + faux gnome-terminal piege, creation/envoi/arret/reouverture (isole, HOME fictif) · `scripts/e2e-adopt.js` rattacher/renommer/disposition (isole)· `scripts/e2e-shutdown.js` fermeture/reouverture des workers (vrais claude persistants, modele haiku ; supprimer ensuite les sessions de test) · `scripts/e2e-manager.js` (VRAIS claude : le manager ET le worker qu'il cree ; passer par un wrapper `claude` qui ajoute `--model haiku`) demarrage du manager + creation d'un worker par le manager (vrai claude, modele haiku, ~quelques centimes ; supprimer ensuite la session de test dans ~/.claude/projects/).
