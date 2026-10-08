# Résultats du prototype — 8 octobre 2026

## Périmètre et environnement

Branche `openai_oauth`, référence release AFFiNE v0.27.4 (`b4c8548c09da21b2898443559a5b846f0ccf5dd8`). Le checkout précédent était propre et reste accessible sur la branche `canary`. Tous les ajouts sont dans `integrations/chatgpt-oauth-gateway/`. Les fichiers existants d’AFFiNE, ses clients, son backend et waroserv n’ont pas été modifiés.

Environnement réellement utilisé : macOS, Node.js **24.21.0**, Swift des Command Line Tools Apple, `jose` **6.2.12** verrouillé par `package-lock.json`. Le Dockerfile de tests gateway sous Linux/Node 22 n’a pas été exécuté. OrbStack exécute maintenant PostgreSQL et Redis dans le sandbox isolé.

## Tests automatisés

| Commande                             | Résultat                                               |
| ------------------------------------ | ------------------------------------------------------ |
| `npm test` (dernière exécution)      | 63 réussis, 0 échec, 2 tests natifs optionnels ignorés |
| `npm run test:keychain`              | 2 tests natifs exécutés avec succès                    |
| Compilation `npm run build:keychain` | Helper Swift compilé avec succès                       |

La dernière suite contient **65 tests**, dont 63 exécutés avec succès. Les deux tests natifs ont également été réexécutés avec succès séparément (npm run test:keychain). Les tests HTTP ouvrent seulement des ports loopback et OpenAI est simulé. Les tests natifs utilisent un espace Keychain unique et des secrets synthétiques supprimés ensuite, ainsi qu’un verrou temporaire sans credentials. Aucun token réel ne figure dans les fixtures ni les captures de résultats.

Couverture : PKCE RFC 7636, enregistrement dynamique propre au gateway, signature/issuer/audience/nonce/expiration JWT, consentement du plan, refus et rejeu OAuth, isolation des comptes, rotation concurrente et invalide, erreurs de persistance, révocation et suppression locale, déconnexion durant OAuth, SSE fragmenté/UTF-8 et sans MIME, terminal sans outputs, refus des outils exclus, fonction en deux tours, quota tardif, interruption, authentification/CSRF/Origin/Host HTTP, stockage Keychain et exclusion des daemons concurrents.

## Essais réels avec le compte connecté par l’utilisateur

| Essai                      | Résultat observé                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth SIWC + PKCE          | Connexion effectuée dans le navigateur par l’utilisateur ; code échangé et identité vérifiée par le prototype                                           |
| Persistance native         | Connexion réutilisée après redémarrage du gateway, sans copier de credentials                                                                           |
| Catalogue OAuth            | 7 modèles visibles, dont `gpt-6-luna` et `gpt-6-sol`                                                                                                    |
| Streaming `gpt-6-luna`     | Réponse reçue : « Bonjour depuis AFFiNE. » ; flux confirmé terminé                                                                                      |
| Fonction `gpt-6-luna`      | `add(19,23)` exécutée localement → `42` ; résultat transmis et réponse finale « 19 + 23 = 42. »                                                         |
| JSON structuré `gpt-6-sol` | Statut `completed` ; JSON conforme au schéma `{answer:"OK"}`, sans propriété supplémentaire                                                             |
| Probe non streamé          | Le probe Sol utilise `stream:false` côté client, SSE côté OpenAI puis réponse JSON reconstruite ; `temperature` et `max_output_tokens` omis et signalés |

Le catalogue contient aussi `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra` et `gpt-5.6-luna`. Aucun appel d’inférence à ces autres modèles n’a été effectué. La disponibilité du catalogue peut changer selon le compte/workspace et la date.

Les essais ont détecté deux écarts de forme du flux réel : MIME absent et output terminal vide malgré un appel dans les événements. Ces comportements sont désormais adaptés et couverts par des tests de régression. Le sélecteur de fonction explicite namespacé a été refusé ; la sélection nominative est adaptée en n’exposant que la fonction choisie avec appel requis. Les essais de diagnostic peuvent avoir consommé du quota, même lorsqu’un client interrompait le flux ; aucun nombre exact de tokens consommés n’est revendiqué.

## Limites et suite

- Renouvellement automatique et révocation : validés en simulation ; aucun refresh réel à échéance ni révocation du compte réel n’a été provoqué. Le compte reste disponible dans le Trousseau pour poursuivre les essais.
- Le prototype fournit Responses ; Chat Completions n’est pas implémenté. Les outils custom, recherches web et sélecteurs complexes ne sont pas tous validés réellement.
- AFFiNE Web 0.27.4 est raccordé réellement au gateway. Intelligence avec Luna a utilisé doc_search et doc_read, puis cité une page ; la barre latérale avec Sol a lu une page. Les probes natifs Luna/Sol ont validé chat, tool_calling et structured. Les conversations longues, toutes les actions d’écriture, les modifications de documents, mindmaps/slides, pièces jointes multimodales et clients officiels natifs restent à tester.
- Embeddings : Qwen3 Embedding 0.6B via Ollama isolé, 1024 dimensions, pages du workspace de test indexées ready. Images et audio/transcription ne sont pas fournis. Aucun index de production ni configuration de synchronisation de waroserv n’a été modifié.
- Le Dockerfile de tests est livré mais non exécuté. Le stockage OAuth distant reste suspendu à la clarification de l’écart entre les conditions SIWC et le guide VM, expliqué dans [SECURITY.md](SECURITY.md).

Prochaine étape : poursuivre les essais des actions natives et des clients officiels sur le sandbox, puis clarifier le stockage OAuth distant avant toute configuration de waroserv. La publication, les transferts et les modifications en production nécessitent une autorisation distincte.

## Retour au frontend officiel

Les huit fichiers frontend expérimentaux ont été restaurés vers la référence release après les essais réels de priorité BYOK Sol/Luna sur Auto. Aucun changement AFFiNE n’est conservé dans le commit final ; la passerelle, ses tests et les configurations privées du sandbox sont conservés. Les profils ajoutés incluent GPT-6.1 Sol (catalogue accessible ; statut des essais d’inférence indiqué dans SANDBOX.md). La sauvegarde des modèles dans un même profil peut dépasser le timeout officiel de 15 secondes : le changement de priorité de profils est validé via la mutation officielle, le geste UI reste non validé. Voir [SANDBOX.md](SANDBOX.md) pour l’utilisation et les limites.

Après restauration, les quatre suites frontend officielles (modèles Copilot, runtime chat, paramètres BYOK et utilitaires de modèles) ont réussi : 38 tests, 0 échec. Intelligence a répondu 46 avec Luna, puis 47 avec GPT-6.1 Sol, après changement de priorité serveur. Le menu personnalisé est absent.
