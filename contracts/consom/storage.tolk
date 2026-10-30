// Stockage de l'émetteur ConsoM.
// Les données sont réparties en plusieurs cellules (une cellule TON = 1023 bits et 4 références au plus).

// Plafonds restants par catégorie et compteur journalier global (sections 3 et 10)
// shortcut: 9 montants `coins` peuvent dépasser 1023 bits au pire cas théorique ; les vrais montants (< 2^56) tiennent largement.
@overflow1023_policy("suppress")
struct Caps {
    presale: coins
    purchase: coins
    referral: coins
    missions: coins
    founders: coins
    team: coins
    chika: coins             // réserve du Bonus CHIKA (20 M), jamais mélangée aux autres
    foundation: coins        // réserve de la Fondation (100 000), pas encore utilisée
    presaleSettled: bool     // règle des invendus de prévente appliquée (une seule fois, après T0 + 18 mois)
    dayStart: uint32         // début de la période de 24 h en cours
    dayMinted: coins         // émis (ou réservé) depuis dayStart
}

// Remplacement de témoin en attente (délai public de 7 jours)
struct PendingWitness {
    index: uint8
    newKey: uint256
    proposedAt: uint32
}

// Les trois clés publiques Ed25519 des témoins (section 10)
struct Witnesses {
    key0: uint256
    key1: uint256
    key2: uint256
    pending: Cell<PendingWitness>?
    lastReplaceAt: uint32
}

// Adresses et codes fixés au déploiement
struct Config {
    guardian: address        // Multisig v2 officiel, 2 signatures sur 3
    walletCode: cell         // wallet Jetton (shardé, même principe que Jetton 2.0)
    budgetCode: cell         // contrat « budget de paiement », un par paiement Wave
    memberCode: cell         // contrat « compte membre », un par membre
    // le code de la banque d'échange est dans BankRef pour rester sous 4 références
}

struct BankRef {
    bankCode: cell
    shareCode: cell          // contrats « parts d'un déposant » de la banque
}

struct ConsoMStorage {
    totalSupply: coins           // jetons en circulation
    burnedByConversion: coins    // B : total brûlé par les conversions (banque d'échange)
    recycled: coins              // total recréé dans la banque après des brûlages volontaires
    t0: uint32                   // ouverture du réseau (gravée)
    networkId: int32             // -239 réseau principal, -3 testnet (gravé)
    pausedUntil: uint32          // 0 = pas de pause
    lastPauseStart: uint32
    genesisDone: bool            // dépôt des Anciens Contributeurs dans la banque effectué
    caps: Cell<Caps>
    witnesses: Cell<Witnesses>
    config: Cell<Config>
    extra: Cell<StorageExtra>
}

struct StorageExtra {
    content: cell                // métadonnées du Jetton (TEP-64)
    bank: Cell<BankRef>
}

fun ConsoMStorage.load() {
    return ConsoMStorage.fromCell(contract.getData())
}

fun ConsoMStorage.save(self) {
    contract.setData(self.toCell())
}

fun ConsoMStorage.isPaused(self): bool {
    return blockchain.now() < self.pausedUntil
}
