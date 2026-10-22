// Compte membre (spécification, sections 5 et 6) : un contrat par membre de TonMarché.
//
// Son adresse dépend de l'émetteur et de l'empreinte de l'identifiant du membre (memberId).
// Il porte tout ce qui est propre au membre : l'adresse TON liée, le droit au parrainage, les Points attestés,
// les bonus et missions déjà reçus, et le plafond de 50 000 ConsoM par 24 h.
// Les Points d'un achat ne donnent droit au bonus de conversion que pendant 7 jours.
// Il n'accepte de messages que de l'émetteur. Les récompenses sont versées en entier, sans étalement.
// Il ne fait jamais échouer un bon : il répond toujours par MintApproved ou ClaimRejected, pour que
// l'émetteur et le budget puissent libérer ce qu'ils avaient réservé.

import "../jetton/messages"
import "constants"
import "messages"
import "addresses"

const ERR_NOT_MINTER      = 450

const FLAG_FIRST_PURCHASE = 1
const FLAG_MISSION_TG     = 2
const FLAG_MISSION_FB     = 4

struct MemberState {
    owner: address                  // adresse liée, fixée par la première réclamation
    referralEligible: bool          // a acheté en prévente (ou Ancien Contributeur, via la genèse)
    hasPayment: bool                // au moins un paiement attesté (condition des missions)
    flags: uint8                    // FLAG_* : bonus de 1er achat et missions déjà reçus
    lastDirectVoucherId: uint64     // conversions et investissements : numéros strictement croissants
    rewardablePoints: coins         // total des Points des commandes attestées (borne du bonus d'investissement)
    convertedPoints: coins          // total des Points déjà récompensés à la conversion (35 %)
    points: map<uint32, coins>      // Points encore convertibles, par heure d'expiration (temps Unix)
    investmentBonus: coins          // bonus d'investissement déjà reçu (unités de base)
    dayStart: uint32
    dayReceived: coins              // reçu pendant la période de 24 h en cours (hors prévente)
}

contract MemberAccount {
    author: "TonMarché"
    incomingMessages: MemberMessage
    storage: ChildInit
}

type MemberMessage = CheckClaim

fun ChildInit.loadMemberState(self): MemberState? {
    if (self.state == null) {
        return null;
    }
    return MemberState.fromCell(self.state!);
}

fun MemberState.rollDay(mutate self) {
    val now = blockchain.now();
    if (now >= self.dayStart + ONE_DAY) {
        self.dayStart = now;
        self.dayReceived = 0;
    }
}

// Retire les Points expirés (clé = heure d'expiration ; expirés dès que l'heure est atteinte)
fun MemberState.dropExpiredPoints(mutate self) {
    val now = blockchain.now();
    var r = self.points.findFirst();
    while (r.isFound && (r.getKey() <= now)) {
        self.points.delete(r.getKey());
        r = self.points.findFirst();
    }
}

fun MemberState.addPoints(mutate self, amount: int) {
    if (amount == 0) {
        return;
    }
    val expiry = (blockchain.now() + POINTS_VALIDITY) / POINTS_BUCKET * POINTS_BUCKET;
    val existing = self.points.get(expiry);
    val previous: int = existing.isFound ? existing.loadValue() as int : 0;
    self.points.set(expiry, (previous + amount) as coins);
}

fun MemberState.availablePoints(self): int {
    val now = blockchain.now();
    var total = 0;
    var r = self.points.findFirst();
    while (r.isFound) {
        if (r.getKey() > now) {
            total += r.loadValue();
        }
        r = self.points.iterateNext(r);
    }
    return total;
}

// Utilise `amount` Points encore valides, les plus proches de l'expiration d'abord (à appeler après dropExpiredPoints)
fun MemberState.consumePoints(mutate self, amount: int) {
    var left = amount;
    while (left > 0) {
        val r = self.points.findFirst();
        val key = r.getKey();
        val value: int = r.loadValue();
        if (value <= left) {
            self.points.delete(key);
            left -= value;
        } else {
            self.points.set(key, (value - left) as coins);
            left = 0;
        }
    }
}

