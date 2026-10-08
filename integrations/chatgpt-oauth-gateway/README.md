# AFFiNE Local OAuth Gateway — prototype

L’environnement Web avec embeddings locaux et le panneau de choix des modèles sont décrits dans [SANDBOX.md](SANDBOX.md).

Passerelle autonome pour tester l’abonnement ChatGPT dans AFFiNE, sans clé API OpenAI. Aucun fichier des clients ou du backend AFFiNE n’est modifié. Le prototype est dédié à cette intégration personnelle, accessible uniquement sur `127.0.0.1` ; il ne constitue pas un service API public.

Référence : release **AFFiNE v0.27.4**, commit `b4c8548c09da21b2898443559a5b846f0ccf5dd8`. La branche `openai_oauth` part de ce commit. La branche locale `canary` conserve l’état initial `2d4f191e679a1eb95f96fe12b95060deb35668ae`. L’état de travail était propre au démarrage ; aucun reset global ou accès à waroserv n’a été effectué. Le hook lint-staged peut créer puis nettoyer une sauvegarde Git temporaire pendant le commit. Les migrations concernent uniquement la base isolée du sandbox.

## Démarrer sur le Mac

Prérequis : Node.js 22 ou ultérieur, macOS, Trousseau déverrouillé, Command Line Tools Apple (`xcrun swiftc`). La dépendance `jose` sert à vérifier les JWT signés ; le verrouillage des versions est dans `package-lock.json`. Le projet est indépendant des workspaces et dépendances d’AFFiNE.

```sh
cd /Users/maman/Documents/AFFiNE/integrations/chatgpt-oauth-gateway
npm ci --ignore-scripts
npm run build:keychain
npm start
```

Ouvrir **http://127.0.0.1:43187/** sur ce Mac. Cliquer **Continue with ChatGPT**, sélectionner son compte/workspace et autoriser l’utilisation du plan. Le callback OAuth est toujours `http://127.0.0.1:<port>/auth/callback` ; seule la valeur du port peut varier. Ne pas utiliser `localhost` à sa place.

L’installation possède son propre nom, host ID et client OAuth. Le premier enregistrement utilise l’entrée officielle `dynamic_agent_client`, puis conserve le client ID émis par OpenAI. Il n’y a aucune lecture des fichiers ni utilisation du client OAuth de Codex. Les comptes/workspaces enregistrés sont séparés et un seul est actif.

Cliquer **Récupérer mes modèles**, choisir un slug effectivement accessible, puis tester le streaming ou **add(19,23)**. Cette dernière action exécute une addition locale avec arguments validés, sans shell ni accès fichiers, puis transmet le résultat au modèle. Elle nécessite normalement deux requêtes GPT, au maximum quatre tours et huit appels de fonction. Le prototype ne lance pas d’inférence en arrière-plan.

Commandes équivalentes, dans un autre terminal pendant que le service fonctionne :

```sh
node src/cli.mjs status
node src/cli.mjs models
node src/cli.mjs chat --model gpt-6-luna --prompt 'Dis bonjour en une phrase.'
node src/cli.mjs tool --model gpt-6-luna
```

Les modèles Luna/Sol sont des choix à vérifier dans le catalogue du compte. Aucune substitution silencieuse n’est effectuée. L’interface convient aux messages confidentiels : un texte passé en argument CLI peut apparaître dans l’historique du shell. Aucune commande ne demande un token OAuth en argument ou variable d’environnement.

## Tokens et déconnexion

Les secrets sont stockés dans des éléments **Generic Password** du Trousseau macOS, service `org.affine-local.chatgpt-oauth-gateway` :

- `registrations-v1` : host ID, comptes séparés et tokens OAuth ;
- `local-access-v1` : secret permettant à la CLI locale de contacter le daemon.

