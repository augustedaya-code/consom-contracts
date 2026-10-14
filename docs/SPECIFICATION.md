# ConsoM – Spécification du smart contract TON

Version du 14 octobre 2026 — copie de la spécification de référence (document Claude Docs).

## 0. Statut et conventions

Ce document remplace le « Document final de synthèse » du 14 octobre 2026 comme référence unique pour le développement et l'audit des contrats ConsoM sur TON. Il ne change aucun principe économique sans accord : chaque écart par rapport à la synthèse est signalé, et les choix encore ouverts sont regroupés en section 12.

- **Périmètre** : uniquement la couche crypto de TonMarché. Les achats, les Points, les FECA et les projets restent dans l'application.
- **DOIT / NE DOIT PAS** : règle imposée par le code du contrat, vérifiable par quiconque lit la blockchain.
- **Unité** : 1 ConsoM = 10⁹ unités de base (9 décimales, standard Jetton). Tous les montants du contrat sont des entiers en unités de base.
- **Temps** : secondes Unix lues dans la blockchain (`now()`). « 1 mois » = 30 jours, « 1 an » = 365 jours, comptés depuis **T0**, l'instant d'ouverture du réseau principal gravé au déploiement.
- **Wave** : service de mobile money externe, utilisé seulement pour encaisser les paiements réels. Il ne fait pas partie de ConsoM.

## 1. Les trois couches

Le contrat ne fait confiance à personne en particulier : il n'accepte une émission que si deux témoins sur trois l'ont signée, et il applique lui-même tous les plafonds, pourcentages et délais. Ce que le contrat ne peut pas voir (un paiement Wave, une livraison, des Points) lui arrive sous forme d'attestation signée.

| Couche | Rôle | Où ça vit | Ce qu'elle ne peut pas faire |
| --- | --- | --- | --- |
| TonMarché | Commandes, livraisons, Points, FECA, projets, calcul des récompenses, préparation des bons | Application et base de données | Créer un ConsoM seule |
| Témoins (3) | Vérifier chaque paiement Wave et chaque récompense, puis signer | Trois services séparés, trois clés détenues par trois personnes | Dépasser un plafond du contrat, signer pour un autre réseau ou un autre contrat |
| Contrats TON | Émission, soldes, transferts, brûlages, banque d'échange, plafonds, vesting, pause | Blockchain TON | Vérifier Wave directement, reprendre un jeton déjà émis |

**Ce qui reste hors chaîne, par choix** : les Points, les FECA, la répartition des 10 % de frais en FECA aux déposants de la banque, les commissions de prévente en Points. Le contrat publie les informations dont l'application a besoin pour les calculer (taux V, parts de chaque déposant).

## 2. Architecture des contrats

ConsoM est un Jetton standard (TEP-74, découverte TEP-89) avec un émetteur sur mesure. Les wallets des membres restent ceux de **Jetton 2.0**, la version que la documentation TON recommande pour tout nouveau projet ; toute la logique propre à ConsoM vit dans l'émetteur et dans des contrats enfants. Les contrats sur mesure sont écrits en **Tolk**, le langage aujourd'hui recommandé par TON.

Aucune liste qui grandit sans fin n'est stockée dans un seul contrat : un contrat TON est limité à 65 536 cellules d'état, et la documentation recommande un contrat enfant par clé (un par paiement, un par membre), dont l'adresse se calcule à partir de la clé.

