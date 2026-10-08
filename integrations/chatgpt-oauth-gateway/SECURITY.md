# Choix de sécurité et comparaison SIWC / Self-hosted VMs

Analyse des sources officielles consultées le **8 octobre 2026**. Ceci décrit les exigences techniques et les points non résolus ; ce n’est pas une confirmation d’OpenAI pour un hébergement distant particulier.

## Écart entre les textes officiels

| Source                                                                                                      | Ce qu’elle indique                                                                                                                                            | Décision du prototype                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [SIWC Terms, §1](https://openai.com/policies/sign-in-with-chatgpt-terms/)                                   | Stockage persistant local sous contrôle utilisateur ; exclusion d’un environnement distant ou géré                                                            | Tous les tokens restent dans le Trousseau du Mac                                       |
| [SIWC Terms, §2 et §4](https://openai.com/policies/sign-in-with-chatgpt-terms/)                             | Runtime contrôlé par l’utilisateur, activité de celui-ci ou automation expressément autorisée, usage réservé à l’app connectée ; aucun partage d’abonnement   | Service personnel local, nom propre, aucun endpoint public, aucune inférence planifiée |
| [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)             | OAuth local avec le même outil/compte/workspace, transfert sécurisé des credentials vers la VM, host ID propre à la VM, renouvellement géré ensuite par la VM | Aucune opération de transfert n’est implémentée                                        |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | Stockage protégé local ou dans un runtime auto-hébergé ; sérialisation des rotations et suppression à la déconnexion                                          | Keychain local, verrou noyau et file de mutations                                      |

Le passage contractuel pertinent est :

> Any persistent storage of Authentication Tokens must be local and under the user’s control, not in a remote or managed environment.

Cette phrase exclut explicitement le distant, tandis que les deux guides décrivent du stockage auto-hébergé et la gestion des refresh tokens sur VM. L’existence du guide prouve qu’un flux technique est documenté ; elle ne suffit pas à résoudre l’écart contractuel. La qualification précise d’un serveur personnel Ubuntu par rapport à ces conditions reste à faire clarifier auprès d’OpenAI avant d’y conserver un refresh token. Aucun contact externe n’a été envoyé.

Le stockage autorisé sur ce Mac est cohérent avec la restriction locale. Le prototype ne contourne ni le consentement SIWC, ni les quotas, ni l’enregistrement d’application. Les tokens de Codex et les endpoints ChatGPT `backend-api` ne sont jamais employés.

## Frontières du prototype

- Secrets persistants : Security.framework, Keychain non synchronisable, items propres au projet. Aucun fallback en fichier ou variable d’environnement.
- Transit local : secrets par pipes entre Node et helper Swift. Le code n’imprime pas les tokens et ne relaie pas les diagnostics des processus enfants. Les erreurs de l’amont sont converties en codes fixes ; les prompts, URLs de callback et corps des réponses OAuth ne sont pas des logs.
- Identité : signature JWT via `jose`, issuer et audience attendus, expiration, nonce, subject pour les retours et `azp` lorsque requis. JWKS et discovery sont récupérés depuis l’issuer officiel ; les redirections HTTP des appels contenant des credentials sont refusées.
- Autorisation : scope d’utilisation du plan distinct de l’identité ; callback à durée courte, lié au navigateur, consommé une fois ; déconnexion/changement de compte annule une connexion en cours.
- Rotation : une seule instance par utilisateur Mac, refresh sérialisé, remplacement persistant avant l’inférence. Les erreurs ambiguës de réseau/rotation ne provoquent pas de boucle de retry automatique dans une requête ; une session invalide demande de se reconnecter.
- Réseau : loopback IPv4 seulement, Host exact, Origin et CSRF vérifiés, CSP restrictive. Aucun tunnel ni port public ni CORS de tiers. Le secret local et le cookie ne remplacent pas un contrôle d’identité AFFiNE dans un déploiement partagé.
- Outils : seule la démonstration `add` est exécutée ici. La route Responses transmet des déclarations/résultats ; le backend AFFiNE exécute ses outils avec ses propres permissions ; doc_search et doc_read ont été observés en intégration réelle.

Un logiciel malveillant exécuté sous le même compte macOS ou disposant de droits administrateur peut attaquer le runtime ou demander l’accès au Trousseau. Le service local ne prétend pas isoler deux utilisateurs du même compte OS. Les buffers sont en mémoire ; leur effacement complet n’est pas garanti par JavaScript. Le daemon n’a pas de telemetry ni de fonction d’export de credentials.

## Déconnexion et retrait d’accès

`logout` arrête les requêtes et tente deux fois au maximum la révocation du refresh token à l’endpoint issu du discovery officiel. Les tokens locaux sont supprimés même en cas d’échec distant. Le résultat signale alors l’absence de confirmation de révocation ; l’utilisateur peut retirer l’app dans ChatGPT Settings. `--forget` supprime aussi l’enregistrement du compte et `--all` couvre tous les comptes sauvegardés. Le host ID est conservé jusqu’à la réinitialisation explicite de l’installation.

Un changement de workspace utilise un enregistrement séparé. Il ne doit pas être employé pour fractionner les usages ou contourner une limite. Un profil BYOK partagé avec d’autres personnes ne doit pas acheminer leurs requêtes vers cet abonnement personnel.

## Déploiement ultérieur

Pour garder les credentials sur le Mac : conserver le gateway local et examiner une liaison privée limitée au backend AFFiNE. Cette solution dépend de la disponibilité du Mac ; elle nécessite une autorisation avant toute configuration de waroserv. Le backend devra pouvoir associer chaque usage au titulaire autorisé, notamment dans un workspace partagé.

Une variante Docker distante avec bearer court en mémoire et broker Keychain local pourrait éviter la persistance distante. Sa conformité complète et son authentification par utilisateur restent à valider ; aucune version de cette variante n’est livrée. Ne pas monter le Trousseau, les données AFFiNE ou un export de tokens dans un container Linux. Ne pas placer des refresh tokens dans Compose, une image, un volume ou un secret Docker tant que le stockage distant n’a pas été clarifié.

Tout futur déploiement doit isoler le réseau et les volumes du gateway de PostgreSQL/Redis et de la synchronisation AFFiNE, conserver une configuration BYOK de retour arrière et tester les contrats sur la version exacte d’AFFiNE. Les crédits/quotas Plus restent partagés avec les autres usages autorisés du compte ; SIWC n’ajoute pas de capacité au plan.

## État du déploiement

Le gateway actuel refuse les plateformes autres que macOS (macos_keychain_required) : il n’est pas directement déployable sur Ubuntu. Le chiffrement d’un stockage Linux ne résout pas l’écart entre les conditions SIWC et le guide VM. Aucune variante distante, export OAuth, liaison privée ou attribution par utilisateur n’est implémentée. Les profils BYOK du sandbox ne contiennent que le bearer d’accès local au gateway ; les tokens OAuth restent dans le Trousseau. Aucun transfert vers waroserv ni partage d’abonnement n’a été effectué.
