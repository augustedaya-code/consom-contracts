// Émetteur ConsoM (spécification : docs/SPECIFICATION.md, sections 2 à 10).
//
// Ce contrat n'a AUCUN administrateur : pas de création libre, pas de changement de code ni de métadonnées.
// Une émission n'est possible que :
//   - par un bon signé par 2 témoins sur 3, envoyé par son bénéficiaire, puis accepté par le budget de paiement
//     et/ou le compte membre (contrats enfants dont l'émetteur connaît le code) ;
//   - une seule fois à la genèse, pour déposer dans la banque 70 % de l'allocation des Anciens Contributeurs et la réserve de la Fondation ;
//   - par un bon « Ancien Contributeur » (30 % créés pour lui, 70 % attribués en parts de la banque, sans création) ;
//   - par « libérer la part de l'équipe » : n'importe qui peut l'appeler, tout est fixé par le calendrier gravé ;
//   - pour recréer dans la banque des jetons brûlés volontairement (l'offre ne baisse que par les conversions).
// Le gardien (Multisig v2, 2 sur 3) peut seulement mettre en pause et remplacer un témoin sous délai de 7 jours.

import "../jetton/messages"
import "../jetton/jetton-utils"
import "../jetton/sharding"
import "constants"
import "errors"
import "storage"
import "messages"
import "addresses"

contract ConsoMMinter {
    author: "TonMarché"
    incomingMessages: AllowedMessageToConsoMMinter
    storage: ConsoMStorage
}

type AllowedMessageToConsoMMinter =
    | ClaimVoucher
    | BudgetApproved
    | MintApproved
    | VerifyOwnConversion
    | ClaimRejected
    | BurnNotificationForMinter
    | RequestWalletAddress
    | GuardianPause
    | GuardianUnpause
    | ProposeWitness
    | CancelWitness
    | ExecuteWitness
    | GenesisFoundersDeposit
    | ReleaseTeamShare
    | TopUpTons

// ===================================================================================================
// Règles de calcul
// ===================================================================================================

fun categoryOf(kind: int): int {
    if (kind == KIND_PRESALE) {
        return CAT_PRESALE;
    }
    if ((kind == KIND_PURCHASE_RECORD) || (kind == KIND_CONVERSION)) {
        return CAT_PURCHASE;
    }
    if (kind == KIND_REFERRAL) {
        return CAT_REFERRAL;
    }
    if (kind == KIND_CHIKA_BONUS) {
        return CAT_CHIKA;
    }
    if (kind == KIND_FOUNDER_CLAIM) {
        return CAT_FOUNDERS;
    }
    if (kind == KIND_EARLY_CONTRIBUTION) {
        return CAT_EARLY;
    }
    if (kind == KIND_INVESTMENT) {
        return CAT_PURCHASE;    // l'investissement est payé par la réserve Achats
    }
    return CAT_MISSIONS;    // 1er achat, missions
}

// Les bons liés à un paiement Wave passent d'abord par le budget de ce paiement ;
// les autres vont directement au compte du membre.
fun usesPaymentBudget(kind: int): bool {
    return (kind == KIND_PRESALE) || (kind == KIND_PURCHASE_RECORD) || (kind == KIND_REFERRAL) || (kind == KIND_FIRST_PURCHASE) || (kind == KIND_CHIKA_BONUS) || (kind == KIND_EARLY_CONTRIBUTION);
}

fun referralRateBp(level: int): int {
    if (level == 1) {
        return REFERRAL_L1_BP;
    }
    if (level == 2) {
        return REFERRAL_L2_BP;
    }
    if (level == 3) {
        return REFERRAL_L3_BP;
    }
    if (level == 4) {
        return REFERRAL_L4_BP;
    }
    if (level == 5) {
        return REFERRAL_L5_BP;
    }
    return -1;
}

fun presalePackPrice(packAmount: int): int {
    if (packAmount == PACK_ESSENTIEL_CONSOM) {
        return PACK_ESSENTIEL_PRICE;
    }
    if (packAmount == PACK_POPULAIRE_CONSOM) {
        return PACK_POPULAIRE_PRICE;
    }
    if (packAmount == PACK_GRANDE_CONSOM) {
        return PACK_GRANDE_PRICE;
    }
    return -1;
}

// Montant (unités de base) que le contrat accepte pour un bon ; -1 si le bon est invalide.
// Le montant demandé dans le bon doit être exactement celui-ci : le contrat ne fait pas confiance au calcul de l'application.
fun expectedAmount(kind: int, level: int, requested: int, payment: PaymentData): int {
    if (kind == KIND_PRESALE) {
        val price = presalePackPrice(requested);
        if ((price < 0) || (payment.waveAmount < price)) {
            return -1;
        }
        return requested;
    }
    if (kind == KIND_PURCHASE_RECORD) {
        return 0;
    }
    if (kind == KIND_REFERRAL) {
        val rate = referralRateBp(level);
        if (rate < 0) {
            return -1;
        }
        return mulDivFloor(payment.points * ONE_CONSOM, rate, BP_DENOMINATOR);
    }
    if (kind == KIND_FIRST_PURCHASE) {
        return FIRST_PURCHASE_REWARD;
    }
    if (kind == KIND_CHIKA_BONUS) {
        // waveAmount porte ici le montant payé en CHIKA
        return mulDivFloor(payment.waveAmount * ONE_CONSOM, CHIKA_BONUS_BP, BP_DENOMINATOR);
    }
    if (kind == KIND_CONVERSION) {
        return mulDivFloor(payment.points * ONE_CONSOM, CONVERSION_RATE_BP, BP_DENOMINATOR);
    }
    if ((kind == KIND_MISSION_TG) || (kind == KIND_MISSION_FB)) {
        return MISSION_REWARD;
    }
    if (kind == KIND_INVESTMENT) {
        return mulDivFloor(payment.points * ONE_CONSOM, INVESTMENT_RATE_BP, BP_DENOMINATOR);
    }
    if ((kind == KIND_BANK_CONVERSION) || (kind == KIND_OWN_CONVERSION)) {
        return 0;     // une conversion ne crée rien : elle brûle (la récompense de 5 % est un bon séparé)
    }
    if (kind == KIND_FOUNDER_CLAIM) {
        // `requested` est la part totale T de l'Ancien Contributeur ; le contrat en crée 30 % et attribue 70 % en parts
        if ((requested <= 0) || (requested > CAP_FOUNDERS) || (requested % FOUNDER_UNIT != 0)) {
            return -1;
        }
        return requested;
    }
    if (kind == KIND_EARLY_CONTRIBUTION) {
        // `requested` est le total T des packs de la contribution ; `waveRef` identifie la contribution (anti-doublon par le budget)
        if ((requested <= 0) || (requested > CAP_PRESALE) || (requested % FOUNDER_UNIT != 0) || (payment.waveRef == 0)) {
            return -1;
        }
        return requested;
    }
    return -1;
}