| Contrat | Un par | Ce qu'il stocke | Ce qu'il fait |
| --- | --- | --- | --- |
| Émetteur ConsoM | Réseau | Offre totale, plafonds restants par catégorie, total brûlé, T0, 3 clés de témoins, adresse du gardien, état de pause, compteur journalier global | Vérifie les signatures, réserve les plafonds, crée les jetons, compte les brûlages de conversion, recrée dans la banque les brûlages volontaires, calcule V |
| Wallet ConsoM (Jetton 2.0, non modifié) | Détenteur | Solde | Transferts libres, brûlage |
| Budget de paiement | Paiement Wave | Empreinte de l'identifiant Wave, membre, montant, Points, récompenses déjà versées | Empêche la réutilisation d'un paiement et tout dépassement de ses récompenses |
| Compte membre | Membre | Adresse TON liée, parrain, droit au parrainage, gains du jour, tranches en vesting, missions faites | Plafond de 50 000 par jour, vesting, éligibilité |
| Banque d'échange | Réseau | Stock des déposants, stock sans propriétaire, total des parts, date d'ouverture | Toutes les conversions (propres ConsoM ou banque), dépôts, retraits ; seul contrat dont les brûlages comptent pour le halving |
| Part de banque | Déposant | Nombre de parts, date du dernier dépôt | Retrait après 24 h |
| Réclamation de genèse | Ligne de genèse | Rien d'autre qu'« utilisée » | Empêche de réclamer deux fois une allocation de genèse |
| Gardien | Réseau | Multisig v2 officiel, 2 signatures sur 3 | Pause, remplacement d'un témoin |

L'émetteur n'a **aucun administrateur** : pas de fonction de création libre, pas de changement de code, pas de changement de métadonnées après le déploiement.

