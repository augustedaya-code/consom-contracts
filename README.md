# ConsoM — contrats TON

Contrats de ConsoM, la couche crypto de TonMarché, écrits en [Tolk](https://docs.ton.org/tolk/overview).
La référence est [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) : chaque règle du code renvoie à une de ses sections.

> **État : en développement, testnet uniquement.** L'émetteur, le budget de paiement, le compte membre et la banque
> d'échange sont écrits et testés ensemble, avec la part de l'équipe (calendrier gravé) et la réclamation des Anciens
> Contributeurs, la réserve de la Fondation et les contributions du lancement anticipé. Restent à écrire : les préventes payées
> avant T0, le changement d'adresse liée et l'enregistrement du parrain.

## Contenu

| Dossier | Rôle |
| --- | --- |
| `contracts/consom/` | Émetteur (`minter.tolk`), budget de paiement (`budget.tolk`), compte membre (`member.tolk`), banque d'échange (`bank.tolk`), parts d'un déposant (`bank_share.tolk`), messages, constantes, stockage, codes d'erreur |
| `contracts/jetton/` | Wallet Jetton shardé (principe Jetton 2.0), repris sans modification — voir `NOTICE.md` |
| `wrappers/` | Interface TypeScript : stockage initial, bons, messages, lectures |
| `tests/` | Tests automatiques de bout en bout, avec tous les vrais contrats |
| `scripts/compile.ts` | Compilation avec le compilateur Tolk officiel |
| `docs/` | Spécification |

## Compilateur figé

Le compilateur Tolk est figé à la version **1.4.2** (`package.json` + `package-lock.json`) : c'est celle qui reproduit à l'identique
les empreintes du déploiement du 14 octobre 2026. Ne pas la changer sans refaire toute la vérification des empreintes.

Empreintes après le lot C1 (réclamation par un tiers : le serveur de TonMarché présente les bons et paie les frais) :

| Contrat | Empreinte | Changée ? |
| --- | --- | --- |
| Émetteur (`minterCode`) | `b8c562b1af18a5f62f2ae6afb638a47fc1342fbbe64da53678a0bb6f22637f49` | oui |
| Budget de paiement (`budgetCode`) | `337bccdadf220f17d416342c156db31ed9cb548203867f8df45e900d102c6204` | oui |
| Wallet (`walletCode`) | `7bfa53bce90ce26cd368ec2989eba2bd15d286104742f0e04659f485a03012ba` | non |
| Compte membre (`memberCode`) | `3f38c81f11872c32a92ed936271b7af909ac34c72cfafa2e41961a049bb46a62` | oui |
| Banque (`bankCode`) | `7ca5bc4d2250b411b8e6224c5f6eceb975caeebc53eb3d69f011b4fabd9d2b02` | non |
| Parts (`shareCode`) | `d1d858f0931c3b6782bd80507019147fd74f07b36763690643e9a7b330d07138` | non |

## Lancer les tests

```bash
npm install
npm test
npm run build     # écrit build/<Contrat>.json (code compilé et son empreinte)
```

Node.js 22.18 ou plus récent (les tests TypeScript tournent directement avec `node --test`).

## Parcours d'un bon

L'émetteur est le seul intermédiaire : le budget et le compte membre n'acceptent que ses messages, et lui-même ne reconnaît
un budget ou un compte membre qu'en recalculant son adresse à partir de son code.

1. Le membre, ou le serveur de TonMarché à sa place (il paie alors les frais), envoie le bon et deux signatures à l'émetteur, qui vérifie tout et réserve les plafonds. Les jetons vont toujours au bénéficiaire du bon ; l'excédent de TON revient à l'expéditeur.
2. Bons liés à un paiement Wave (prévente, enregistrement d'achat, parrainage, 1er achat, Bonus CHIKA) : le budget du paiement vérifie
   que la récompense n'a pas déjà été versée et que les données attestées sont les mêmes, puis renvoie le bon à l'émetteur.
3. L'émetteur transmet au compte du membre, qui applique ses règles et répond toujours : accepté ou refusé (avec la raison).
4. Accepté : l'émetteur crée la part immédiate. Refusé : il libère sa réservation et, si le refus est passager,
   demande au budget de libérer l'emplacement.

## Ce que fait l'émetteur

- **Bons d'émission** : vérifie 2 signatures Ed25519 de 2 témoins différents, le réseau (-239 / -3), l'adresse de l'émetteur,
  l'expiration (7 jours au plus), la fenêtre de la catégorie (prévente 18 mois,
  récompenses 24 mois depuis T0 ; aucune limite pour les conversions et les Anciens Contributeurs), et **recalcule lui-même le montant** (packs de prévente, 5 %, 2,5/1,3/0,7/0,4/0,1 %, 500, 150, 0,04 par CHIKA investi, 0,3 % de bonus CHIKA, 30 % de la part d'un Ancien Contributeur).
  Il réserve le montant sur le plafond de la catégorie et sur le plafond global de 2 000 000 ConsoM par 24 h, puis transmet
  le bon au budget du paiement Wave ou au compte du membre.
- **Adresses interdites de réception** (règle A16) : le serveur de TonMarché ne peut JAMAIS recevoir de ConsoM créés. Une liste de
  0 à 8 adresses (wallet relais, autres wallets du serveur ou de l'équipe technique) est gravée au déploiement
  (`get_forbidden_recipients`) ; l'émetteur et la banque sont toujours interdits en plus. Toute création vers une adresse
  interdite (prévente, récompenses, Ancien Contributeur, lancement anticipé, ...) est refusée par le budget ou le compte
  membre avec la raison **17 « destinataire interdit »** : réservation rendue, rien de créé, rien de marqué. Le relais peut
  toujours présenter des bons et payer les frais ; les conversions ne changent pas.
- **Contrôles au déploiement** (règle A3) : le contrat vérifie ses données gravées à chaque message, le premier compris. Deux
  clés de témoins identiques, une clé à zéro, un gardien ou une équipe vide (ou égal à l'émetteur ou à la banque), une équipe
  présente dans la liste interdite, plus de 8 adresses interdites : le contrat refuse tout (codes 427, 480 à 486) et ne
  peut plus rien créer. Le script de déploiement et le wrapper font les mêmes contrôles avant d'envoyer quoi que ce soit.
- **Création** : seulement sur approbation d'un compte membre dont l'adresse est calculée à partir de son code ; jamais plus
  de 250 M (jetons en circulation + brûlés par conversion).
- **Brûlages** (règle A10) : seul le programme de conversion (la banque d'échange) détruit des ConsoM ; ces brûlages sont
  définitifs, font baisser l'offre et avancer le halving. Tout autre brûlage est refusé par l'émetteur (erreur 417) : le
  message rebondit, le wallet rétablit le solde du membre, l'offre et le compteur des paliers ne bougent pas, et rien n'est
  recréé. Un ConsoM détruit n'est jamais recréé. Le wallet Jetton reste inchangé (il ne connaît pas l'adresse de la banque).
- **Halving** : un palier par 15 000 000 ConsoM brûlés par les conversions ; 16 divisions au plus (17 paliers), puis le taux ne bouge plus.
  `get_burn_for_points(points)` donne le brûlage à payer, arrondi au supérieur.
- **Gardien** (Multisig v2) : pause immédiate de 14 jours au plus (une par 30 jours), levée immédiate, remplacement d'un témoin
  après 7 jours (un par 30 jours), annulable. Aucun autre pouvoir.
- **Genèse** : dépôt unique dans la banque de 3 500 000 ConsoM (Anciens Contributeurs) et de 100 000 ConsoM (réserve de la
  Fondation, stock à part).
- **Part de l'équipe** (règle A9, 5 000 000) : l'adresse qui la reçoit est gravée au déploiement (`teamAddress`, un
  portefeuille Multisig) et ne peut jamais changer. Rien avant T0 + 12 mois, puis 1/24 par période de 30 jours terminée
  (la dernière part prend le reste), tout à T0 + 36 mois. « Libérer la part de l'équipe » peut être appelé par n'importe qui
  (il ne paie que les frais) : elle crée vers l'adresse de l'équipe la différence entre le libéré et le déjà créé, et rien
  d'autre. Puisée dans la réserve équipe seule ; ni fenêtre de 24 mois, ni plafond de 50 000 ; elle compte dans le plafond
  global du jour (si la place manque, elle crée ce qui rentre et le reste attend le prochain appel) ; la pause la bloque.
  Lectures : `get_team_vesting` (libéré, créé, prochaine date) et `get_team_address`.
- **Contributions du lancement anticipé** (décision du 30 octobre 2026) : bon signé 2 sur 3 (type 12) avec l'adresse, l'identifiant
  unique de la contribution (empreinte) et le total T. Pris dans la réserve de prévente : 30 % de T créés sur l'adresse, 70 %
  créés dans la banque avec de NOUVELLES parts attribuées à l'adresse (prix du moment). Compte éligible, une seule fois par
  contribution, sans limite de temps, hors plafond de 50 000 par membre, T compte dans le plafond global du jour. Le total
  de toutes les contributions est gravé au déploiement (`earlyContributionsTotal`) et retenu dans la réserve de prévente, pour que
  la règle des invendus de T0 + 18 mois ne l'efface pas.
- **Anciens Contributeurs** (règle A8, 5 000 000) : bon signé 2 sur 3 « réclamation d'un Ancien Contributeur » (adresse,
  empreinte de l'identifiant, part totale T). Le contrat en crée 30 % pour l'adresse (réserve Anciens Contributeurs) et lui
  attribue 70 % en parts de la banque, prises dans les parts à attribuer de la genèse (rien n'est créé pour cette partie) ;
  le compte devient éligible (participant à la prévente). Une seule réclamation par identifiant, sans limite de temps, hors
  plafond de 50 000 par membre, comptée dans le plafond global du jour pour les 30 % créés. T est un multiple de 10 unités
  de base, pour que les deux parts soient exactes et que le total ne dépasse jamais 5 000 000.

## Ce que font le budget de paiement et le compte membre

- **Budget de paiement** (un par paiement Wave) : un emplacement par récompense (prévente, enregistrement d'achat, 1er achat,
  parrainage niveaux 1 à 5), chacun versé une seule fois ; mêmes montant et Points pour tous les bons d'un paiement ;
  un paiement de prévente ne donne que son pack.
- **Compte membre** (un par membre) : adresse liée à la première réclamation ; droit au parrainage ouvert par une prévente ;
  Points attestés, convertibles 7 jours (au-delà, perdus), qui bornent la récompense de 5 % à la conversion ; total des
  Points, qui borne le bonus d'investissement (30 % des Points) ; bonus de
  1er achat et missions une seule fois, missions réservées aux membres ayant un paiement ; numéros de bon croissants pour
  les conversions et investissements ; plafond de 50 000 par 24 h (hors prévente). Toutes les récompenses sont versées
  en entier, tout de suite.
- Chacun garde 0,01 TON pour ses frais de stockage.

## Ce que fait la banque d'échange

- **Deux stocks** dans son wallet : celui des déposants (en parts, genèse comprise) et les jetons en attente d'une conversion
  avec ses propres ConsoM. Le stock n'est fait que de ConsoM déposés. Un envoi sans objet reconnu (ni dépôt, ni conversion,
  ni genèse) est refusé : les jetons retournent à l'expéditeur.
- **Conversion via la banque** : bon signé, l'émetteur calcule le brûlage au taux courant, le compte membre refuse un bon
  déjà utilisé, la banque brûle sur le stock des déposants (les parts ne changent pas). Au plus 5 % de ce stock par 24 h ;
  au-delà, rien n'est brûlé.
- **Conversion avec ses propres ConsoM** : le membre envoie ses ConsoM à la banque avec le bon signé ; l'émetteur vérifie,
  la banque brûle le montant requis et rend l'excédent. Bon invalide, déjà utilisé ou montant insuffisant : tout est rendu.
  Pas de plafond de 5 %.
- **Dépôts et retraits** : fermés 12 mois (un dépôt est rendu) ; ensuite, dépôt contre des parts, retrait 24 h après
  le dernier dépôt, à la valeur actuelle des parts. Un contrat « parts » par déposant.
- **Genèse** : les 3 500 000 ConsoM des Anciens Contributeurs y entrent comme parts à attribuer. Sur ordre de l'émetteur
  seul (après un bon d'Ancien Contributeur), la banque en attribue à une adresse : les parts à attribuer diminuent, le
  contrat « parts » de l'adresse est crédité, le total des parts et le stock ne changent pas. Les retraits restent soumis aux
  règles de la banque (fermée 12 mois, puis 24 h après la dernière arrivée de parts du déposant, attribution comprise).
- **Réserve de la Fondation** (règle A13) : 100 000 ConsoM dans un stock à part, jamais en parts, jamais retirés, brûlés ni
  transférés. Elle s'ouvre toute seule quand on est après T0 + 24 mois ET que le stock des déposants est « vide » (moins de
  1 ConsoM) depuis 30 jours de suite (« vide depuis » est noté par la banque et effacé seulement si le stock remonte à 1 ConsoM
  ou plus) ; une fois ouverte, elle le reste. Ouverte, elle couvre le reste d'une conversion via la banque que le stock (ou le
  plafond de 5 %) ne couvre pas, sans rien brûler, au plus 100 000 ConsoM par conversion (sinon refus en entier).
- **Résultat d'une conversion** : après chaque conversion via la banque, la banque envoie à celui qui a présenté le bon un
  message `ConversionResult` (op `0xc0150060`) avec la part brûlée par la banque et la part couverte par la Fondation ; le
  serveur en déduit à qui verser les 10 % de frais. Décodage : `decodeConversionResult` dans `wrappers/ConsoMMinter.ts`.
- Seuls ses brûlages comptent pour le halving, et elle ne brûle que sur ordre de l'émetteur.

## Choix d'implémentation à connaître

0. Quand l'émetteur envoie deux messages pour un même bon (Ancien Contributeur, contribution du lancement anticipé, genèse), le
   second reçoit une valeur calculée (reçu − déjà envoyé − 0,03 TON de marge) : un message à valeur fixe ne réduit pas la valeur
   « restante » du message reçu, et le prendre en mode « tout le reste » ferait payer le premier par le solde de l'émetteur.

1. Le montant de chaque récompense est recalculé par l'émetteur (et non par le budget, comme l'indiquait la spécification) :
   c'est plus simple et plus sûr. Le budget et le compte membre gardent le contrôle des emplacements déjà versés,
   des doublons, de l'éligibilité, du plafond de 50 000 par membre et de l'expiration des Points.
2. Un bon refusé plus loin dans la chaîne libère sa réservation de catégorie, mais reste compté dans le plafond du jour.
3. Une approbation déjà en route quand la pause commence est honorée ; les nouveaux bons de création et les conversions via la banque sont bloqués, pas la conversion avec ses propres ConsoM.
4. Un brûlage demandé par un membre est refusé par l'émetteur, pas par son wallet : l'adresse de la banque n'est pas connue
   du wallet, et la lui donner changerait le code (donc l'adresse) de tous les coffres. Le membre paie les petits frais du
   rebond ; son solde est rétabli. Des jetons envoyés à la banque avec trop peu de TON pour être rendus restent dans son
   wallet sans entrer dans aucun stock.
5. Conséquence de la règle « une pause par 30 jours » : après une pause, le gardien ne peut plus en déclencher pendant le
   reste des 30 jours.
6. Si un parrain n'est pas éligible, ou si un bonus a déjà été reçu, l'emplacement du budget reste marqué (règle de la
   section 6). Si le refus est passager (plafond du jour, mauvaise adresse), l'emplacement est libéré et le bon pourra
   repasser tant qu'il n'a pas expiré.
7. Si la création de jetons échoue à l'émetteur après l'acceptation du compte membre (cas qui ne devrait pas arriver :
   plafond absolu de 250 M), l'emplacement et les compteurs du compte membre restent consommés.
8. Une conversion via la banque refusée faute de stock ou à cause du plafond de 5 % consomme quand même le numéro du bon :
   l'application doit émettre un nouveau bon.
9. Des ConsoM envoyés à la banque sans objet reconnu, ou un dépôt joint de moins de 0,05 TON, rejoignent le stock sans
   propriétaire.
10. Chaque contrat ne renvoie que les TON qu'il vient de recevoir et garde son propre solde (0,01 TON pour un budget,
    un compte membre ou des parts ; 0,05 TON pour la banque).

## Paramètres de déploiement

Tout ce qui suit est GRAVÉ dans le stockage de l'émetteur au déploiement. Le contrat n'a aucun propriétaire et aucune fonction
d'administration : aucun message ne peut changer ces valeurs, et le code lui-même ne peut pas être remplacé. Le contrat
contrôle ces valeurs à chaque message (voir « Contrôles au déploiement ») : un déploiement mal paramétré est inutilisable
et ne peut pas être corrigé, il faut alors en déployer un autre.

| Paramètre | Qui le fournit | Pourquoi il ne pourra plus changer |
| --- | --- | --- |
| **3 clés publiques de témoins** (Ed25519, 32 octets chacune, distinctes, non nulles) | Chacune par un témoin différent, qui garde seul sa clé privée (fichier `deployments/<réseau>.config.json`) | Gravées dans le stockage. Aucun administrateur ne peut les changer. **Seule exception :** le gardien peut remplacer UNE clé à la fois, annoncé sur la chaîne, effectif après 7 jours, annulable, une fois par 30 jours ; il ne peut ni ajouter une clé nulle ni dupliquer une clé existante |
| **Gardien** (adresse du Multisig v2, 2 signatures sur 3) | Les trois signataires du Multisig, qui le créent avant le déploiement | Gravée ; aucune fonction ne la modifie. Le gardien ne peut que mettre en pause (14 jours au plus) et remplacer un témoin sous délai |
| **Équipe** (adresse du Multisig de l'équipe, reçoit les 5 000 000 de la part de l'équipe) | L'équipe, avant le déploiement | Gravée : personne, pas même le gardien, ne peut rediriger la part de l'équipe. Elle ne doit pas figurer dans la liste interdite (sinon le déploiement échoue) |
| **Liste des adresses interdites de réception** (0 à 8 adresses) | L'équipe technique : wallet relais du serveur, autres wallets du serveur ou de l'équipe technique | Gravée : la garantie « le serveur ne reçoit jamais de ConsoM créés » (A16) ne doit dépendre de personne. Une liste vide est acceptée par le contrat mais le script de déploiement affiche un avertissement : sur le réseau principal, le relais doit y figurer |
| **T0** (ouverture du réseau, secondes Unix) | L'équipe technique, au moment du déploiement (variable `T0`, par défaut maintenant) | Toutes les fenêtres (prévente 18 mois, récompenses 24 mois, équipe 12 à 36 mois, Fondation 24 mois) se comptent depuis T0 : le déplacer changerait les droits de chacun |
| **Réseau** (`networkId` : -239 réseau principal, -3 testnet) | Le script (`testnet` ou `mainnet`) | Un bon signé pour un réseau n'est jamais valable sur l'autre ; le changer permettrait de rejouer des bons |
| **Total du lancement anticipé** (`earlyContributionsTotal`, en ConsoM entiers, 0 à 100 000 000) | Le serveur de TonMarché : somme de la liste des contributions du réseau d'essai (variable `EARLY_CONTRIBUTIONS_TOTAL`, 0 sur le testnet) | Retenu dans la réserve de prévente pour que la règle des invendus de T0 + 18 mois ne l'efface pas : s'il pouvait changer, on pourrait retenir ou libérer des ConsoM à volonté |

Sont aussi gravés par le déploiement, sans que personne n'ait de choix à faire : les codes compilés du wallet Jetton, du budget de
paiement, du compte membre, de la banque et des parts d'un déposant, ainsi que le lien des métadonnées du Jetton (empreintes
des codes dans `deployments/<réseau>.json`).

Pour le testnet (`npm run deploy:testnet`, ou le bouton « Run workflow » du GitHub Action « Déployer sur le testnet ») :
`GUARDIAN_ADDRESS`, `TEAM_ADDRESS`, `EARLY_CONTRIBUTIONS_TOTAL`, `FORBIDDEN_RECIPIENTS` (facultatif, adresses séparées par des
virgules), `T0` (facultatif). Les trois clés de témoins viennent de `deployments/testnet.config.json`. Le script ne lit ni
n'affiche aucun secret autre que le wallet de déploiement, qui ne sort jamais de l'environnement.

## Coût mesuré (simulateur)

| Opération | Coût pour le membre |
| --- | --- |
| Première réclamation (crée le compte membre, le budget et le wallet) | environ 0,028 TON |
| Bon lié à un nouveau paiement (crée son budget) | environ 0,016 à 0,019 TON |
| Récompense de conversion (5 %) | environ 0,007 TON |
| Conversion via la banque | environ 0,007 TON |
| Conversion avec ses propres ConsoM | environ 0,011 TON |
| Premier dépôt dans la banque (crée les parts) | environ 0,015 TON |
| Retrait | environ 0,004 TON |

Les créations de contrats incluent leur réserve de stockage. À remesurer sur le testnet.

## Prochaines étapes

1. Préventes payées avant T0.
2. Compte membre : changement d'adresse liée (bon signé, effectif après 7 jours) et parrain enregistré dans le compte
   (décisions 5 et 6 de la spécification) — pas encore écrits.
3. Scripts de déploiement testnet, puis audits.