// Anciens Contributeurs : 30 % de T sont créés pour l'Ancien Contributeur (T est un multiple de 10 : le calcul est exact)
fun founderDirectPart(total: int): int {
    return mulDivFloor(total, FOUNDER_DIRECT_BP, BP_DENOMINATOR);
}

// Parts de la banque attribuées en plus, pour une partie directe donnée : 70 % de T = 7/3 de la partie directe
fun founderSharesFor(direct: int): int {
    return direct * 7 / 3;
}

// Part de l'équipe libérée à la date `now` (A9) : rien avant T0 + 12 mois, puis 1/24 par période de 30 jours terminée ;
// la dernière période libère tout le reste, pour un total exact de 5 000 000
fun teamUnlocked(t0: int, now: int): int {
    if (now < t0 + TEAM_CLIFF) {
        return 0;
    }
    val periods = (now - t0 - TEAM_CLIFF) / ONE_MONTH;
    if (periods >= TEAM_PERIODS) {
        return CAP_TEAM;
    }
    return periods * (CAP_TEAM / TEAM_PERIODS);
}

// Prochaine date de libération de l'équipe ; 0 quand tout est libéré
fun teamNextRelease(t0: int, now: int): int {
    val cliffEnd = t0 + TEAM_CLIFF;
    if (now >= cliffEnd + TEAM_PERIODS * ONE_MONTH) {
        return 0;
    }
    val periods = (now < cliffEnd) ? 0 : (now - cliffEnd) / ONE_MONTH;
    return cliffEnd + (periods + 1) * ONE_MONTH;
}

fun isConversionBurn(kind: int): bool {
    return (kind == KIND_BANK_CONVERSION) || (kind == KIND_OWN_CONVERSION);
}

// Nombre de paliers de halving (section 8) : un palier tous les 15 000 000 ConsoM brûlés par les conversions,
// 16 divisions au plus ; ensuite le taux ne bouge plus, même si le compteur continue de monter.
fun halvingSteps(burnedByConversion: int): int {
    return min(burnedByConversion / HALVING_STEP, HALVING_MAX_STEPS);
}

// ConsoM à brûler (unités de base) pour convertir `points` Points : ceil(points × 10^8 / 2^n)
fun burnForPoints(points: int, steps: int): int {
    return mulDivCeil(points, BURN_PER_POINT_NUMERATOR, 1 << steps);
}

// ===================================================================================================
// Plafonds
// ===================================================================================================

fun Caps.remainingOf(self, category: int): int {
    if ((category == CAT_PRESALE) || (category == CAT_EARLY)) {
        return self.presale;    // les contributions du lancement anticipé sont prises dans la réserve de prévente
    }
    if (category == CAT_PURCHASE) {
        return self.purchase;
    }
    if (category == CAT_REFERRAL) {
        return self.referral;
    }
    if (category == CAT_MISSIONS) {
        return self.missions;
    }
    if (category == CAT_FOUNDERS) {
        return self.founders;
    }
    if (category == CAT_CHIKA) {
        return self.chika;
    }
    if (category == CAT_FOUNDATION) {
        return self.foundation;
    }
    return self.team;
}

fun Caps.setRemaining(mutate self, category: int, value: coins) {
    if ((category == CAT_PRESALE) || (category == CAT_EARLY)) {
        self.presale = value;
    } else if (category == CAT_PURCHASE) {
        self.purchase = value;
    } else if (category == CAT_REFERRAL) {
        self.referral = value;
    } else if (category == CAT_MISSIONS) {
        self.missions = value;
    } else if (category == CAT_FOUNDERS) {
        self.founders = value;
    } else if (category == CAT_CHIKA) {
        self.chika = value;
    } else if (category == CAT_FOUNDATION) {
        self.foundation = value;
    } else {
        self.team = value;
    }
}

// Règle des invendus (section 3) : à T0 + 18 mois, 50 % du reste de la prévente sont retirés,
// 25 % vont aux récompenses d'achat et 25 % au parrainage. Appliquée une seule fois.
fun Caps.settlePresaleIfDue(mutate self, t0: int) {
    if (!self.presaleSettled && (blockchain.now() >= t0 + PRESALE_WINDOW)) {
        // la retenue gravée pour les contributions du lancement anticipé encore à réclamer reste dans la réserve de prévente :
        // la règle des invendus ne s'applique qu'au reste
        val spare = self.presale - min(self.presale, self.earlyHold);
        val quarter = spare / 4;
        self.purchase += quarter;
        self.referral += quarter;
        self.presale -= spare;
        self.presaleSettled = true;
    }
}

// Fin des récompenses (section 3) : à T0 + 24 mois, plus rien ne peut être créé ; les réserves de récompenses
// (achats, parrainage, bonus CHIKA, premier achat et missions) sont affichées à 0 par `get_caps`.
fun Caps.zeroRewardsIfOver(mutate self, t0: int) {
    if (blockchain.now() >= t0 + REWARDS_WINDOW) {
        self.purchase = 0;
        self.referral = 0;
        self.missions = 0;
        self.chika = 0;
    }
}

fun Caps.rollDay(mutate self) {
    val now = blockchain.now();
    if (now >= self.dayStart + ONE_DAY) {
        self.dayStart = now;
        self.dayMinted = 0;
    }
}

// Libère une réservation après un refus. Le compteur journalier n'est volontairement pas diminué :
// un bon refusé reste compté dans le plafond du jour (choix prudent).
fun ConsoMStorage.releaseReservation(mutate self, category: int, reserved: coins) {
    if (reserved == 0) {
        return;
    }
    var caps = self.caps.load();
    caps.setRemaining(category, caps.remainingOf(category) + reserved);
    if (category == CAT_FOUNDERS) {
        caps.founderShares += founderSharesFor(reserved);    // les parts réservées avec la partie directe sont rendues aussi
    }
    if (category == CAT_EARLY) {
        caps.earlyHold += reserved;                           // la retenue prise avec la réservation est rendue aussi
    }
    self.caps = caps.toCell();
}

