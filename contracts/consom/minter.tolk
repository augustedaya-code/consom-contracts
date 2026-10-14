// Émetteur ConsoM (spécification : docs/SPECIFICATION.md, sections 2 à 10).
//
// Ce contrat n'a AUCUN administrateur : pas de création libre, pas de changement de code ni de métadonnées.
// Une émission n'est possible que :
//   - par un bon signé par 2 témoins sur 3, envoyé par son bénéficiaire, puis accepté par le budget de paiement
//     et/ou le compte membre (contrats enfants dont l'émetteur connaît le code) ;
//   - une seule fois à la genèse, pour déposer 70 % de l'allocation des Anciens Contributeurs dans la banque ;
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
    | ClaimRejected
    | ReleaseVested
    | BurnNotificationForMinter
    | RequestWalletAddress
    | GuardianPause
    | GuardianUnpause
    | ProposeWitness
    | CancelWitness
    | ExecuteWitness
    | GenesisFoundersDeposit
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
    return CAT_MISSIONS;    // 1er achat, missions, investissement
}

// Les bons liés à un paiement Wave passent d'abord par le budget de ce paiement ;
// les autres vont directement au compte du membre.
fun usesPaymentBudget(kind: int): bool {
    return (kind == KIND_PRESALE) || (kind == KIND_PURCHASE_RECORD) || (kind == KIND_REFERRAL) || (kind == KIND_FIRST_PURCHASE);
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
    if (kind == KIND_CONVERSION) {
        return mulDivFloor(payment.points * ONE_CONSOM, CONVERSION_RATE_BP, BP_DENOMINATOR);
    }
    if ((kind == KIND_MISSION_TG) || (kind == KIND_MISSION_FB)) {
        return MISSION_REWARD;
    }
    if (kind == KIND_INVESTMENT) {
        return mulDivFloor(payment.points * ONE_CONSOM, INVESTMENT_RATE_BP, BP_DENOMINATOR);
    }
    return -1;
}

// Nombre de paliers de halving (section 8).
// La 1re année : un palier tous les 800 000 ; ensuite un palier tous les 12 000 000, avec report
// de ce qui dépassait le dernier palier de la 1re année.
fun halvingSteps(burnedByConversion: int, burnedInYear1: int): int {
    val n1 = burnedInYear1 / HALVING_STEP_YEAR1;
    val n = n1 + (burnedByConversion - n1 * HALVING_STEP_YEAR1) / HALVING_STEP_AFTER;
    return min(n, HALVING_MAX_STEPS);
}

// ConsoM à brûler (unités de base) pour convertir `points` Points : ceil(points × 10^8 / 2^n)
fun burnForPoints(points: int, steps: int): int {
    return mulDivCeil(points, BURN_PER_POINT_NUMERATOR, 1 << steps);
}

// ===================================================================================================
// Plafonds
// ===================================================================================================