Le helper natif utilise Security.framework ; les secrets transitent par des pipes en mémoire, jamais par les arguments des processus, un fichier JSON ou `/usr/bin/security -w`. Les items sont non synchronisables, avec accessibilité `AfterFirstUnlockThisDeviceOnly`. Les tokens restent nécessairement en mémoire pendant leur utilisation ; JavaScript ne garantit pas l’effacement physique de toutes les copies en mémoire.

Le service vérifie l’expiration avant chaque appel et toutes les 30 secondes lorsqu’il tourne. Il renouvelle près de l’expiration, respecte `earliest_refresh_at`, enregistre le refresh token de remplacement avant l’inférence et sérialise toutes les mutations. Un verrou noyau empêche deux daemons de renouveler la même session. Un `invalid_grant` demande une nouvelle connexion ; un échec d’écriture Keychain bloque l’inférence. Le renouvellement OAuth ne consomme pas de tokens de génération.

```sh
# Révoquer et supprimer les tokens du compte actif ; conserver son enregistrement.
node src/cli.mjs logout
# Supprimer aussi l’enregistrement du compte actif.
node src/cli.mjs logout --forget
# Déconnecter et oublier tous les comptes sauvegardés.
node src/cli.mjs logout --all --forget
```

La déconnexion interrompt les requêtes en cours, tente la révocation officielle puis supprime les tokens locaux même si la révocation échoue. Dans ce dernier cas, `revocation_confirmed:false` indique qu’il faut aussi déconnecter l’application dans les paramètres ChatGPT. Arrêter le daemon avec Ctrl+C ne révoque pas la connexion : les credentials protégés permettent de reprendre ultérieurement.

Pour réinitialiser complètement l’installation : déconnecter tous les comptes, arrêter le daemon, puis supprimer les deux éléments de ce service dans **Trousseau d’accès**. Cela retire aussi le host ID et la clé d’accès locale. Ne pas afficher ou exporter le champ mot de passe. Il n’existe pas d’exporteur de credentials dans ce projet.

## Contrat HTTP et compatibilité AFFiNE

L’interface web utilise un cookie HttpOnly/SameSite et un header CSRF. La CLI récupère le secret local directement dans Keychain. Les endpoints sensibles refusent les requêtes non authentifiées ; aucune configuration CORS permissive n’est présente. Le Host exact, l’Origin et les informations Fetch Metadata sont contrôlés contre les appels depuis un site externe et le DNS rebinding.

| Endpoint              | Comportement                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `GET /healthz`        | Santé sans données de compte                                                      |
| `GET /v1/models`      | Catalogue SIWC converti au format `{object:"list",data:[...]}`                    |
| `POST /v1/responses`  | Responses avec SSE, ou réponse JSON après consommation du SSE pour `stream:false` |
| `POST /api/demo/tool` | Démonstration d’addition et continuation avec résultat                            |
| `POST /auth/start`    | OAuth lancé depuis l’interface locale                                             |
| `GET /auth/callback`  | Validation PKCE/OIDC et stockage Keychain                                         |
| `POST /auth/logout`   | Révocation et suppression locale                                                  |

Le dialecte recommandé pour AFFiNE est **Responses**, déjà accepté en 0.27.4. Le dialecte Chat Completions n’est pas implémenté par ce prototype. Le BYOK de cette version possède des probes non streamées : le gateway consomme donc le SSE amont jusqu’au terminal et retourne le JSON attendu. Les tests automatisés simulent ce contrat ; ils ne constituent pas une validation du runtime `llm_adapter` 0.2.20 ni des clients AFFiNE réels.

La passerelle impose `store:false`, `stream:true` côté OpenAI. Les paramètres interdits SIWC sont omis et signalés dans `X-Gateway-Omitted-Parameters` ; leurs valeurs ne sont jamais journalisées. Les messages système deviennent des messages développeur. Les outils function/custom plats sont groupés dans le namespace `affine`. Les noms et call IDs sont conservés. Les schémas de sortie sont préservés ; la démonstration rejoue les items de raisonnement chiffrés et tous les outputs entre tours.