// ===================================================================================================
// Témoins
// ===================================================================================================

fun Witnesses.keyAt(self, index: int): uint256 {
    if (index == 0) {
        return self.key0;
    }
    if (index == 1) {
        return self.key1;
    }
    assert (index == 2) throw ERR_BAD_WITNESS_INDEX;
    return self.key2;
}

fun Witnesses.hasKey(self, key: uint256): bool {
    return (self.key0 == key) || (self.key1 == key) || (self.key2 == key);
}

// Index du témoin si la signature est valable, sinon un code d'erreur négatif
fun witnessIndexOrError(witnesses: Witnesses, hash: uint256, sigCell: Cell<WitnessSignature>): int {
    val sig = sigCell.load();
    if (sig.index >= WITNESS_COUNT) {
        return -ERR_BAD_WITNESS_INDEX;
    }
    if (!isSignatureValid(hash, sig.signature as slice, witnesses.keyAt(sig.index))) {
        return -ERR_BAD_SIGNATURE;
    }
    return sig.index;
}

// Contrôles communs à tout bon (section 5). N'importe qui peut présenter un bon valable : l'expéditeur n'est pas contrôlé
// ici, tout ce qui est créé va à voucher.recipient. Renvoie 0 si le bon est valable, sinon le code d'erreur.
// Ne lève jamais d'exception : une conversion avec ses propres ConsoM doit pouvoir rendre les jetons reçus.
fun checkVoucher(storage: ConsoMStorage, voucherCell: Cell<Voucher>, sigA: Cell<WitnessSignature>,
                 sigB: Cell<WitnessSignature>): int {
    val voucher = voucherCell.load();
    // la pause bloque les créations et les conversions via la banque ; la conversion avec ses propres ConsoM reste possible
    if (storage.isPaused() && (voucher.kind != KIND_OWN_CONVERSION)) {
        return ERR_PAUSED;
    }
    val now = blockchain.now();
    if (voucher.networkId != storage.networkId) {
        return ERR_WRONG_NETWORK;
    }
    if (voucher.minter != contract.getAddress()) {
        return ERR_WRONG_MINTER;
    }
    if (now > voucher.validUntil) {
        return ERR_EXPIRED;
    }
    if (voucher.validUntil > now + VOUCHER_MAX_VALIDITY) {
        return ERR_VALIDITY_TOO_LONG;
    }
    if (voucher.kind > KIND_MAX) {
        return ERR_UNKNOWN_KIND;
    }

    // 2 signatures valables de 2 témoins différents
    val witnesses = storage.witnesses.load();
    val hash = voucherCell.hash();
    val indexA = witnessIndexOrError(witnesses, hash, sigA);
    if (indexA < 0) {
        return -indexA;
    }
    val indexB = witnessIndexOrError(witnesses, hash, sigB);
    if (indexB < 0) {
        return -indexB;
    }
    if (indexA == indexB) {
        return ERR_SAME_WITNESS;
    }

    // fenêtre : prévente jusqu'à T0 + 18 mois, récompenses jusqu'à T0 + 24 mois, conversions et Anciens Contributeurs sans limite
    var windowEnd = storage.t0 + REWARDS_WINDOW;
    if (voucher.kind == KIND_PRESALE) {
        windowEnd = storage.t0 + PRESALE_WINDOW;
    } else if (isConversionBurn(voucher.kind) || (voucher.kind == KIND_FOUNDER_CLAIM) || (voucher.kind == KIND_EARLY_CONTRIBUTION)) {
        windowEnd = MAX_UINT32;
    }
    if ((now < storage.t0) || (now >= windowEnd)) {
        return ERR_WINDOW_CLOSED;
    }

    // montant recalculé par le contrat
    val payment = voucher.payment.load();
    if (voucher.amount != expectedAmount(voucher.kind, voucher.level, voucher.amount, payment)) {
        return ERR_WRONG_AMOUNT;
    }
    if ((voucher.kind == KIND_PURCHASE_RECORD) || (voucher.kind == KIND_REFERRAL)) {
        if (payment.points * P_MAX_DENOMINATOR > payment.waveAmount) {
            return ERR_POINTS_TOO_HIGH;
        }
    }
    return 0;
}

const MAX_UINT32 = 0xFFFFFFFF

fun ConsoMStorage.bankAddress(self): address {
    val bankRef = self.extra.load().bank.load();
    return calcBankAddress(bankRef.bankCode, bankRef.shareCode, self.config.load().walletCode, self.t0);
}

fun ConsoMStorage.currentHalvingSteps(self): int {
    return halvingSteps(self.burnedByConversion);
}

// ===================================================================================================
// Adresses interdites de réception (A16) et contrôles au déploiement (A3)
// ===================================================================================================

fun isEmptyAddress(a: address): bool {
    val (workchain, hash) = a.getWorkchainAndHash();
    return hash == 0;
}

// Vrai si `who` figure dans la liste gravée au déploiement (au plus 3 cellules : vérifié à chaque message par assertDeploymentValid)
fun Config.isInForbiddenList(self, who: address): bool {
    var cell = self.forbidden;
    while (cell != null) {
        val chunk = cell!.load();
        if (chunk.a0 == who) {
            return true;
        }
        if ((chunk.a1 != null) && (chunk.a1! == who)) {
            return true;
        }
        if ((chunk.a2 != null) && (chunk.a2! == who)) {
            return true;
        }
        cell = chunk.next;
    }
    return false;
}

fun forbiddenEntry(entry: address, team: address): int {
    assert (!isEmptyAddress(entry)) throw ERR_DEPLOY_FORBIDDEN_LIST;
    assert (entry != team) throw ERR_DEPLOY_TEAM_FORBIDDEN;
    return 1;
}

