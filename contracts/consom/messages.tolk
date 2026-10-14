// Messages propres à ConsoM. Les messages du standard Jetton (TEP-74/89) sont dans contracts/jetton/messages.tolk.

// ---------- Bon d'émission (section 5) ----------

// Ce que les témoins ont attesté sur le paiement Wave et le membre
struct PaymentData {
    waveRef: uint256         // SHA-256 de l'identifiant de transaction Wave (jamais l'identifiant en clair)
    waveAmount: coins        // montant payé, en FCFA
    points: coins            // Points de la commande, Points convertis, ou FECA investis selon le type de bon
    memberId: uint256        // empreinte de l'identifiant TonMarché du bénéficiaire
}

// Contenu signé : les témoins signent l'empreinte (hash) de cette cellule
struct Voucher {
    networkId: int32         // -239 réseau principal, -3 testnet
    minter: address          // adresse de cet émetteur
    voucherId: uint64
    kind: uint8              // KIND_*
    level: uint8             // niveau de parrainage (1 à 5), 0 sinon
    validUntil: uint32
    recipient: address       // adresse TON qui reçoit les jetons, et seule autorisée à envoyer le bon
    amount: coins            // montant demandé, que l'émetteur recalcule
    payment: Cell<PaymentData>
}

struct WitnessSignature {
    index: uint8             // 0, 1 ou 2
    signature: bits512       // signature Ed25519 de Voucher.hash()
}

// Envoyé par le wallet du membre (TON Connect)
struct (0xc0150001) ClaimVoucher {
    queryId: uint64
    voucher: Cell<Voucher>
    sigA: Cell<WitnessSignature>
    sigB: Cell<WitnessSignature>
}

// ---------- Échanges avec les contrats enfants (budget de paiement, compte membre) ----------

// Émetteur -> budget de paiement ou compte membre. Les champs utiles au remboursement de la réservation
// sont en tête : un message rebondi ne rapporte que ses 256 premiers bits.
struct (0xc0150002) CheckClaim {
    queryId: uint64
    category: uint8
    reserved: coins
    voucher: Cell<Voucher>
    memberCode: cell         // le budget de paiement en a besoin pour transmettre le bon au compte membre
}

// Compte membre -> émetteur : le bon est accepté ; l'émetteur crée la part immédiate.
// La part en vesting (reserved - immediate) reste réservée et sera libérée par ReleaseVested.
struct (0xc0150003) MintApproved {
    queryId: uint64
    category: uint8
    reserved: coins
    immediate: coins
    memberId: uint256
    recipient: address
}

// Budget ou compte membre -> émetteur : le bon est refusé ; l'émetteur libère sa réservation.
struct (0xc0150004) ClaimRejected {
    queryId: uint64
    category: uint8
    reserved: coins
    fromBudget: bool
    key: uint256             // waveRef si fromBudget, memberId sinon
    refundTo: address
}

// Compte membre -> émetteur : une tranche de vesting est échue (déjà réservée lors du bon).
struct (0xc0150005) ReleaseVested {
    queryId: uint64
    memberId: uint256
    recipient: address
    amount: coins
}

// ---------- Gardien (section 10) ----------

struct (0xc0150010) GuardianPause {
    queryId: uint64
}

struct (0xc0150011) GuardianUnpause {
    queryId: uint64
}

struct (0xc0150012) ProposeWitness {
    queryId: uint64
    index: uint8
    newKey: uint256
}

struct (0xc0150013) CancelWitness {
    queryId: uint64
}

struct (0xc0150014) ExecuteWitness {
    queryId: uint64
}

// ---------- Genèse (section 11) ----------

// Une seule fois : dépose 70 % de l'allocation des Anciens Contributeurs dans la banque d'échange
struct (0xc0150020) GenesisFoundersDeposit {
    queryId: uint64
}

// ---------- Charges utiles transmises à la banque avec un dépôt (forward payload) ----------

struct (0xc0150030) FoundersDepositTag {
}

struct (0xc0150031) RecycledDepositTag {
}