*(Schéma d'architecture : voir le document de référence.)*

Le bon signé hors chaîne ne crée rien par lui-même : l'émetteur, le budget du paiement et le compte du membre doivent chacun l'accepter avant que les jetons arrivent dans le wallet.

## 3. Offre totale et plafonds gravés

L'offre ne PEUT PAS dépasser 230 000 000 ConsoM. Un ConsoM brûlé par une conversion n'est jamais réémis ; un ConsoM brûlé autrement est recréé dans la banque d'échange (section 9). Chaque catégorie a son propre plafond, gravé au déploiement ; une émission qui dépasserait le plafond restant de sa catégorie est refusée en entier.

| Catégorie | Plafond (ConsoM) | Source d'émission | Fenêtre |
| --- | --- | --- | --- |
| Prévente | 100 000 000 | Paiement Wave d'un pack | T0 → T0 + 12 mois |
| Récompenses d'achat | 55 000 000 | Paiement Wave d'une commande livrée | T0 → T0 + 18 mois |
| Parrainage | 45 000 000 | Paiement Wave d'une commande d'un filleul | T0 → T0 + 18 mois |
| Missions | 20 000 000 | Membre ayant au moins un paiement | T0 → T0 + 18 mois |
| Anciens Contributeurs | 5 000 000 | Genèse (liste gravée) | Réclamable sans limite de durée |
| Équipe | 5 000 000 | Genèse (adresses gravées) | Blocage 12 mois, puis 24 mois linéaires |

**Règles de fin de période**

1. À T0 + 12 mois, la prévente se ferme. Sur son reste R : 50 % sont retirés définitivement, 25 % s'ajoutent au plafond des récompenses d'achat, 25 % à celui du parrainage. Le calcul est fait une seule fois, par le premier message reçu après cette date.
2. À T0 + 18 mois, l'émission de nouvelles récompenses s'arrête. Le reste non réservé des catégories Achat, Parrainage et Missions est retiré définitivement. Les tranches de vesting déjà acquises continuent d'être libérées.
3. « Retiré » veut dire que le plafond est ramené au montant déjà émis ou réservé : rien n'est créé puis brûlé.

**Phases de test** : aucun gain n'est repris. Le testnet n'a donné lieu à aucun achat réel ; seules les préventes réellement payées par Wave avant T0 entrent dans la genèse, dans le plafond de la prévente (section 11).

## 4. Principe d'émission

Aucun ConsoM ne peut être créé sans un paiement Wave préalable, attesté par deux témoins sur trois. Seules exceptions : les allocations de genèse (Anciens Contributeurs, équipe, préventes réellement payées avant T0), fixées au déploiement.

**Le budget de paiement.** La première émission qui cite un paiement Wave crée son contrat « Budget de paiement », dont l'adresse dépend de l'empreinte de l'identifiant Wave. Un même paiement ne peut donc exister qu'une fois. Le budget enregistre ce que les témoins ont attesté et refuse ensuite toute récompense qui ne correspond pas aux règles :

- `points` : les Points de la commande, plafonnés à `montant_fcfa × P_max`, où P\_max = 0,5 Point par franc, gravé au déploiement (les Points valent 25 % ou 50 % de la marge d'un produit, et la marge est toujours inférieure au prix) ;
- un emplacement par récompense versée à l'achat : parrainage niveaux 1 à 5, bonus de 1er achat ; chacun ne peut être versé qu'une fois, et son montant est calculé par le contrat à partir de `points` (section 6), pas pris dans le bon. Les Points de la commande s'ajoutent aussi au compteur de Points récompensables du compte de l'acheteur, qui borne sa récompense de 35 % à la conversion.

**Ce que le budget protège, et ce qu'il ne protège pas.** Il bloque une erreur de calcul de l'application, la réutilisation d'un paiement et toute récompense hors règle. Il ne protège pas contre deux témoins compromis, qui pourraient attester un faux paiement. Contre ce cas, les protections sont le plafond journalier global, le vesting et la pause (section 10).

**Condition « livré et payé »** : un témoin ne signe une récompense d'achat qu'après la livraison et un délai de 48 h, pendant lequel l'acheteur peut signaler un problème à l'équipe ; ainsi, aucune commande remboursée ne donne de ConsoM déjà émis.

## 5. Bon d'émission et réclamation

Un bon est une autorisation signée par au moins deux témoins, que le membre envoie lui-même à l'émetteur depuis son wallet via TON Connect, en payant les frais de réseau. Un bon volé est inutilisable : seul le wallet lié au compte du membre peut l'envoyer.

**Contenu signé** (une seule cellule, signature Ed25519 de son empreinte)

| Champ | Rôle |
| --- | --- |
| `network_id` | -239 pour le réseau principal, -3 pour le testnet : un bon de testnet est refusé sur le réseau principal |
| `minter` | Adresse de l'émetteur : un bon ne vaut que pour ce contrat |
| `voucher_id` | Identifiant unique sur 64 bits |
| `kind` | Prévente, conversion (35 %), parrainage (niveau 1 à 5), 1er achat, mission, investissement |
| `wave_ref` | Empreinte SHA-256 de l'identifiant de transaction Wave (jamais l'identifiant en clair) |
| `wave_amount`, `points` | Montant payé en FCFA et Points de la commande, tels qu'attestés |
| `member_id` | Empreinte de l'identifiant TonMarché du bénéficiaire |
| `recipient` | Adresse TON qui recevra les jetons |
| `amount` | Montant demandé, que le contrat recalcule et doit retrouver à l'identique |
| `valid_until` | Expiration, au plus 7 jours après la signature |

**Parcours d'une réclamation**

1. Le wallet du membre envoie le bon et les signatures à l'émetteur.
2. L'émetteur vérifie : pas en pause, fenêtre de la catégorie ouverte, bon non expiré, réseau et adresse corrects, au moins 2 signatures valides de 2 témoins différents, expéditeur = `recipient`. Il réserve le montant sur le plafond de la catégorie et sur le compteur journalier global.
3. Le budget de paiement vérifie l'emplacement, le recalcul du montant et le `voucher_id`, puis marque l'emplacement comme versé.
4. Le compte membre vérifie l'adresse liée, l'éligibilité et le plafond de 50 000 par jour, puis sépare la part immédiate et la part en vesting.
5. L'émetteur crée la part immédiate dans le wallet du membre. La part en vesting reste dans le compte membre jusqu'à sa libération.

Si une étape refuse, le message rebondit jusqu'à l'émetteur, qui libère sa réservation. Les frais restants sont rendus au membre (message `excesses`). Le coût exact d'une réclamation sera mesuré sur le testnet avant d'être affiché dans l'application.

## 6. Règles de récompense

Une commande livrée et payée peut donner au plus 62,5 % de ses Points en ConsoM : 27,5 % répartis sur cinq niveaux de parrainage dès l'achat, et 35 % à l'acheteur quand il convertit ses Points avant leur expiration. 1 Point donne droit à 1 ConsoM au taux indiqué ; le contrat calcule chaque montant avec un arrondi à l'unité de base inférieure.

| Récompense | Montant | Bénéficiaire | Catégorie | Limite |
| --- | --- | --- | --- | --- |
| Achat | 35 % des Points convertis | L'acheteur | Achats | Versé à chaque conversion ; total ≤ 35 % des Points de ses commandes attestées |
| Parrainage niveau 1 | 15 % des Points | Parrain direct, s'il est éligible | Parrainage | Une fois par paiement |
| Niveau 2 | 7 % | Idem, niveau 2 | Parrainage | Idem |
| Niveau 3 | 3,5 % | Idem, niveau 3 | Parrainage | Idem |
| Niveau 4 | 1,5 % | Idem, niveau 4 | Parrainage | Idem |
| Niveau 5 | 0,5 % | Idem, niveau 5 | Parrainage | Idem |
| 1er achat | 500 ConsoM | L'acheteur | Missions | Une fois par membre |
| Telegram | 150 ConsoM | Membre avec au moins un paiement | Missions | Une fois par membre |
| Facebook | 150 ConsoM | Membre avec au moins un paiement | Missions | Une fois par membre |
| Investissement | 30 % des FECA investis | L'investisseur | Missions | Total ≤ 30 % des Points reçus par ce membre |

**Récompense de conversion.** Le compte membre tient le total des Points de toutes les commandes attestées du membre. À chaque conversion attestée, le membre reçoit 35 % des Points convertis, dans la limite de ce total moins ce qui a déjà été récompensé. L'expiration des Points est appliquée par l'application : des Points expirés ne peuvent plus être convertis, donc ne donnent rien.

**Parrainage.** Il est versé dès que l'achat du filleul est attesté, sans attendre que le filleul convertisse.

**Éligibilité au parrainage.** Seul un membre ayant acheté en prévente ou un Ancien Contributeur peut recevoir une récompense de parrainage. Le compte membre porte ce droit, activé par une attestation de prévente ou par la genèse. Le parrain d'un membre est enregistré dans son compte ; seule l'équipe peut le changer, par bon signé 2 sur 3, et le changement ne vaut que pour les achats suivants. Si le parrain d'un niveau n'est pas éligible, son emplacement est perdu : il n'est ni versé à un autre, ni reporté.

**Vesting.** Toute récompense (achat, parrainage, missions) est versée pour 50 % immédiatement. Les 50 % restants sont libérés en cinq tranches de 10 %, à J+30, J+60, J+90, J+120 et J+150 après la réclamation. Une tranche échue se réclame depuis le wallet lié ; elle est créée à ce moment-là. La prévente, les Anciens Contributeurs et l'équipe ont leurs propres règles.

**Plafond par membre.** Un membre ne peut pas recevoir plus de 50 000 ConsoM par période de 24 h, toutes catégories confondues sauf la prévente, tranches de vesting comprises. Ce qui dépasse est refusé ; le bon peut être réutilisé le lendemain s'il n'a pas expiré.

## 7. Prévente

Un paiement Wave de prévente donne exactement les ConsoM d'un pack, crédités immédiatement et sans vesting, et active le droit au parrainage du membre. Les packs sont gravés dans l'émetteur : le contrat refuse un bon dont le montant payé est inférieur au prix du pack ou dont la quantité diffère.

| Pack | ConsoM | Prix (FCFA) | Prix unitaire (FCFA) | Commission au parrain (Points, hors chaîne) |
| --- | --- | --- | --- | --- |
| Essentiel | 3 000 | 3 500 | 1,17 | 500 |
| Offre populaire | 20 000 | 17 500 | 0,875 | 5 000 |
| Grande offre | 50 000 | 38 000 | 0,76 | 10 000 |

- Un paiement Wave = un pack. Plusieurs packs = plusieurs paiements.
- La prévente n'est pas soumise au plafond de 50 000 par jour, mais compte dans le plafond journalier global.
- Elle se ferme à T0 + 12 mois ; le reste suit la règle de la section 3.
- Les prix actuellement enregistrés dans l'application (3 000, 16 000 et 35 000 FCFA) doivent être alignés sur ce tableau avant l'ouverture.
- **Condition préalable** : la revue juridique (Côte d'Ivoire, UEMOA) doit être terminée avant l'ouverture publique de la prévente sur le réseau principal.

## 8. Conversion, brûlage et taux V

Convertir des Points en FECA coûte toujours 10 % des Points, payés en ConsoM brûlés ; le nombre de ConsoM à brûler est divisé par deux à chaque palier de halving. L'émetteur ne compte que les brûlages faits par la banque d'échange, qui traite toutes les conversions, et publie le taux courant par une méthode de lecture `get_burn_for_points(points)` ; l'application ne calcule rien elle-même.

**Paliers.** B est le total brûlé par les conversions depuis T0, B₁ la part brûlée pendant la première année. La première année compte un palier tous les 800 000 ConsoM ; ensuite, un palier tous les 12 000 000, et ce qui dépassait le dernier palier de la première année est reporté sur le premier palier de 12 000 000. Le nombre de paliers n vaut :

```latex
n_1 = \left\lfloor \frac{B_1}{800\,000} \right\rfloor \qquad n = \min\left( n_1 + \left\lfloor \frac{B - 800\,000 \times n_1}{12\,000\,000} \right\rfloor ,\; n_{max} \right)
```

**ConsoM à brûler** pour P Points, en unités de base (10⁹ par ConsoM), arrondi au supérieur. Avec n = 0, 100 Points demandent 10 ConsoM, soit V = 100.

```latex
\text{brûlage} = \left\lceil \frac{P \times 10^{8}}{2^{n}} \right\rceil
```

**Deux façons de payer**

1. **Avec ses propres ConsoM** (ouvert à tous) : le membre envoie les ConsoM requis à la banque d'échange avec la référence de la conversion. La banque les brûle aussitôt ; ils ne deviennent pas un dépôt. L'application crédite 100 % des Points en FECA.
2. **Via la banque d'échange** : les témoins signent une attestation de conversion ; la banque brûle le montant requis sur son stock (section 9). L'application crédite 90 % en FECA ; les 10 % restants vont en FECA aux déposants, au prorata de leurs parts.

Dans les deux cas, la conversion donne droit à la récompense de 35 % (section 6).

Si la banque ne contient pas assez de ConsoM, la conversion via la banque est refusée ; il n'existe aucune réserve de secours.

**Rythme du halving.** Chaque palier est deux fois plus long à atteindre que le précédent : comme il faut deux fois moins de ConsoM par Point, brûler 800 000 ConsoM demande de convertir 8 millions de Points au départ, 16 millions au palier suivant, puis 32 millions. Le halving ralentit donc de lui-même.

**Brûlages volontaires.** Un détenteur peut toujours détruire ses ConsoM depuis son wallet : le standard Jetton le permet, et l'interdire casserait la compatibilité des wallets. L'émetteur, prévenu de chaque brûlage, recrée immédiatement le même montant dans la banque d'échange, comme stock sans propriétaire (section 9). Ces brûlages ne comptent pas pour le halving : l'offre en circulation ne baisse que par les conversions. La recréation fonctionne même pendant une pause.

## 9. Banque d'échange

La banque d'échange est un contrat qui détient des ConsoM pour le compte de ses déposants et les brûle quand un membre convertit via la banque. Elle démarre avec les 70 % de l'allocation des Anciens Contributeurs, soit 3 500 000 ConsoM, et reste fermée aux dépôts et retraits de tous les membres pendant 12 mois.

**Parts.** Chaque déposant détient des parts, pas un montant fixe. Un brûlage réduit le stock sans toucher aux parts, si bien que chacun perd la même proportion de son dépôt et touche la même proportion des frais.

```latex
\text{valeur d'un dépôt} = \text{parts du déposant} \times \frac{\text{stock des déposants}}{\text{total des parts}}
```

**Stock sans propriétaire.** Les ConsoM recréés après un brûlage volontaire entrent dans la banque sans créer de parts. À chaque brûlage de conversion via la banque, le montant est prélevé au prorata entre ce stock et celui des déposants. Les 10 % de frais en FECA vont entièrement aux déposants, au prorata de leurs parts : la part qui correspond au stock sans propriétaire leur est versée en plus, ce qui rééquilibre leurs gains.

**Règles**

1. De T0 à T0 + 12 mois : aucun dépôt, aucun retrait, y compris pour les Anciens Contributeurs. Seuls les brûlages de conversion sont possibles.
2. Après T0 + 12 mois : tout détenteur peut déposer en transférant des ConsoM à la banque. Un retrait est possible 24 h après le dernier dépôt du même déposant.
3. La banque ne brûle son propre stock que sur attestation de conversion signée par 2 témoins sur 3 ; les ConsoM qu'un membre lui envoie pour sa propre conversion sont brûlés dès réception. Chaque attestation porte un numéro qui doit suivre exactement le précédent : une attestation ne peut servir qu'une fois, sans liste qui grossit.
4. Le montant brûlé n'est jamais pris dans l'attestation : la banque demande le nombre de paliers n à l'émetteur, qui répond par message, puis recalcule le brûlage à partir des Points attestés (section 8).
5. La banque publie le nombre de parts de chaque déposant ; l'application s'en sert pour répartir les 10 % de frais en FECA.
6. La banque ne brûle pas plus de 5 % de son stock par période glissante de 24 h pour les conversions via la banque. Une conversion qui dépasserait ce plafond est refusée et peut être refaite dès que la période le permet ; le membre peut aussi convertir avec ses propres ConsoM, qui ne sont pas soumis à ce plafond.

## 10. Sécurité et gouvernance

Le contrat est immuable et n'a pas d'administrateur. Le gardien peut seulement arrêter temporairement ce qui dépend des témoins et remplacer un témoin sous délai public. Il ne peut jamais créer de jetons, changer une règle ou toucher à un solde.

**Témoins**

- Trois clés Ed25519, chacune détenue et déployée par une personne différente. Aucune clé de témoin n'est stockée dans le même service qu'une autre.
- Chaque témoin interroge Wave lui-même et relit la commande avant de signer. Ils dépendent tous du même compte marchand Wave : ce risque résiduel est couvert par les plafonds ci-dessous.
- Une signature n'est comptée que si elle vient de deux témoins différents.

**Gardien** : le Multisig v2 officiel de TON (2 signatures sur 3, audité par Zellic et Trail of Bits), avec trois signataires qui sont trois personnes distinctes, chacune sur un wallet matériel.

| Action du gardien | Prise d'effet | Limite |
| --- | --- | --- |
| Mettre en pause | Immédiate | 14 jours au plus, fin automatique ; une seule pause commencée par période de 30 jours |
| Lever la pause | Immédiate | Aucune |
| Remplacer la clé d'un témoin | 7 jours après l'annonce, visible sur la chaîne | Un remplacement par période de 30 jours ; annulable pendant le délai |

La pause est immédiate parce qu'un délai de 7 jours laisserait une faille ouverte pendant 7 jours ; elle ne fait courir aucun risque aux membres, puisqu'elle ne touche à aucun solde. Le remplacement de témoin, lui, est le vrai pouvoir sensible : remplacer deux clés donnerait le contrôle des émissions. D'où le délai, la limite d'un remplacement par mois et les plafonds globaux.

**Ce que la pause arrête** : les bons d'émission, les libérations de vesting, les réclamations de genèse et les brûlages de la banque. Les transferts, les brûlages volontaires et leur recréation dans la banque ne sont jamais arrêtés.

**Plafonds globaux** (filet de sécurité si deux témoins sont compromis)

- Émission totale par période de 24 h, prévente comprise : 2 000 000 ConsoM, à recalibrer après le testnet.
- Brûlage de la banque par période de 24 h : 5 % du stock de la banque au plus. Un usage normal reste bien en dessous ; si deux témoins étaient compromis, de fausses conversions ne pourraient brûler que 5 % par jour, ce qui laisse le temps de déclencher la pause. Les conversions avec ses propres ConsoM ne sont pas concernées.

**Avant le réseau principal** : deux audits indépendants du code final, des tests qui prouvent les invariants (offre ≤ 230 M, aucune émission sans 2 signatures, aucun paiement utilisé deux fois), une période de testnet publique et un programme de récompense des failles.

## 11. Passage testnet → réseau principal

Le testnet sert à prouver ce contrat exact, pas à créer des soldes : les jetons du testnet n'ont aucune valeur et ne sont jamais transférés sur le réseau principal. Les deux déploiements utilisent le même code, avec un `network_id` et des clés de témoins différents ; une clé de testnet n'est jamais réutilisée sur le réseau principal.

**Genèse.** Au déploiement sur le réseau principal, l'émetteur grave une racine de Merkle par liste de genèse : Anciens Contributeurs (part de 30 % réclamable) et préventes réellement payées avant T0. Chaque ligne contient l'identifiant de membre, la catégorie et le montant. Le membre réclame sa ligne avec sa preuve de Merkle ; un petit contrat « réclamation de genèse » par ligne empêche toute double réclamation. La part de 70 % des Anciens Contributeurs est déposée directement dans la banque au déploiement.

**Aucune reprise des phases de test.** Ni les soldes du testnet, ni les 20 réclamations déjà créées sur l'ancien contrat ne sont repris : il n'y a eu aucun achat réel. Chaque prévente payée avant T0 est vérifiée paiement par paiement avant d'entrer dans la liste de genèse.

**Critères pour ouvrir le réseau principal**

- [ ] Code final audité deux fois, corrections revues
- [ ] Tous les invariants de la section 10 couverts par des tests automatiques
- [ ] Testnet public : réclamations, vesting, banque, pause et remplacement de témoin exercés en conditions réelles
- [ ] Coût de chaque opération mesuré et affiché dans l'application
- [ ] Instantané de genèse publié et vérifiable par chaque membre
- [ ] Revue juridique terminée pour la prévente
- [ ] Clés des témoins et du gardien remises à des personnes distinctes

## 12. Décisions ouvertes et écarts

Les treize points sont tranchés ; la spécification est prête pour le développement.

| # | Décision | Recommandation |
| --- | --- | --- |
| 1 | P\_max : nombre maximum de Points par franc payé | Tranché : 0,5 Point par franc payé (les Points valent au plus 50 % de la marge, toujours inférieure au prix) |
| 2 | Émission maximale par 24 h, tout compris | Tranché : 2 000 000 ConsoM, à recalibrer après le testnet |
| 3 | Brûlage maximal de la banque par 24 h | Tranché : 5 % du stock de la banque par 24 h ; au-delà, les conversions via la banque attendent la période suivante (section 9) |
| 4 | Délai entre livraison et signature d'une récompense d'achat | Tranché : 48 h ; en cas de problème, l'acheteur écrit à l'équipe |
| 5 | Vérification du parrainage | Tranché : parrain enregistré dans le compte membre, modifiable par l'équipe seule (bon signé 2 sur 3, pour les achats suivants) ; niveau 1 vérifié par le contrat, niveaux 2 à 5 attestés |
| 6 | Lien membre ↔ adresse TON | Tranché : fixé par la première réclamation ; changement par bon signé 2 sur 3, effectif après 7 jours |
| 7 | Nombre maximal de paliers de halving n\_max | Tranché : 30, simple sécurité technique. Avec 230 M, environ 20 paliers sont possibles en théorie, mais chaque palier demande deux fois plus de conversions que le précédent : ce plafond ne sera jamais atteint |
| 8 | Unité du bonus d'investissement | Tranché : 1 FECA investi = 0,30 ConsoM |
| 9 | Paliers après la 1re année | Tranché : ce qui dépasse le dernier palier de la 1re année est reporté (section 8) |
| 10 | « Pause renouvelable une fois par mois » | Tranché : une seule pause commencée par période de 30 jours |
| 11 | 20 réclamations déjà créées sur l'ancien contrat | Tranché : non reprises. C'était le testnet, sans achat réel ; aucun gain de test n'est repris sur le réseau principal |
| 12 | Préventes payées avant T0 | Tranché : les préventes réellement payées avant T0 sont reprises dans la genèse, dans le plafond de la prévente |
| 13 | Langage | Tranché : Tolk pour le code sur mesure, wallets Jetton 2.0 non modifiés ; le contrat actuel en Tact est abandonné |

**Écarts par rapport à la synthèse du 14 octobre**

| Synthèse | Spécification | Raison |
| --- | --- | --- |
| Émission uniquement prouvée par Wave | Paiement Wave préalable, plus trois exceptions de genèse | Les Anciens Contributeurs, l'équipe et les gains de test n'ont pas de paiement |
| Pause soumise au délai de 7 jours | Pause immédiate ; délai réservé au remplacement de témoin | Une faille resterait ouverte 7 jours |
| Missions sociales ouvertes à « tous » | Réservées aux membres avec au moins un paiement | Faux comptes ; et la règle « tout part d'un achat » |
| Plafond de 50 000 par membre seulement | Plus un plafond global journalier | Le contrat ne voit que des adresses ; un membre peut en créer plusieurs |
| Rien sur le lien avec l'achat | Budget de paiement qui borne chaque récompense | Le contrat recalcule chaque montant lui-même |

**Décisions prises le 14 octobre, après la synthèse**

- Bonus de 1er achat : 500 ConsoM au lieu de 300.
- Récompense de 35 % versée à la conversion des Points, et non à l'achat ; des Points expirés ne donnent rien.
- Parrainage versé dès l'achat attesté du filleul.
- Seuls les brûlages de conversion comptent pour le halving ; ce qui dépasse le dernier palier de la 1re année est reporté.
- Brûlage volontaire : recréé dans la banque comme stock sans propriétaire, utilisé au prorata des dépôts ; les frais correspondants sont versés en plus aux déposants.
- Commissions de prévente au parrain : 500, 5 000 et 10 000 Points.

Conséquence à garder en tête : pendant les 18 mois de récompenses, une conversion crée plus de ConsoM qu'elle n'en brûle (35 reçus pour 10 brûlés au départ, pour 100 Points). L'offre en circulation augmente donc pendant cette période, et la rareté s'installe après.

## Sources

- [Jettons : fonctionnement et messages (TEP-74, TEP-89)](https://docs.ton.org/standard/tokens/jettons/how-it-works)
- [Comparaison des implémentations de Jetton (Jetton 2.0 recommandé)](https://docs.ton.org/standard/tokens/jettons/comparison)
- [Standard TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md)
- [Découpage en contrats enfants (contract sharding)](https://docs.ton.org/contract-dev/contract-sharding)
- [Limites de la blockchain (état, messages, gaz)](https://docs.ton.org/foundations/limits)
- [Sécurité des contrats : signatures et anti-rejeu](https://docs.ton.org/contract-dev/security)
- [Wallet V5 : identifiant de réseau -239 / -3](https://docs.ton.org/llms/contracts/standard/wallets/v5/content.md)
- [Multisig v2 officiel](https://github.com/ton-blockchain/multisig-contract-v2)
- [Langage Tolk](https://docs.ton.org/tolk/overview)