// Contrôles au déploiement. Les données du contrat sont gravées par celui qui le déploie ; le contrat ne peut pas
// « refuser de naître », mais un contrat dont les données ne respectent pas ces règles refuse TOUT message
// (les messages rebondissent, rien n'est créé) : il est inutilisable, et personne ne peut le corriger.
//   - 3 clés de témoins non nulles et deux à deux différentes (A3) ;
//   - gardien et équipe : non vides, différents de l'émetteur et de la banque ;
//   - liste interdite : 8 adresses au plus, aucune vide, l'équipe n'y figure pas (A16).
fun ConsoMStorage.assertDeploymentValid(self) {
    val witnesses = self.witnesses.load();
    assert ((witnesses.key0 != 0) && (witnesses.key1 != 0) && (witnesses.key2 != 0)) throw ERR_ZERO_KEY;
    assert ((witnesses.key0 != witnesses.key1) && (witnesses.key0 != witnesses.key2) && (witnesses.key1 != witnesses.key2)) throw ERR_DEPLOY_SAME_KEYS;

    val config = self.config.load();
    assert (!isEmptyAddress(config.guardian)) throw ERR_DEPLOY_NO_GUARDIAN;
    assert (!isEmptyAddress(config.teamAddress)) throw ERR_DEPLOY_NO_TEAM;
    val bank = self.bankAddress();
    val me = contract.getAddress();
    assert ((config.guardian != me) && (config.guardian != bank)) throw ERR_DEPLOY_GUARDIAN_SYSTEM;
    assert ((config.teamAddress != me) && (config.teamAddress != bank)) throw ERR_DEPLOY_TEAM_SYSTEM;

    var cell = config.forbidden;
    var chunks = 0;
    var count = 0;
    while (cell != null) {
        chunks += 1;
        assert (chunks <= FORBIDDEN_MAX_CHUNKS) throw ERR_DEPLOY_FORBIDDEN_LIST;
        val chunk = cell!.load();
        count += forbiddenEntry(chunk.a0, config.teamAddress);
        if (chunk.a1 != null) {
            count += forbiddenEntry(chunk.a1!, config.teamAddress);
        }
        if (chunk.a2 != null) {
            count += forbiddenEntry(chunk.a2!, config.teamAddress);
        }
        cell = chunk.next;
    }
    assert (count <= MAX_FORBIDDEN_RECIPIENTS) throw ERR_DEPLOY_FORBIDDEN_LIST;
}

// A16 : destinataire interdit pour une création. L'émetteur et la banque le sont toujours (tous types de bon) ;
// la liste gravée s'ajoute pour les créations. Une conversion n'est pas une création : la liste ne s'y applique pas
// (le serveur peut présenter des bons de conversion et payer les frais, il ne peut juste pas être un destinataire de création).
fun ConsoMStorage.isRecipientForbidden(self, voucher: Voucher): bool {
    val recipient = voucher.recipient;
    if ((recipient == contract.getAddress()) || (recipient == self.bankAddress())) {
        return true;
    }
    return !isConversionBurn(voucher.kind) && self.config.load().isInForbiddenList(recipient);
}

// ===================================================================================================
// Création de jetons
// ===================================================================================================

fun emptyForwardPayload(): slice {
    return beginCell().storeBool(false).endCell().beginParse();
}

fun taggedForwardPayload(tag: int): slice {
    return beginCell().storeBool(false).storeUint(tag, 32).endCell().beginParse();
}

const OP_FOUNDERS_DEPOSIT_TAG = 0xc0150030
const OP_FOUNDATION_DEPOSIT_TAG = 0xc0150031
const OP_EARLY_DEPOSIT_TAG = 0xc0150034

// Charge utile d'un transfert vers la banque : étiquette, puis l'adresse à qui attribuer les parts
fun earlyForwardPayload(owner: address): slice {
    return beginCell().storeBool(false).storeUint(OP_EARLY_DEPOSIT_TAG, 32).storeAddress(owner).endCell().beginParse();
}

// Garde-fou d'offre : jetons en circulation + jetons brûlés par les conversions <= 250 M.
// (Seuls les brûlages de conversion sortent de la circulation ; ils sont comptés dans B, jamais recréés.)
fun ConsoMStorage.addSupply(mutate self, amount: coins) {
    assert (self.totalSupply + self.burnedByConversion + amount <= MAX_SUPPLY) throw ERR_SUPPLY_CAP;
    self.totalSupply += amount;
}

fun sendMint(walletCode: cell, recipient: address, amount: coins, queryId: uint64, excessesTo: address?,
             forwardTonAmount: coins, forwardPayload: slice) {
    val mintMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: calcDeployedJettonWallet(recipient, contract.getAddress(), walletCode),
        value: 0,
        body: InternalTransferStep {
            queryId,
            jettonAmount: amount,
            transferInitiator: null,
            sendExcessesTo: excessesTo,
            forwardTonAmount,
            forwardPayload,
        }
    });
    mintMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// Comme sendMint, mais avec un montant de TON fixe pris sur l'émetteur : permet d'envoyer ensuite un second message
// qui emporte le reste de la valeur reçue (genèse : deux créations dans la banque)
fun sendMintFunded(walletCode: cell, recipient: address, amount: coins, queryId: uint64, excessesTo: address?,
                   forwardTonAmount: coins, forwardPayload: slice, value: coins) {
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: calcDeployedJettonWallet(recipient, contract.getAddress(), walletCode),
        value,
        body: InternalTransferStep {
            queryId,
            jettonAmount: amount,
            transferInitiator: null,
            sendExcessesTo: excessesTo,
            forwardTonAmount,
            forwardPayload,
        }
    }).send(SEND_MODE_REGULAR);
}

fun sendExcesses(dest: address?, queryId: uint64) {
    if (dest == null) {
        return;
    }
    val excessesMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: dest,
        value: 0,
        body: ReturnExcessesBack { queryId }
    });
    excessesMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}