`previous_response_id` est refusé : l’historique nécessaire doit être transmis dans `input`. La passerelle ne stocke pas de conversation supplémentaire. Les erreurs tardives produisent un événement `gateway.error`, jamais une fausse réussite ; une compatibilité définitive de cet événement avec AFFiNE reste à vérifier avant raccordement.

Images générées/filtres, embeddings, audio/transcription et outils hébergés exclus par SIWC nécessitent d’autres routes/fournisseurs. Images/fichiers en entrée et JSON structuré dépendent des capacités du modèle et restent à tester réellement. Le changement de fournisseur d’embeddings doit conserver dimension/modèle ou faire l’objet d’une réindexation contrôlée ; le prototype n’y touche pas.

## Tests et Docker

```sh
npm test
# Test natif : credentials synthétiques uniquement, supprimés en fin de test.
npm run test:keychain
# Tests Linux avec OpenAI simulé ; aucun port publié ni secret monté.
docker build -f Dockerfile.test -t affine-oauth-gateway-tests .
docker run --rm --network none affine-oauth-gateway-tests
```

Les tests couvrent signatures JWT, PKCE, scopes, refus/rejeu de callback, isolation des comptes, renouvellements concurrents, révocation, erreur de persistance, SSE fragmenté/UTF-8, quotas tardifs, appel de fonction en deux tours, annulation, authentification HTTP, CSRF et Host. Les tests natifs sont activés séparément et nécessitent macOS.

Le Dockerfile est un **harness de tests**, pas un déploiement OAuth : un container Linux n’a pas accès au Trousseau macOS et le programme refuse un stockage non-Keychain. Les fichiers de runtime, secrets et dépendances locales sont exclus du contexte Docker. Aucun container de production ni transfert vers waroserv n’est préparé automatiquement. Les décisions pour un futur déploiement sont dans [SECURITY.md](SECURITY.md).

## Particularités observées pendant les essais réels

Le flux SIWC observé sur ce compte arrive sans en-tête `Content-Type`. L’adaptateur accepte cette absence uniquement après validation des frames SSE ; un autre MIME explicite est rejeté. Les événements `response.output_item.done` peuvent contenir les appels de fonction alors que le terminal présente `output: []` : la passerelle reconstruit les outputs ordonnés et les restitue aussi dans le terminal transmis au client.

Un sélecteur `{type:"function",name:"add",namespace:"affine"}` a été refusé par la route du compte. Le prototype traduit les sélections nominatives en un namespace ne contenant que cette fonction, avec `tool_choice:"required"`. Ce cas est couvert par les tests automatisés ; la compatibilité générale des sélecteurs de tous les providers reste à vérifier lors de l’intégration AFFiNE.

Le renouvellement et la révocation ont été testés avec OpenAI simulé et le stockage natif avec des credentials synthétiques. Le compte réel a permis de vérifier OAuth, reprise après redémarrage, catalogue, streaming Luna, fonction `add` et JSON structuré Sol. Aucun refresh réel à expiration ni logout du compte réel n’est inclus dans les résultats actuels.

Voir [RESULTS.md](RESULTS.md) pour les résultats et limites de validation.

## Sources et prochaines étapes

Documentation consultée le 8 octobre 2026 : [OAuth](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [sessions/rotation/révocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [catalogue et Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [restrictions SIWC](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

AFFiNE Web est maintenant raccordé sans patch conservé. Les probes natifs Luna/Sol et la priorité BYOK ont été testés ; les schémas mindmap/slides, pièces jointes, modifications de documents et conversations longues restent à valider. Prévoir les fournisseurs complémentaires et des fixtures de non-régression pour les mises à jour, car le BYOK AFFiNE demeure expérimental. Toute configuration du serveur ou publication nécessite une autorisation distincte.
