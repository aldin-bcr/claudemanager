# claudemanager
Application multi-agents pour Claude Code : une équipe d'agents pilotée par un manager, pour gérer plusieurs projets en parallèle, conçue pour l'offre Claude de base.

Une application multi-agents construite autour de l'écosystème Claude Code, pensée pour fonctionner avec une offre Claude de base.

claudemanager réunit une équipe d'agents et un manager d'équipe pour mener plusieurs projets en simultané. Tu parles au manager depuis une seule fenêtre ; il crée les agents, leur répartit le travail, suit leur avancement et te rend compte.

Principe

- Un manager démarre avec l'application. C'est ton unique interlocuteur : il découpe tes demandes en tâches et les confie à des agents.
- Des agents (workers), chacun dédié à une tâche ou à un projet. Ils travaillent en arrière-plan, sans terminal, et ne communiquent qu'avec le manager, qui relaie entre eux.
- Plusieurs projets à la fois : chaque agent a son dossier, son rôle et son état, visibles d'un coup d'œil.

Fonctionnalités

- Chat avec le manager et avec chaque agent, suivi en direct de leur travail.
- Création, renommage, arrêt et reprise des agents, qui conservent leur mémoire entre deux lancements.
- Réglage de l'effort de réflexion et des permissions, par agent et par défaut.
- Rattachement d'une session Claude Code existante à l'équipe.
- Compatible avec Claude in Chrome, et construit uniquement sur les outils natifs de Claude Code.

Prérequis

Claude Code installé et connecté à un compte Claude, sur Linux.