// Instruction à la banque pour une conversion : brûler (acceptée) ou rendre les jetons reçus (refusée)
fun sendBankInstruction(bank: address, order: BurnOrder, queryId: uint64, to: address, accepted: bool) {
    if (!accepted) {
        createMessage({
            bounce: BounceMode.NoBounce,
            dest: bank,
            value: 0,
            body: ReturnEscrow { queryId, amount: order.escrow, to }
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    if (order.mode == BURN_FROM_STOCK) {
        createMessage({
            bounce: BounceMode.NoBounce,
            dest: bank,
            value: 0,
            body: BankBurn { queryId, burn: order.burn, refundTo: to }
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: bank,
        value: 0,
        body: EscrowBurn { queryId, burn: order.burn, refund: (order.escrow - order.burn) as coins, to }
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// ===================================================================================================
// Messages rebondis
// ===================================================================================================

type BouncedToMinter = CheckClaim | InternalTransferStep

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy BouncedToMinter.fromSlice(in.bouncedBody);
    match (msg) {
        CheckClaim => {
            // le budget ou le compte membre a échoué sans répondre : la réservation est libérée.
            // (Si le bon avait déjà été accepté par le budget, son emplacement y reste marqué : le compte membre
            // est écrit pour toujours répondre par ClaimRejected plutôt que d'échouer.)
            var storage = lazy ConsoMStorage.load();
            storage.releaseReservation(msg.category, msg.reserved);
            storage.save();
        }
        InternalTransferStep => {
            // création refusée par le wallet : les jetons n'existent pas
            var storage = lazy ConsoMStorage.load();
            storage.totalSupply -= msg.jettonAmount;
            storage.save();
        }
    }
}

// ===================================================================================================
// Messages reçus
// ===================================================================================================

fun onInternalMessage(in: InMessage) {
    // A3 / A16 : un contrat déployé avec des données interdites refuse tout (voir assertDeploymentValid)
    ConsoMStorage.load().assertDeploymentValid();
    val msg = lazy AllowedMessageToConsoMMinter.fromSlice(in.body);

    match (msg) {

        // ---------- Bon d'émission (section 5) ----------
        ClaimVoucher => {
            var storage = lazy ConsoMStorage.load();
            assert (in.valueCoins >= MIN_CLAIM_VALUE) throw ERR_NOT_ENOUGH_TON;
            val code = checkVoucher(storage, msg.voucher, msg.sigA, msg.sigB);
            assert (code == 0) throw code;
            val voucher = msg.voucher.load();
            // une conversion avec ses propres ConsoM arrive toujours par la banque, avec les jetons
            assert (voucher.kind != KIND_OWN_CONVERSION) throw ERR_UNKNOWN_KIND;
            val payment = voucher.payment.load();
            val isFounderClaim = voucher.kind == KIND_FOUNDER_CLAIM;
            if (isFounderClaim) {
                // les parts à attribuer n'existent qu'après la genèse ; la banque reçoit aussi un message en plus des jetons
                assert (storage.genesisDone) throw ERR_GENESIS_NOT_DONE;
                assert (in.valueCoins >= MIN_FOUNDER_CLAIM_VALUE) throw ERR_NOT_ENOUGH_TON;
            }
            val isEarly = voucher.kind == KIND_EARLY_CONTRIBUTION;
            if (isEarly) {
                assert (in.valueCoins >= MIN_EARLY_CLAIM_VALUE) throw ERR_NOT_ENOUGH_TON;    // deux créations dont une dans la banque
            }

            // réservation sur le plafond de la catégorie et sur le plafond journalier global.
            // Anciens Contributeurs : seuls les 30 % créés sont réservés (et comptent dans le plafond du jour) ;
            // les 70 % de parts sont pris sur les parts à attribuer, sans rien créer.
            val category = categoryOf(voucher.kind);
            val reserved: int = isFounderClaim ? founderDirectPart(voucher.amount) : voucher.amount;
            var caps = storage.caps.load();
            caps.settlePresaleIfDue(storage.t0);
            caps.rollDay();
            if (reserved > 0) {
                // un pack de prévente ne touche pas à la retenue des contributions du lancement anticipé
                val available: int = (category == CAT_PRESALE) ? (caps.presale - min(caps.presale, caps.earlyHold)) : caps.remainingOf(category);
                assert (available >= reserved) throw ERR_CATEGORY_CAP;
                assert (caps.dayMinted + reserved <= GLOBAL_DAILY_CAP) throw ERR_DAILY_CAP;
                if (isEarly) {
                    assert (caps.earlyHold >= reserved) throw ERR_EARLY_TOTAL;
                    caps.earlyHold -= reserved;
                }
                if (isFounderClaim) {
                    val shares = voucher.amount - reserved;
                    assert (caps.founderShares >= shares) throw ERR_NO_FOUNDER_SHARES;
                    caps.founderShares -= shares;
                }
                caps.setRemaining(category, caps.remainingOf(category) - reserved);
                caps.dayMinted += reserved;
            }
            storage.caps = caps.toCell();
            storage.save();

            // contrôle suivant : budget du paiement Wave, ou directement le compte du membre
            val config = storage.config.load();
            val nextCheck = usesPaymentBudget(voucher.kind)
                ? calcDeployedChild(config.budgetCode, payment.waveRef)
                : calcDeployedChild(config.memberCode, payment.memberId);
            val checkMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: nextCheck,
                value: 0,
                body: CheckClaim {
                    queryId: msg.queryId,
                    category,
                    reserved,
                    viaBudget: false,
                    voucher: msg.voucher,
                    burnOrder: (voucher.kind == KIND_BANK_CONVERSION)
                        ? (BurnOrder {
                            mode: BURN_FROM_STOCK,
                            burn: burnForPoints(payment.points, storage.currentHalvingSteps()) as coins,
                            escrow: 0,
                        }).toCell()
                        : null,
                    payer: in.senderAddress,
                    recipientForbidden: storage.isRecipientForbidden(voucher),
                }
            });
            checkMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        // Le budget du paiement a accepté le bon : il passe au compte du membre
        BudgetApproved => {
            val storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            val payment = msg.voucher.load().payment.load();
            assert (in.senderAddress == calcChildAddress(config.budgetCode, payment.waveRef)) throw ERR_NOT_CHILD;
            val checkMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedChild(config.memberCode, payment.memberId),
                value: 0,
                body: CheckClaim {
                    queryId: msg.queryId,
                    category: msg.category,
                    reserved: msg.reserved,
                    viaBudget: true,
                    voucher: msg.voucher,
                    burnOrder: null,
                    payer: msg.payer,
                    recipientForbidden: false,    // le budget a déjà vérifié le destinataire
                }
            });
            checkMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        MintApproved => {
            var storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            assert (in.senderAddress == calcChildAddress(config.memberCode, msg.memberId)) throw ERR_NOT_CHILD;
            if (msg.burnOrder != null) {
                // conversion acceptée par le compte membre (numéro de bon jamais utilisé) : la banque brûle
                val order = msg.burnOrder!.load();
                sendBankInstruction(storage.bankAddress(), order, msg.queryId, msg.payer, true);
                return;
            }
            if (msg.reserved == 0) {
                sendExcesses(msg.payer, msg.queryId);
                return;
            }
            storage.addSupply(msg.reserved);
            storage.save();
            if (msg.category == CAT_FOUNDERS) {
                // Ancien Contributeur : la banque lui attribue ses 70 % en parts (rien n'est créé pour cette partie)
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.bankAddress(),
                    value: BANK_ASSIGN_VALUE,
                    body: AssignFounderShares {
                        queryId: msg.queryId,
                        shares: founderSharesFor(msg.reserved) as coins,
                        to: msg.recipient,
                    }
                }).send(SEND_MODE_REGULAR);
            }
            if (msg.category == CAT_EARLY) {
                // le dernier message reçoit le reste de la valeur reçue (voir MINTER_GAS_MARGIN)
                // contribution du lancement anticipé : 30 % créés sur l'adresse, 70 % créés dans la banque avec de nouvelles parts
                val direct = founderDirectPart(msg.reserved);
                val bankPart = msg.reserved - direct;
                sendMintFunded(config.walletCode, storage.bankAddress(), bankPart as coins, msg.queryId, msg.payer,
                               EARLY_BANK_FWD_VALUE, earlyForwardPayload(msg.recipient), EARLY_BANK_MINT_VALUE);
                sendMintFunded(config.walletCode, msg.recipient, direct as coins, msg.queryId, msg.payer, 0, emptyForwardPayload(),
                               max(in.valueCoins - EARLY_BANK_MINT_VALUE - MINTER_GAS_MARGIN, 0) as coins);
                return;
            }
            if (msg.category == CAT_FOUNDERS) {
                // la banque a reçu BANK_ASSIGN_VALUE : l'Ancien Contributeur reçoit le reste de la valeur reçue
                sendMintFunded(config.walletCode, msg.recipient, msg.reserved, msg.queryId, msg.payer, 0, emptyForwardPayload(),
                               max(in.valueCoins - BANK_ASSIGN_VALUE - MINTER_GAS_MARGIN, 0) as coins);
                return;
            }
            // les jetons vont au bénéficiaire du bon ; l'excédent de TON revient à celui qui a présenté le bon (et payé)
            sendMint(config.walletCode, msg.recipient, msg.reserved, msg.queryId, msg.payer, 0, emptyForwardPayload());
        }

        ClaimRejected => {
            var storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            val expectedSender = msg.fromBudget
                ? calcChildAddress(config.budgetCode, msg.key)
                : calcChildAddress(config.memberCode, msg.key);
            assert (in.senderAddress == expectedSender) throw ERR_NOT_CHILD;
            storage.releaseReservation(msg.category, msg.reserved);
            storage.save();
            if (msg.burnOrder != null) {
                val order = msg.burnOrder!.load();
                if (order.mode == BURN_FROM_ESCROW) {
                    // conversion avec ses propres ConsoM refusée : la banque rend tous les jetons reçus
                    sendBankInstruction(storage.bankAddress(), order, msg.queryId, msg.refundTo, false);
                    return;
                }
            }
            if (!msg.fromBudget && (msg.freeSlot != null)) {
                // refus du compte membre sur un bon déjà accepté par le budget : on libère l'emplacement
                val slotVoucher = msg.freeSlot!;
                val waveRef = slotVoucher.load().payment.load().waveRef;
                val releaseMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: calcChildAddress(config.budgetCode, waveRef),
                    value: 0,
                    body: ReleaseSlot {
                        queryId: msg.queryId,
                        voucher: slotVoucher,
                        refundTo: msg.refundTo,
                    }
                });
                releaseMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }
            sendExcesses(msg.refundTo, msg.queryId);
        }

        // Conversion avec ses propres ConsoM : la banque a reçu les jetons et le bon signé
        VerifyOwnConversion => {
            val storage = lazy ConsoMStorage.load();
            val bank = storage.bankAddress();
            assert (in.senderAddress == bank) throw ERR_NOT_BANK;
            var code = checkVoucher(storage, msg.voucher, msg.sigA, msg.sigB);
            val voucher = msg.voucher.load();
            if ((code == 0) && (msg.from != voucher.recipient)) {
                code = ERR_NOT_RECIPIENT;   // les jetons à brûler partent du wallet du membre : seul lui peut présenter ce bon
            }
            val payment = voucher.payment.load();
            val required = burnForPoints(payment.points, storage.currentHalvingSteps());
            if ((code == 0) && (voucher.kind != KIND_OWN_CONVERSION)) {
                code = ERR_UNKNOWN_KIND;
            }
            if ((code == 0) && (msg.received < required)) {
                code = ERR_WRONG_AMOUNT;
            }
            if (code != 0) {
                val refused: BurnOrder = { mode: BURN_FROM_ESCROW, burn: 0, escrow: msg.received };
                sendBankInstruction(bank, refused, msg.queryId, msg.from, false);
                return;
            }
            val config = storage.config.load();
            val order: BurnOrder = { mode: BURN_FROM_ESCROW, burn: required as coins, escrow: msg.received };
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedChild(config.memberCode, payment.memberId),
                value: 0,
                body: CheckClaim {
                    queryId: msg.queryId,
                    category: CAT_PURCHASE,
                    reserved: 0,
                    viaBudget: false,
                    voucher: msg.voucher,
                    burnOrder: order.toCell(),
                    payer: msg.from,
                    recipientForbidden: false,    // conversion avec ses propres ConsoM : msg.from == voucher.recipient, jamais l'émetteur ni la banque
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        // ---------- Brûlages (section 8) ----------
        BurnNotificationForMinter => {
            var storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            assert (in.senderAddress == calcWalletAddress(msg.burnInitiator, config.walletCode)) throw ERR_NOT_WALLET;
            val bank = storage.bankAddress();

            if (msg.burnInitiator == bank) {
                // brûlage de conversion : définitif, compte pour les paliers
                storage.totalSupply -= msg.jettonAmount;
                storage.burnedByConversion += msg.jettonAmount;
                storage.save();
                sendExcesses(msg.sendExcessesTo, msg.queryId);
                return;
            }

            // règle A10 : seul le programme de conversion détruit des ConsoM. Tout autre brûlage est refusé :
            // le message rebondit et le wallet du membre rétablit son solde (offre et paliers inchangés).
            throw ERR_BURN_NOT_ALLOWED;
        }

        RequestWalletAddress => {
            var ownerAddress: Cell<address>? = msg.includeOwnerAddress ? msg.ownerAddress.toCell() : null;
            var walletAddress: address? = null;
            if (msg.ownerAddress.getWorkchain() == MY_WORKCHAIN) {
                val storage = lazy ConsoMStorage.load();
                walletAddress = calcWalletAddress(msg.ownerAddress, storage.config.load().walletCode);
            }
            val respondMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseWalletAddress {
                    queryId: msg.queryId,
                    jettonWalletAddress: walletAddress,
                    ownerAddress,
                }
            });
            respondMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        // ---------- Gardien (section 10) ----------
        GuardianPause => {
            var storage = lazy ConsoMStorage.load();
            assert (in.senderAddress == storage.config.load().guardian) throw ERR_NOT_GUARDIAN;
            val now = blockchain.now();
            assert ((storage.lastPauseStart == 0) || (now >= storage.lastPauseStart + PAUSE_MIN_INTERVAL)) throw ERR_PAUSE_TOO_SOON;
            storage.pausedUntil = now + PAUSE_MAX_DURATION;   // immédiate, fin automatique après 14 jours
            storage.lastPauseStart = now;
            storage.save();
        }

        GuardianUnpause => {
            var storage = lazy ConsoMStorage.load();
            assert (in.senderAddress == storage.config.load().guardian) throw ERR_NOT_GUARDIAN;
            storage.pausedUntil = 0;
            storage.save();
        }

        ProposeWitness => {
            var storage = lazy ConsoMStorage.load();
            assert (in.senderAddress == storage.config.load().guardian) throw ERR_NOT_GUARDIAN;
            var witnesses = storage.witnesses.load();
            val now = blockchain.now();
            assert (msg.index < WITNESS_COUNT) throw ERR_BAD_WITNESS_INDEX;
            assert (witnesses.pending == null) throw ERR_REPLACE_PENDING;
            assert ((witnesses.lastReplaceAt == 0) || (now >= witnesses.lastReplaceAt + WITNESS_REPLACE_INTERVAL)) throw ERR_REPLACE_TOO_SOON;
            assert (msg.newKey != 0) throw ERR_ZERO_KEY;
            assert (!witnesses.hasKey(msg.newKey)) throw ERR_DUPLICATE_KEY;
            val pending: PendingWitness = {
                index: msg.index,
                newKey: msg.newKey,
                proposedAt: now,
            };
            witnesses.pending = pending.toCell();
            storage.witnesses = witnesses.toCell();
            storage.save();
        }

        CancelWitness => {
            var storage = lazy ConsoMStorage.load();
            assert (in.senderAddress == storage.config.load().guardian) throw ERR_NOT_GUARDIAN;
            var witnesses = storage.witnesses.load();
            assert (witnesses.pending != null) throw ERR_NO_PENDING;
            witnesses.pending = null;
            storage.witnesses = witnesses.toCell();
            storage.save();
        }

        ExecuteWitness => {
            var storage = lazy ConsoMStorage.load();
            assert (in.senderAddress == storage.config.load().guardian) throw ERR_NOT_GUARDIAN;
            var witnesses = storage.witnesses.load();
            assert (witnesses.pending != null) throw ERR_NO_PENDING;
            val pending = witnesses.pending!.load();
            val now = blockchain.now();
            assert (now >= pending.proposedAt + WITNESS_TIMELOCK) throw ERR_TIMELOCK;
            if (pending.index == 0) {
                witnesses.key0 = pending.newKey;
            } else if (pending.index == 1) {
                witnesses.key1 = pending.newKey;
            } else {
                witnesses.key2 = pending.newKey;
            }
            witnesses.pending = null;
            witnesses.lastReplaceAt = now;
            storage.witnesses = witnesses.toCell();
            storage.save();
        }

        // ---------- Genèse (section 11) ----------
        GenesisFoundersDeposit => {
            var storage = lazy ConsoMStorage.load();
            assert (!storage.genesisDone) throw ERR_GENESIS_DONE;
            assert (in.valueCoins >= MIN_GENESIS_VALUE) throw ERR_NOT_ENOUGH_TON;
            assert (!storage.isPaused()) throw ERR_PAUSED;
            var caps = storage.caps.load();
            caps.setRemaining(CAT_FOUNDERS, caps.founders - FOUNDERS_BANK_DEPOSIT);
            caps.founderShares = FOUNDERS_BANK_DEPOSIT;      // parts à attribuer aux Anciens Contributeurs, dans la banque
            caps.setRemaining(CAT_FOUNDATION, caps.foundation - FOUNDATION_RESERVE);   // réserve de la Fondation : vidée, créée ci-dessous
            storage.caps = caps.toCell();
            storage.genesisDone = true;
            storage.addSupply(FOUNDERS_BANK_DEPOSIT);
            storage.addSupply(FOUNDATION_RESERVE);
            storage.save();
            val bank = storage.bankAddress();
            // la réserve de la Fondation entre dans la banque, dans un stock à part (jamais mélangé à celui des déposants)
            sendMintFunded(storage.config.load().walletCode, bank, FOUNDATION_RESERVE, msg.queryId, in.senderAddress,
                           BANK_NOTIFY_VALUE, taggedForwardPayload(OP_FOUNDATION_DEPOSIT_TAG), FOUNDATION_MINT_VALUE);
            sendMintFunded(storage.config.load().walletCode, bank, FOUNDERS_BANK_DEPOSIT, msg.queryId, in.senderAddress,
                           BANK_NOTIFY_VALUE, taggedForwardPayload(OP_FOUNDERS_DEPOSIT_TAG),
                           max(in.valueCoins - FOUNDATION_MINT_VALUE - MINTER_GAS_MARGIN, 0) as coins);
        }

        // ---------- Part de l'équipe (A9) ----------
        // N'importe qui peut l'appeler : il ne paie que les frais, tout va à l'adresse gravée au déploiement.
        // Puisée uniquement dans la réserve équipe ; pas de fenêtre de 24 mois ni de plafond par membre ;
        // elle compte dans le plafond global du jour : ce qui ne passe pas aujourd'hui reste à libérer pour un prochain appel.
        ReleaseTeamShare => {
            var storage = lazy ConsoMStorage.load();
            assert (in.valueCoins >= TEAM_RELEASE_MIN_VALUE) throw ERR_NOT_ENOUGH_TON;
            assert (!storage.isPaused()) throw ERR_PAUSED;
            var caps = storage.caps.load();
            caps.rollDay();
            val created = CAP_TEAM - caps.team;
            val due = teamUnlocked(storage.t0, blockchain.now()) - created;
            assert (due > 0) throw ERR_NOTHING_TO_RELEASE;
            val room = GLOBAL_DAILY_CAP - caps.dayMinted;
            assert (room > 0) throw ERR_DAILY_CAP;
            val amount = min(due, room);
            caps.setRemaining(CAT_TEAM, caps.team - amount);
            caps.dayMinted += amount;
            storage.caps = caps.toCell();
            storage.addSupply(amount);
            storage.save();
            sendMint(storage.config.load().walletCode, storage.config.load().teamAddress, amount as coins, msg.queryId,
                     in.senderAddress, 0, emptyForwardPayload());
        }

        TopUpTons => {
            // accepte des TON (frais de stockage de l'émetteur)
        }

        else => {
            // message vide accepté (simple envoi de TON), tout autre code d'opération est refusé
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_OP;
        }
    }
}

// ===================================================================================================
// Lecture (get-methods)
// ===================================================================================================

struct JettonDataReply {
    totalSupply: int
    mintable: bool
    adminAddress: any_address
    jettonContent: cell
    jettonWalletCode: cell
}

// TEP-74 : pas d'administrateur (adresse vide)
get fun get_jetton_data(): JettonDataReply {
    val storage = lazy ConsoMStorage.load();
    return {
        totalSupply: storage.totalSupply,
        mintable: true,
        adminAddress: createAddressNone(),
        jettonContent: storage.extra.load().content,
        jettonWalletCode: storage.config.load().walletCode,
    }
}

get fun get_wallet_address(ownerAddress: address): address {
    val storage = lazy ConsoMStorage.load();
    return calcWalletAddress(ownerAddress, storage.config.load().walletCode);
}

struct ConsoMStateReply {
    totalSupply: int
    burnedByConversion: int
    t0: int
    networkId: int
    pausedUntil: int
    lastPauseStart: int
    genesisDone: bool
    halvingSteps: int
}

get fun get_consom_state(): ConsoMStateReply {
    val storage = lazy ConsoMStorage.load();
    return {
        totalSupply: storage.totalSupply,
        burnedByConversion: storage.burnedByConversion,
        t0: storage.t0,
        networkId: storage.networkId,
        pausedUntil: storage.pausedUntil,
        lastPauseStart: storage.lastPauseStart,
        genesisDone: storage.genesisDone,
        halvingSteps: halvingSteps(storage.burnedByConversion),
    }
}

// Plafonds restants, avec la règle des invendus appliquée si sa date est passée
get fun get_caps(): Caps {
    val storage = lazy ConsoMStorage.load();
    var caps = storage.caps.load();
    caps.settlePresaleIfDue(storage.t0);
    caps.zeroRewardsIfOver(storage.t0);
    return caps;
}

// ConsoM à brûler (unités de base) pour convertir `points` Points au taux courant
get fun get_burn_for_points(points: int): int {
    val storage = lazy ConsoMStorage.load();
    return burnForPoints(points, storage.currentHalvingSteps());
}

struct TeamVestingReply {
    unlocked: int          // total libéré à ce jour selon le calendrier (0 avant T0 + 12 mois, 5 000 000 à T0 + 36 mois)
    created: int           // total déjà créé vers l'adresse de l'équipe
    nextReleaseAt: int     // prochaine date de libération ; 0 quand tout est libéré
}

get fun get_team_vesting(): TeamVestingReply {
    val storage = lazy ConsoMStorage.load();
    val caps = storage.caps.load();
    val now = blockchain.now();
    return {
        unlocked: teamUnlocked(storage.t0, now),
        created: CAP_TEAM - caps.team,
        nextReleaseAt: teamNextRelease(storage.t0, now),
    }
}

get fun get_team_address(): address {
    val storage = lazy ConsoMStorage.load();
    return storage.config.load().teamAddress;
}

// A16 : la liste des adresses interdites de réception, gravée au déploiement (dans l'ordre de gravure ; `none` = place libre)
struct ForbiddenListReply {
    count: int
    a0: address?
    a1: address?
    a2: address?
    a3: address?
    a4: address?
    a5: address?
    a6: address?
    a7: address?
}

get fun get_forbidden_recipients(): ForbiddenListReply {
    val storage = lazy ConsoMStorage.load();
    var list: ForbiddenListReply = { count: 0, a0: null, a1: null, a2: null, a3: null, a4: null, a5: null, a6: null, a7: null };
    var cell = storage.config.load().forbidden;
    var i = 0;
    while (cell != null) {
        val chunk = cell!.load();
        var j = 0;
        while (j < 3) {
            val entry: address? = (j == 0) ? chunk.a0 : ((j == 1) ? chunk.a1 : chunk.a2);
            if ((entry != null) && (i < MAX_FORBIDDEN_RECIPIENTS)) {
                if (i == 0) { list.a0 = entry; }
                else if (i == 1) { list.a1 = entry; }
                else if (i == 2) { list.a2 = entry; }
                else if (i == 3) { list.a3 = entry; }
                else if (i == 4) { list.a4 = entry; }
                else if (i == 5) { list.a5 = entry; }
                else if (i == 6) { list.a6 = entry; }
                else { list.a7 = entry; }
                i += 1;
            }
            j += 1;
        }
        cell = chunk.next;
    }
    list.count = i;
    return list;
}

get fun get_witnesses(): Witnesses {
    val storage = lazy ConsoMStorage.load();
    return storage.witnesses.load();
}

get fun get_bank_address(): address {
    val storage = lazy ConsoMStorage.load();
    return storage.bankAddress();
}

get fun get_child_address(isBudget: bool, key: int): address {
    val storage = lazy ConsoMStorage.load();
    val config = storage.config.load();
    return isBudget ? calcChildAddress(config.budgetCode, key) : calcChildAddress(config.memberCode, key);
}
