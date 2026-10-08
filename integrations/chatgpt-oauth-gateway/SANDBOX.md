# AFFiNE local : OAuth et embeddings

Le sandbox utilise le code officiel AFFiNE v0.27.4 sans modification des clients ni du backend. Les huit modifications expérimentales du sélecteur Copilot ont été retirées après validation du routage BYOK. Le panneau de la gateway configure ses profils BYOK par les mutations GraphQL existantes.

## Utilisation

- Interface AFFiNE : http://127.0.0.1:33080/
- Modèle de génération : **Settings → Workspace → Integrations → AI BYOK (Beta)**. Le sandbox dispose de profils serveur séparés **ChatGPT OAuth** (Luna), **ChatGPT OAuth Sol** et **ChatGPT OAuth 6.1 Sol**. Leur ordre contrôle la priorité pour le workspace ; Copilot reste sur **Auto**. Le profil embeddings est indépendant.
- Modèles d’embeddings et modèle par défaut : http://127.0.0.1:43187/ → **Modèles utilisés dans AFFiNE local**.
- Le panneau externe peut aussi appliquer un modèle par défaut. Attention : il réécrit le premier profil visant le gateway et réactive son catalogue ; pour conserver les profils séparés ci-dessus, privilégier les paramètres BYOK officiels. Il ne supprime pas les autres profils.
- Le menu affiche le catalogue du compte connecté. L'accès effectif reste soumis aux autorisations et limites OpenAI.
- Embeddings : Qwen3 Embedding 0.6B, local, 1024 dimensions. Le menu propose les modèles d'embeddings installés et indique leur compatibilité.
- Pour essayer BGE M3, le choisir dans **Ajouter un modèle local**, télécharger, puis le sélectionner pour l'indexation et appliquer.
- Après un changement d'embeddings, AFFiNE crée un nouvel index lors de la préparation des sources. La première question avec référence peut prendre davantage de temps.
- Pour un modèle local installé autrement, utiliser cette instance Ollama isolée (`OLLAMA_HOST=127.0.0.1:11435`), puis **Actualiser les catalogues**.

## Relancement

Dans `integrations/chatgpt-oauth-gateway`, lancer :

```sh
npm run sandbox:start
```

Ouvrir OrbStack auparavant. Le lanceur démarre PostgreSQL et Redis via le projet Compose isolé, puis Ollama, le backend, le Web et la gateway. Il réutilise les services déjà présents sur leurs ports et ne les arrête pas. Ctrl+C arrête uniquement ses propres processus ; les volumes PostgreSQL/Redis persistent.

La configuration, les fichiers du workspace de test et les modèles Ollama sont conservés sous `.runtime/sandbox/`, ignoré par Git. Ce dossier contient notamment la clé privée nécessaire au déchiffrement des profils BYOK : le conserver pour réutiliser la base. Les identifiants OAuth et le compte de développement du panneau restent dans le Trousseau macOS.

## Isolation

| Service    | Adresse locale  |
| ---------- | --------------- |
| Web        | 127.0.0.1:33080 |
| Backend    | 127.0.0.1:3010  |
| Gateway    | 127.0.0.1:43187 |
| Ollama     | 127.0.0.1:11435 |
| PostgreSQL | 127.0.0.1:55432 |
| Redis      | 127.0.0.1:56379 |

Projet Docker : `affine_oauth_sandbox_20261008`. Le panneau est volontairement limité au backend local de test et au workspace enregistré dans le Trousseau. Il ne peut pas configurer un serveur distant.

## Fonctionnalités et limites

Validation du 8 octobre 2026 : Qwen3 Embedding 0.6B a renvoyé des lots valides de 1024 valeurs ; les deux pages du workspace de test ont atteint l'état `ready`. Intelligence avec Luna a recherché puis lu la page et répondu « Bob » avec sa source. L'agent latéral avec Sol a également lu la page et cité la source après un rejeu. Le panneau a appliqué Luna → Sol → Luna sans saisie d'identifiants. Le relancement complet depuis le runtime persistant a été effectué avec succès. Suite automatisée : 62 tests réussis, 0 échec, 2 tests Keychain/verrou natif optionnels ignorés.

