# ConsoM — contrats TON

Contrats de ConsoM, la couche crypto de TonMarché, écrits en [Tolk](https://docs.ton.org/tolk/overview).
La référence est [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) : chaque règle du code renvoie à une de ses sections.

> **État : en développement, testnet uniquement.** L'émetteur, le budget de paiement, le compte membre et la banque
> d'échange sont écrits et testés ensemble. Restent à écrire : les réclamations de genèse, le blocage des ConsoM de l'équipe,
> le changement d'adresse liée et l'enregistrement du parrain.

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
  l'expiration (7 jours au plus), la fenêtre de la catégorie (prévente 12 mois,
  récompenses 18 mois depuis T0), et **recalcule lui-même le montant** (packs de prévente, 35 %, 15/7/3,5/1,5/0,5 %, 500, 150, 30 %).
  Il réserve le montant sur le plafond de la catégorie et sur le plafond global de 2 000 000 ConsoM par 24 h, puis transmet
  le bon au budget du paiement Wave ou au compte du membre.
- **Création** : seulement sur approbation d'un compte membre dont l'adresse est calculée à partir de son code ; jamais plus
  de 250 M (jetons en circulation + brûlés par conversion).
- **Brûlages** : ceux de la banque d'échange (conversions) sont définitifs et font avancer le halving ; tous les autres sont
  recréés aussitôt dans la banque comme stock sans propriétaire.
- **Halving** : un palier par 800 000 brûlés la 1re année, puis par 12 000 000 avec report ; au plus 30 paliers.
  `get_burn_for_points(points)` donne le brûlage à payer, arrondi au supérieur.
- **Gardien** (Multisig v2) : pause immédiate de 14 jours au plus (une par 30 jours), levée immédiate, remplacement d'un témoin
  après 7 jours (un par 30 jours), annulable. Aucun autre pouvoir.
- **Genèse** : dépôt unique de 3 500 000 ConsoM des Anciens Contributeurs dans la banque.

## Ce que font le budget de paiement et le compte membre

- **Budget de paiement** (un par paiement Wave) : un emplacement par récompense (prévente, enregistrement d'achat, 1er achat,
  parrainage niveaux 1 à 5), chacun versé une seule fois ; mêmes montant et Points pour tous les bons d'un paiement ;
  un paiement de prévente ne donne que son pack.
- **Compte membre** (un par membre) : adresse liée à la première réclamation ; droit au parrainage ouvert par une prévente ;
  Points attestés, convertibles 7 jours (au-delà, perdus), qui bornent la récompense de 35 % à la conversion ; total des
  Points, qui borne le bonus d'investissement de 30 % ; bonus de
  1er achat et missions une seule fois, missions réservées aux membres ayant un paiement ; numéros de bon croissants pour
  les conversions et investissements ; plafond de 50 000 par 24 h (hors prévente). Toutes les récompenses sont versées
  en entier, tout de suite.
- Chacun garde 0,01 TON pour ses frais de stockage.

## Ce que fait la banque d'échange

- **Trois stocks** dans son wallet : celui des déposants (en parts), le stock sans propriétaire (brûlages volontaires
  recréés, envois sans objet) et les jetons en attente d'une conversion avec ses propres ConsoM.
- **Conversion via la banque** : bon signé, l'émetteur calcule le brûlage au taux courant, le compte membre refuse un bon
  déjà utilisé, la banque brûle au prorata des deux stocks (les parts ne changent pas). Au plus 5 % du stock par 24 h ;
  au-delà, rien n'est brûlé.
- **Conversion avec ses propres ConsoM** : le membre envoie ses ConsoM à la banque avec le bon signé ; l'émetteur vérifie,
  la banque brûle le montant requis et rend l'excédent. Bon invalide, déjà utilisé ou montant insuffisant : tout est rendu.
  Pas de plafond de 5 %.
- **Dépôts et retraits** : fermés 12 mois (un dépôt est rendu) ; ensuite, dépôt contre des parts, retrait 24 h après
  le dernier dépôt, à la valeur actuelle des parts. Un contrat « parts » par déposant.
- **Genèse** : les 3 500 000 ConsoM des Anciens Contributeurs y entrent comme parts à attribuer.
- Seuls ses brûlages comptent pour le halving, et elle ne brûle que sur ordre de l'émetteur.

## Choix d'implémentation à connaître

1. Le montant de chaque récompense est recalculé par l'émetteur (et non par le budget, comme l'indiquait la spécification) :
   c'est plus simple et plus sûr. Le budget et le compte membre gardent le contrôle des emplacements déjà versés,
   des doublons, de l'éligibilité, du plafond de 50 000 par membre et de l'expiration des Points.
2. Un bon refusé plus loin dans la chaîne libère sa réservation de catégorie, mais reste compté dans le plafond du jour.
3. Une approbation déjà en route quand la pause commence est honorée ; les nouveaux bons sont bloqués.
4. Un brûlage volontaire doit être accompagné d'au moins 0,1 TON pour financer sa recréation ; sinon il est annulé et le
   solde du wallet est rétabli.
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

## Coût mesuré (simulateur)

| Opération | Coût pour le membre |
| --- | --- |
| Première réclamation (crée le compte membre, le budget et le wallet) | environ 0,028 TON |
| Bon lié à un nouveau paiement (crée son budget) | environ 0,016 à 0,019 TON |
| Récompense de conversion (35 %) | environ 0,007 TON |
| Conversion via la banque | environ 0,007 TON |
| Conversion avec ses propres ConsoM | environ 0,011 TON |
| Premier dépôt dans la banque (crée les parts) | environ 0,015 TON |
| Retrait | environ 0,004 TON |
| Brûlage volontaire recréé dans la banque | environ 0,024 TON |

Les créations de contrats incluent leur réserve de stockage. À remesurer sur le testnet.

## Prochaines étapes

1. Réclamations de genèse (racines de Merkle) : Anciens Contributeurs (part de 30 %, attribution de leurs parts dans la banque, droit au parrainage), préventes payées avant T0.
2. Blocage des ConsoM de l'équipe (5 M : 12 mois de blocage puis 24 mois linéaires).
3. Compte membre : changement d'adresse liée (bon signé, effectif après 7 jours) et parrain enregistré dans le compte
   (décisions 5 et 6 de la spécification) — pas encore écrits.
4. Scripts de déploiement testnet, puis audits.
