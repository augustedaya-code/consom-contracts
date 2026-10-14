# ConsoM — contrats TON

Contrats de ConsoM, la couche crypto de TonMarché, écrits en [Tolk](https://docs.ton.org/tolk/overview).
La référence est [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) : chaque règle du code renvoie à une de ses sections.

> **État : en développement, testnet uniquement.** L'émetteur est écrit et testé seul. Les contrats « budget de paiement »,
> « compte membre » et « banque d'échange » ne sont pas encore écrits : ce sont eux qui empêchent qu'un même bon ou un même
> paiement serve deux fois. **L'émetteur ne doit donc jamais être déployé sans eux.**

## Contenu

| Dossier | Rôle |
| --- | --- |
| `contracts/consom/` | Émetteur ConsoM (`minter.tolk`) et ses messages, constantes, stockage, codes d'erreur |
| `contracts/jetton/` | Wallet Jetton shardé (principe Jetton 2.0), repris sans modification — voir `NOTICE.md` |
| `wrappers/` | Interface TypeScript : stockage initial, bons, messages, lectures |
| `tests/` | Tests automatiques ; `tests/stubs/` contient des contrats de remplacement, **pour les tests uniquement** |
| `scripts/compile.ts` | Compilation avec le compilateur Tolk officiel |
| `docs/` | Spécification |

## Lancer les tests

```bash
npm install
npm test          # 45 tests
npm run build     # écrit build/<Contrat>.json (code compilé et son empreinte)
```

Node.js 22.18 ou plus récent (les tests TypeScript tournent directement avec `node --test`).

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

## Coût mesuré (simulateur, avec les contrats de remplacement)

| Opération | Coût pour le membre |
| --- | --- |
| Réclamation d'un pack de prévente | environ 0,006 TON |
| Réclamation d'une récompense de conversion | environ 0,004 TON |
| Brûlage volontaire recréé dans la banque | environ 0,024 TON |

Ces chiffres seront remesurés avec les vrais contrats enfants, puis sur le testnet.

## Prochaines étapes

1. Budget de paiement : un par paiement Wave, emplacements de récompense, refus des doublons.
2. Compte membre : adresse liée, parrain, éligibilité, 50 000 par jour, vesting 50/50 sur 5 mois, numéros de bon croissants.
3. Banque d'échange : parts, stock sans propriétaire, conversions, plafond de 5 % par 24 h, fermeture 12 mois.
4. Réclamations de genèse (racines de Merkle) et vesting de l'équipe.
5. Scripts de déploiement testnet, puis audits.