fun reject(inValue: coins, minter: address, memberId: uint256, msg: CheckClaim, refundTo: address, reason: int, freeSlot: bool) {
    keepReserve(inValue, CHILD_STORAGE_RESERVE);
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: minter,
        value: 0,
        body: ClaimRejected {
            queryId: msg.queryId,
            category: msg.category,
            reserved: msg.reserved,
            fromBudget: false,
            key: memberId,
            refundTo,
            reason,
            freeSlot: (freeSlot && msg.viaBudget) ? msg.voucher : null,
            burnOrder: msg.burnOrder,
        }
    }).send(SEND_MODE_CARRY_ALL_BALANCE);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy MemberMessage.fromSlice(in.body);
    var storage = ChildInit.fromCell(contract.getData());

    match (msg) {
        CheckClaim => {
            assert (in.senderAddress == storage.minter) throw ERR_NOT_MINTER;
            val voucher = msg.voucher.load();
            val payment = voucher.payment.load();
            val kind = voucher.kind;
            val previous = storage.loadMemberState();
            var state: MemberState = (previous == null)
                ? {
                    owner: voucher.recipient,
                    referralEligible: false,
                    hasPayment: false,
                    flags: 0,
                    lastDirectVoucherId: 0,
                    rewardablePoints: 0,
                    convertedPoints: 0,
                    investmentBonus: 0,
                    dayStart: 0,
                    dayReceived: 0,
                    points: [],
                }
                : previous!;

            if (voucher.recipient != state.owner) {
                reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_WRONG_OWNER, true);
                return;
            }

            // ---------- règles propres à chaque type de bon (rien n'est enregistré avant la fin des contrôles) ----------
            if (kind == KIND_PRESALE) {
                state.referralEligible = true;
                state.hasPayment = true;
            } else if (kind == KIND_PURCHASE_RECORD) {
                state.hasPayment = true;
                state.rewardablePoints += payment.points;
                state.dropExpiredPoints();
                state.addPoints(payment.points);
            } else if (kind == KIND_REFERRAL) {
                if (!state.referralEligible) {
                    // parrain non éligible : l'emplacement est perdu (section 6), il n'est pas libéré
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_NOT_ELIGIBLE, false);
                    return;
                }
            } else if (kind == KIND_FIRST_PURCHASE) {
                if ((state.flags & FLAG_FIRST_PURCHASE) != 0) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_ALREADY_DONE, false);
                    return;
                }
                state.flags = state.flags | FLAG_FIRST_PURCHASE;
                state.hasPayment = true;
            } else if ((kind == KIND_MISSION_TG) || (kind == KIND_MISSION_FB)) {
                val flag = (kind == KIND_MISSION_TG) ? FLAG_MISSION_TG : FLAG_MISSION_FB;
                if (!state.hasPayment) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_NO_PAYMENT, false);
                    return;
                }
                if ((state.flags & flag) != 0) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_ALREADY_DONE, false);
                    return;
                }
                state.flags = state.flags | flag;
            } else if (kind == KIND_CONVERSION) {
                if (voucher.voucherId <= state.lastDirectVoucherId) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_STALE_VOUCHER, false);
                    return;
                }
                state.dropExpiredPoints();
                if (payment.points > state.availablePoints()) {
                    // Points jamais attestés, déjà convertis, ou attestés il y a plus de 7 jours
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_NOT_ENOUGH_POINTS, false);
                    return;
                }
                state.lastDirectVoucherId = voucher.voucherId;
                state.consumePoints(payment.points);
                state.convertedPoints += payment.points;
            } else if ((kind == KIND_BANK_CONVERSION) || (kind == KIND_OWN_CONVERSION)) {
                // conversion (brûlage) : seul contrôle ici, un bon ne sert qu'une fois
                if (voucher.voucherId <= state.lastDirectVoucherId) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_STALE_VOUCHER, false);
                    return;
                }
                state.lastDirectVoucherId = voucher.voucherId;
            } else if (kind == KIND_INVESTMENT) {
                if (voucher.voucherId <= state.lastDirectVoucherId) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_STALE_VOUCHER, false);
                    return;
                }
                val limit = mulDivFloor(state.rewardablePoints * ONE_CONSOM, INVESTMENT_RATE_BP, BP_DENOMINATOR);
                if (state.investmentBonus + msg.reserved > limit) {
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_NOT_ENOUGH_POINTS, false);
                    return;
                }
                state.lastDirectVoucherId = voucher.voucherId;
                state.investmentBonus += msg.reserved;
            }

            // ---------- plafond de 50 000 par 24 h (hors prévente) ; tout est versé tout de suite ----------
            if (kind != KIND_PRESALE) {
                state.rollDay();
                if (state.dayReceived + msg.reserved > MEMBER_DAILY_CAP) {
                    // passager : le bon pourra être réclamé de nouveau s'il n'a pas expiré
                    reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_DAILY_CAP, true);
                    return;
                }
                state.dayReceived += msg.reserved;
            }

            storage.state = state.toCell();
            contract.setData(storage.toCell());

            keepReserve(in.valueCoins, CHILD_STORAGE_RESERVE);
    createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.minter,
                value: 0,
                body: MintApproved {
                    queryId: msg.queryId,
                    category: msg.category,
                    reserved: msg.reserved,
                    memberId: storage.key,
                    recipient: state.owner,
                    burnOrder: msg.burnOrder,
                    payer: msg.payer,
                }
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }
    }
}

// ---------- Lecture ----------

struct MemberStateReply {
    initialized: bool
    owner: address?
    referralEligible: bool
    hasPayment: bool
    flags: int
    lastDirectVoucherId: int
    rewardablePoints: int
    convertedPoints: int
    investmentBonus: int
    dayReceived: int
    availablePoints: int    // Points encore convertibles (moins de 7 jours)
}

get fun get_member_state(): MemberStateReply {
    val storage = ChildInit.fromCell(contract.getData());
    val previous = storage.loadMemberState();
    if (previous == null) {
        return {
            initialized: false, owner: null, referralEligible: false, hasPayment: false, flags: 0,
            lastDirectVoucherId: 0, rewardablePoints: 0, convertedPoints: 0, investmentBonus: 0,
            dayReceived: 0, availablePoints: 0,
        };
    }
    val state = previous!;
    val dayReceived = (blockchain.now() >= state.dayStart + ONE_DAY) ? 0 : state.dayReceived as int;
    return {
        initialized: true,
        owner: state.owner,
        referralEligible: state.referralEligible,
        hasPayment: state.hasPayment,
        flags: state.flags,
        lastDirectVoucherId: state.lastDirectVoucherId,
        rewardablePoints: state.rewardablePoints,
        convertedPoints: state.convertedPoints,
        investmentBonus: state.investmentBonus,
        dayReceived,
        availablePoints: state.availablePoints(),
    }
}