fun Caps.remainingOf(self, category: int): int {
    if (category == CAT_PRESALE) {
        return self.presale;
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
    return self.team;
}

fun Caps.setRemaining(mutate self, category: int, value: coins) {
    if (category == CAT_PRESALE) {
        self.presale = value;
    } else if (category == CAT_PURCHASE) {
        self.purchase = value;
    } else if (category == CAT_REFERRAL) {
        self.referral = value;
    } else if (category == CAT_MISSIONS) {
        self.missions = value;
    } else if (category == CAT_FOUNDERS) {
        self.founders = value;
    } else {
        self.team = value;
    }
}

// Règle des invendus (section 3) : à T0 + 12 mois, 50 % du reste de la prévente sont retirés,
// 25 % vont aux récompenses d'achat et 25 % au parrainage. Appliquée une seule fois.
fun Caps.settlePresaleIfDue(mutate self, t0: int) {
    if (!self.presaleSettled && (blockchain.now() >= t0 + PRESALE_WINDOW)) {
        val quarter = self.presale / 4;
        self.purchase += quarter;
        self.referral += quarter;
        self.presale = 0;
        self.presaleSettled = true;
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

fun checkWitnessSignature(witnesses: Witnesses, hash: uint256, sigCell: Cell<WitnessSignature>): int {
    val sig = sigCell.load();
    assert (sig.index < WITNESS_COUNT) throw ERR_BAD_WITNESS_INDEX;
    assert (isSignatureValid(hash, sig.signature as slice, witnesses.keyAt(sig.index))) throw ERR_BAD_SIGNATURE;
    return sig.index;
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
const OP_RECYCLED_DEPOSIT_TAG = 0xc0150031

// Garde-fou d'offre : jetons en circulation + jetons brûlés par les conversions <= 230 M.
// (Les brûlages volontaires sont recréés, ils ne sortent donc pas de ce total.)
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
    val msg = lazy AllowedMessageToConsoMMinter.fromSlice(in.body);

    match (msg) {

        // ---------- Bon d'émission (section 5) ----------
        ClaimVoucher => {
            var storage = lazy ConsoMStorage.load();
            assert (!storage.isPaused()) throw ERR_PAUSED;
            assert (in.valueCoins >= MIN_CLAIM_VALUE) throw ERR_NOT_ENOUGH_TON;

            val voucherHash = msg.voucher.hash();
            val voucher = msg.voucher.load();
            val now = blockchain.now();
            assert (voucher.networkId == storage.networkId) throw ERR_WRONG_NETWORK;
            assert (voucher.minter == contract.getAddress()) throw ERR_WRONG_MINTER;
            assert (now <= voucher.validUntil) throw ERR_EXPIRED;
            assert (voucher.validUntil <= now + VOUCHER_MAX_VALIDITY) throw ERR_VALIDITY_TOO_LONG;
            assert (in.senderAddress == voucher.recipient) throw ERR_NOT_RECIPIENT;
            assert (voucher.kind <= KIND_MAX) throw ERR_UNKNOWN_KIND;

            // 2 signatures valides de 2 témoins différents
            val witnesses = storage.witnesses.load();
            val indexA = checkWitnessSignature(witnesses, voucherHash, msg.sigA);
            val indexB = checkWitnessSignature(witnesses, voucherHash, msg.sigB);
            assert (indexA != indexB) throw ERR_SAME_WITNESS;

            // fenêtre de la catégorie : prévente jusqu'à T0 + 12 mois, récompenses jusqu'à T0 + 18 mois
            val windowEnd = (voucher.kind == KIND_PRESALE) ? storage.t0 + PRESALE_WINDOW : storage.t0 + REWARDS_WINDOW;
            assert ((now >= storage.t0) && (now < windowEnd)) throw ERR_WINDOW_CLOSED;

            // montant recalculé par le contrat
            val payment = voucher.payment.load();
            assert (voucher.amount == expectedAmount(voucher.kind, voucher.level, voucher.amount, payment)) throw ERR_WRONG_AMOUNT;
            if ((voucher.kind == KIND_PURCHASE_RECORD) || (voucher.kind == KIND_REFERRAL)) {
                assert (payment.points * P_MAX_DENOMINATOR <= payment.waveAmount) throw ERR_POINTS_TOO_HIGH;
            }

            // réservation sur le plafond de la catégorie et sur le plafond journalier global
            val category = categoryOf(voucher.kind);
            var caps = storage.caps.load();
            caps.settlePresaleIfDue(storage.t0);
            caps.rollDay();
            if (voucher.amount > 0) {
                assert (caps.remainingOf(category) >= voucher.amount) throw ERR_CATEGORY_CAP;
                assert (caps.dayMinted + voucher.amount <= GLOBAL_DAILY_CAP) throw ERR_DAILY_CAP;
                caps.setRemaining(category, caps.remainingOf(category) - voucher.amount);
                caps.dayMinted += voucher.amount;
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
                    reserved: voucher.amount,
                    viaBudget: false,
                    voucher: msg.voucher,
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
                }
            });
            checkMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        MintApproved => {
            var storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            assert (in.senderAddress == calcChildAddress(config.memberCode, msg.memberId)) throw ERR_NOT_CHILD;
            assert (msg.immediate <= msg.reserved) throw ERR_WRONG_AMOUNT;
            if (msg.immediate == 0) {
                sendExcesses(msg.recipient, msg.queryId);
                return;
            }
            storage.addSupply(msg.immediate);
            storage.save();
            sendMint(config.walletCode, msg.recipient, msg.immediate, msg.queryId, msg.recipient, 0, emptyForwardPayload());
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

        ReleaseVested => {
            var storage = lazy ConsoMStorage.load();
            assert (!storage.isPaused()) throw ERR_PAUSED;
            val config = storage.config.load();
            assert (in.senderAddress == calcChildAddress(config.memberCode, msg.memberId)) throw ERR_NOT_CHILD;
            storage.addSupply(msg.amount);
            storage.save();
            sendMint(config.walletCode, msg.recipient, msg.amount, msg.queryId, msg.recipient, 0, emptyForwardPayload());
        }

        // ---------- Brûlages (section 8) ----------
        BurnNotificationForMinter => {
            var storage = lazy ConsoMStorage.load();
            val config = storage.config.load();
            assert (in.senderAddress == calcWalletAddress(msg.burnInitiator, config.walletCode)) throw ERR_NOT_WALLET;
            val bank = calcBankAddress(storage.extra.load().bank.load().bankCode);

            if (msg.burnInitiator == bank) {
                // brûlage de conversion : définitif, compte pour le halving
                storage.totalSupply -= msg.jettonAmount;
                storage.burnedByConversion += msg.jettonAmount;
                if (blockchain.now() < storage.t0 + ONE_YEAR) {
                    storage.burnedInYear1 += msg.jettonAmount;
                }
                storage.save();
                sendExcesses(msg.sendExcessesTo, msg.queryId);
                return;
            }

            // brûlage volontaire : recréé immédiatement dans la banque, comme stock sans propriétaire.
            // Fonctionne même pendant une pause. Sans assez de TON, le message rebondit et le wallet
            // rétablit le solde : le brûlage n'a pas lieu.
            assert (in.valueCoins >= RECYCLE_MIN_VALUE) throw ERR_NOT_ENOUGH_TON;
            storage.recycled += msg.jettonAmount;
            storage.save();     // totalSupply inchangé : -montant puis +montant
            sendMint(config.walletCode, bank, msg.jettonAmount, msg.queryId, msg.sendExcessesTo,
                     BANK_NOTIFY_VALUE, taggedForwardPayload(OP_RECYCLED_DEPOSIT_TAG));
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
            assert (!storage.isPaused()) throw ERR_PAUSED;
            var caps = storage.caps.load();
            caps.setRemaining(CAT_FOUNDERS, caps.founders - FOUNDERS_BANK_DEPOSIT);
            storage.caps = caps.toCell();
            storage.genesisDone = true;
            storage.addSupply(FOUNDERS_BANK_DEPOSIT);
            storage.save();
            val bank = calcBankAddress(storage.extra.load().bank.load().bankCode);
            sendMint(storage.config.load().walletCode, bank, FOUNDERS_BANK_DEPOSIT, msg.queryId, in.senderAddress,
                     BANK_NOTIFY_VALUE, taggedForwardPayload(OP_FOUNDERS_DEPOSIT_TAG));
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
    burnedInYear1: int
    recycled: int
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
        burnedInYear1: storage.burnedInYear1,
        recycled: storage.recycled,
        t0: storage.t0,
        networkId: storage.networkId,
        pausedUntil: storage.pausedUntil,
        lastPauseStart: storage.lastPauseStart,
        genesisDone: storage.genesisDone,
        halvingSteps: halvingSteps(storage.burnedByConversion, storage.burnedInYear1),
    }
}

// Plafonds restants, avec la règle des invendus appliquée si sa date est passée
get fun get_caps(): Caps {
    val storage = lazy ConsoMStorage.load();
    var caps = storage.caps.load();
    caps.settlePresaleIfDue(storage.t0);
    return caps;
}

// ConsoM à brûler (unités de base) pour convertir `points` Points au taux courant
get fun get_burn_for_points(points: int): int {
    val storage = lazy ConsoMStorage.load();
    return burnForPoints(points, halvingSteps(storage.burnedByConversion, storage.burnedInYear1));
}

get fun get_witnesses(): Witnesses {
    val storage = lazy ConsoMStorage.load();
    return storage.witnesses.load();
}

get fun get_bank_address(): address {
    val storage = lazy ConsoMStorage.load();
    return calcBankAddress(storage.extra.load().bank.load().bankCode);
}

get fun get_child_address(isBudget: bool, key: int): address {
    val storage = lazy ConsoMStorage.load();
    val config = storage.config.load();
    return isBudget ? calcChildAddress(config.budgetCode, key) : calcChildAddress(config.memberCode, key);
}
