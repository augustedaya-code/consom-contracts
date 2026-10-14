# ConsoM — contrats TON

Contrats de ConsoM, la couche crypto de TonMarché, écrits en [Tolk](https://docs.ton.org/tolk/overview).
La référence est [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) : chaque règle du code renvoie à une de ses sections.

> **État : en développement, testnet uniquement.** L'émetteur, le budget de paiement et le compte membre sont écrits et
> testés ensemble. La banque d'échange, les réclamations de genèse et le vesting de l'équipe restent à écrire : en attendant,
> la banque est remplacée par un contrat de test (`tests/stubs/bank_stub.tolk`) qui ne doit jamais être déployé.

## Contenu

| Dossier | Rôle |
| --- | --- |
| `contracts/consom/` | Émetteur (`minter.tolk`), budget de paiement (`budget.tolk`), compte membre (`member.tolk`), messages, constantes, stockage, codes d'erreur |
| `contracts/jetton/` | Wallet Jetton shardé (principe Jetton 2.0), repris sans modification — voir `NOTICE.md` |
| `wrappers/` | Interface TypeScript : stockage initial, bons, messages, lectures |
| `tests/` | Tests automatiques ; `tests/stubs/` contient des contrats de remplacement, **pour les tests uniquement** |
| `scripts/compile.ts` | Compilation avec le compilateur Tolk officiel |
| `docs/` | Spécification |

## Lancer les tests

```bash
npm install
npm test          # 62 tests
npm run build     # écrit build/<Contrat>.json (code compilé et son empreinte)
```

Node.js 22.18 ou plus récent (les tests TypeScript tournent directement avec `node --test`).

## Parcours d'un bon

L'émetteur est le seul intermédiaire : le budget et le compte membre n'acceptent que ses messages, et lui-même ne reconnaît
un budget ou un compte membre qu'en recalculant son adresse à partir de son code.

1. Le wallet du membre envoie le bon et deux signatures à l'émetteur, qui vérifie tout et réserve les plafonds.
2. Bons liés à un paiement Wave (prévente, enregistrement d'achat, parrainage, 1er achat) : le budget du paiement vérifie
   que la récompense n'a pas déjà été versée et que les données attestées sont les mêmes, puis renvoie le bon à l'émetteur.
3. L'émetteur transmet au compte du membre, qui applique ses règles et répond toujours : accepté ou refusé (avec la raison).
4. Accepté : l'émetteur crée la part immédiate. Refusé : il libère sa réservation et, si le refus est passager,
   demande au budget de libérer l'emplacement.

## Ce que fait l'émetteur

- **Bons d'émission** : vérifie 2 signatures Ed25519 de 2 témoins différents, le réseau (-239 / -3), l'adresse de l'émetteur,
  l'expiration (7 jours au plus), que l'expéditeur est le bénéficiaire, la fenêtre de la catégorie (prévente 12 mois,
  récompenses 18 mois depuis T0), et **recalcule lui-même le montant** (packs de prévente, 35 %, 15/7/3,5/1,5/0,5 %, 500, 150, 30 %).
  Il réserve le montant sur le plafond de la catégorie et sur le plafond global de 2 000 000 ConsoM par 24 h, puis transmet
  le bon au budget du paiement Wave ou au compte du membre.
- **Création** : seulement sur approbation d'un compte membre dont l'adresse est calculée à partir de son code ; jamais plus
  de 230 M (jetons en circulation + brûlés par conversion).
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
  Points attestés, qui bornent la récompense de 35 % à la conversion et le bonus d'investissement de 30 % ; bonus de
  1er achat et missions une seule fois, missions réservées aux membres ayant un paiement ; numéros de bon croissants pour
  les conversions et investissements ; plafond de 50 000 par 24 h (hors prévente, tranches comprises) ; vesting 50 %
  immédiat puis 10 % à J+30, J+60, J+90, J+120 et J+150, réclamé par l'adresse liée.
- Chacun garde 0,01 TON pour ses frais de stockage.

## Choix d'implémentation à connaître

1. Le montant de chaque récompense est recalculé par l'émetteur (et non par le budget, comme l'indiquait la spécification) :
   c'est plus simple et plus sûr. Le budget et le compte membre gardent le contrôle des emplacements déjà versés,
   des doublons, de l'éligibilité, du plafond de 50 000 par membre et du vesting.
2. Un bon refusé plus loin dans la chaîne libère sa réservation de catégorie, mais reste compté dans le plafond du jour.
3. Une approbation déjà en route quand la pause commence est honorée ; les nouveaux bons et les libérations de vesting sont bloqués.
4. Un brûlage volontaire doit être accompagné d'au moins 0,1 TON pour financer sa recréation ; sinon il est annulé et le
   solde du wallet est rétabli.
5. Conséquence de la règle « une pause par 30 jours » : après une pause, le gardien ne peut plus en déclencher pendant le
   reste des 30 jours.
6. Si un parrain n'est pas éligible, ou si un bonus a déjà été reçu, l'emplacement du budget reste marqué (règle de la
   section 6). Si le refus est passager (plafond du jour, mauvaise adresse), l'emplacement est libéré et le bon pourra
   repasser tant qu'il n'a pas expiré.
7. Si la création de jetons échoue à l'émetteur après l'acceptation du compte membre (cas qui ne devrait pas arriver :
   plafond absolu de 230 M), l'emplacement et les compteurs du compte membre restent consommés.

## Coût mesuré (simulateur)

| Opération | Coût pour le membre |
| --- | --- |
| Première réclamation (crée le compte membre, le budget et le wallet) | environ 0,028 TON |
| Bon lié à un nouveau paiement (crée son budget) | environ 0,016 à 0,018 TON |
| Récompense de conversion | environ 0,007 TON |
| Réclamation de vesting | environ 0,003 TON |
| Brûlage volontaire recréé dans la banque | environ 0,024 TON |

Les créations de contrats incluent la réserve de stockage de 0,01 TON. À remesurer sur le testnet.

## Prochaines étapes

1. Banque d'échange : parts, stock sans propriétaire, conversions, plafond de 5 % par 24 h, fermeture 12 mois.
2. Réclamations de genèse (racines de Merkle) : Anciens Contributeurs (et leur droit au parrainage), préventes payées avant T0.
3. Vesting de l'équipe (5 M : 12 mois de blocage puis 24 mois linéaires).
4. Compte membre : changement d'adresse liée (bon signé, effectif après 7 jours) et parrain enregistré dans le compte
   (décisions 5 et 6 de la spécification) — pas encore écrits.
5. Scripts de déploiement testnet, puis audits.