Les chemins validés sont le texte avec streaming, les appels de fonctions, les réponses structurées du prototype, la recherche/lecture de pages indexées et les changements de modèles ChatGPT. Les pages référencées utilisent des embeddings locaux ; les passages nécessaires à la réponse sont ensuite envoyés à OpenAI.

La génération d'images, la transcription audio et les capacités multimodales ne sont pas fournies par cette configuration texte/embeddings. Leur maintien demanderait des profils compatibles supplémentaires et des essais spécifiques. Le modèle de génération peut occasionnellement choisir le mauvais outil ou retourner une réponse vide ; cela ne constitue pas une garantie de réponse déterministe.

Diagnostic sans messages ni secrets : `node src/cli.mjs diagnostics`. Il conserve uniquement en mémoire les modèles, noms d'outils et types d'événements des 20 dernières requêtes.

Pour supprimer les identifiants du compte de développement utilisés par le panneau : `npm run sandbox:forget`. Cela ne déconnecte pas ChatGPT ; la déconnexion et l'oubli OAuth restent disponibles dans la page de la gateway.

## Priorité BYOK officielle et limites de validation

Dans un profil, les modèles activés et compatibles sont essayés dans leur ordre. Entre profils, le backend utilise leur ordre de priorité. Ce sont des paramètres du workspace côté serveur, pas une sélection par conversation. Un profil local desktop ou une cible explicite peut modifier le routage effectif.

Le formulaire officiel impose un probe avant sauvegarde. Le FetchService officiel a un timeout par défaut de 15 secondes ; des probes successifs sur plusieurs modèles ont dépassé ce délai durant nos essais, avec « BYOK key not saved ». Les probes natifs Luna/Sol exécutés via GraphQL ont chacun validé chat, tool_calling et structured. Pour éviter de dépendre de cette sauvegarde lente, les profils séparés ont été préparés par les mutations BYOK officielles dans la seule base isolée.

La réorganisation a été testée par reorderWorkspaceByokProfiles, puis par de vraies requêtes de la barre latérale sur Auto : Sol prioritaire → réponse 43 ; Luna prioritaire → réponse 44. Les traces du gateway confirment gpt-6-sol à 07:40:21.195 UTC et gpt-6-luna à 07:40:47.334 UTC le 8 octobre 2026, toutes deux completed. Le glisser-déposer est présent dans le code officiel mais notre automatisation n'a pas confirmé son fonctionnement ; il reste à vérifier manuellement. Aucun correctif de timeout ou de glisser-déposer n'a été appliqué à AFFiNE.

Les clients officiels Mac/Windows/Android devraient suivre le routage serveur sans rebuild pour la génération, mais ne sont pas testés ici. Le stockage local BYOK Electron est propre au poste. Waroserv ne peut pas encore joindre ce gateway loopback ; aucune liaison distante n'est configurée.

Après restauration des huit fichiers et rechargement de l’interface officielle, Intelligence a répondu 46 avec Luna et 47 avec GPT-6.1 Sol dans une même session. Le contexte et l’historique court restent affichés. Les traces ont été vérifiées ; Luna a ensuite été remis en priorité par défaut. Le catalogue conserve trois profils GPT et le profil d’embeddings séparé. Les autres modèles de l’ancien profil sont conservés mais désactivés pour limiter les probes.

Tests finaux : 63 tests gateway réussis (2 natifs ignorés dans cette commande), puis 2 tests Keychain/verrou natifs réussis ; 38 tests frontend officiels réussis. Les tests automatisés OpenAI restent simulés, les essais décrits ci-dessus utilisent le compte réel.

Traces après restauration (UTC, 8 octobre 2026) : gpt-6-luna à 07:46:39.204 et 07:48:35.537 ; gpt-6.1-sol à 07:55:03.522 ; toutes completed. Ces métadonnées ne contiennent ni prompt utilisateur privé ni token.
