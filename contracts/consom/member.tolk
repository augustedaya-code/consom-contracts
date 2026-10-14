// Compte membre (spécification, sections 5 et 6) : un contrat par membre de TonMarché.
//
// Son adresse dépend de l'émetteur et de l'empreinte de l'identifiant du membre (memberId).
// Il porte tout ce qui est propre au membre : l'adresse TON liée, le droit au parrainage, les Points attestés,
// les bonus et missions déjà reçus, le plafond de 50 000 ConsoM par 24 h et les tranches de vesting.
// Il n'accepte de bons que de l'émetteur, et de réclamations de vesting que de l'adresse liée.
// Il ne fait jamais échouer un bon : il répond toujours par MintApproved ou ClaimRejected, pour que
// l'émetteur et le budget puissent libérer ce qu'ils avaient réservé.

import "../jetton/messages"
import "constants"
import "messages"
import "addresses"

const ERR_NOT_MINTER      = 450
const ERR_NOT_OWNER       = 451
const ERR_NOTHING_DUE     = 452
const ERR_NOT_INITIALIZED = 453

const FLAG_FIRST_PURCHASE = 1
const FLAG_MISSION_TG     = 2
const FLAG_MISSION_FB     = 4

struct MemberState {
    owner: address                  // adresse liée, fixée par la première réclamation
    referralEligible: bool          // a acheté en prévente (ou Ancien Contributeur, via la genèse)
    hasPayment: bool                // au moins un paiement attesté (condition des missions)
    flags: uint8                    // FLAG_* : bonus de 1er achat et missions déjà reçus
    lastDirectVoucherId: uint64     // conversions et investissements : numéros strictement croissants
    rewardablePoints: coins         // total des Points des commandes attestées
    convertedPoints: coins          // Points déjà récompensés à la conversion (35 %)
    investmentBonus: coins          // bonus d'investissement déjà reçu (unités de base)
    dayStart: uint32
    dayReceived: coins              // reçu pendant la période de 24 h en cours (hors prévente)
    vesting: map<uint32, coins>     // jour de déblocage (jours Unix) -> montant
}

contract MemberAccount {
    author: "TonMarché"
    incomingMessages: MemberMessage
    storage: ChildInit
}

type MemberMessage = CheckClaim | ClaimVesting

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

fun MemberState.addVesting(mutate self, unlockDay: int, amount: int) {
    if (amount == 0) {
        return;
    }
    val existing = self.vesting.get(unlockDay);
    val previous: int = existing.isFound ? existing.loadValue() as int : 0;
    self.vesting.set(unlockDay, (previous + amount) as coins);
}

fun reject(minter: address, memberId: uint256, msg: CheckClaim, refundTo: address, reason: int, freeSlot: bool) {
    keepChildReserve();
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
        }
    }).send(SEND_MODE_CARRY_ALL_BALANCE);
}

// Une tranche de vesting rebondie (émetteur en pause) est remise à disposition aujourd'hui
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy ReleaseVested.fromSlice(in.bouncedBody);
    var storage = ChildInit.fromCell(contract.getData());
    var state = storage.loadMemberState()!;
    state.addVesting(blockchain.now() / ONE_DAY, msg.amount);
    state.dayReceived = max(state.dayReceived - msg.amount, 0) as coins;
    storage.state = state.toCell();
    contract.setData(storage.toCell());
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
                    vesting: [],
                }
                : previous!;

            if (voucher.recipient != state.owner) {
                reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_WRONG_OWNER, true);
                return;
            }

            // ---------- règles propres à chaque type de bon (rien n'est enregistré avant la fin des contrôles) ----------
            var withVesting = true;
            if (kind == KIND_PRESALE) {
                state.referralEligible = true;
                state.hasPayment = true;
                withVesting = false;
            } else if (kind == KIND_PURCHASE_RECORD) {
                state.hasPayment = true;
                state.rewardablePoints += payment.points;
                withVesting = false;
            } else if (kind == KIND_REFERRAL) {
                if (!state.referralEligible) {
                    // parrain non éligible : l'emplacement est perdu (section 6), il n'est pas libéré
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_NOT_ELIGIBLE, false);
                    return;
                }
            } else if (kind == KIND_FIRST_PURCHASE) {
                if ((state.flags & FLAG_FIRST_PURCHASE) != 0) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_ALREADY_DONE, false);
                    return;
                }
                state.flags = state.flags | FLAG_FIRST_PURCHASE;
                state.hasPayment = true;
            } else if ((kind == KIND_MISSION_TG) || (kind == KIND_MISSION_FB)) {
                val flag = (kind == KIND_MISSION_TG) ? FLAG_MISSION_TG : FLAG_MISSION_FB;
                if (!state.hasPayment) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_NO_PAYMENT, false);
                    return;
                }
                if ((state.flags & flag) != 0) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_ALREADY_DONE, false);
                    return;
                }
                state.flags = state.flags | flag;
            } else if (kind == KIND_CONVERSION) {
                if (voucher.voucherId <= state.lastDirectVoucherId) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_STALE_VOUCHER, false);
                    return;
                }
                if (state.convertedPoints + payment.points > state.rewardablePoints) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_NOT_ENOUGH_POINTS, false);
                    return;
                }
                state.lastDirectVoucherId = voucher.voucherId;
                state.convertedPoints += payment.points;
            } else if (kind == KIND_INVESTMENT) {
                if (voucher.voucherId <= state.lastDirectVoucherId) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_STALE_VOUCHER, false);
                    return;
                }
                val limit = mulDivFloor(state.rewardablePoints * ONE_CONSOM, INVESTMENT_RATE_BP, BP_DENOMINATOR);
                if (state.investmentBonus + msg.reserved > limit) {
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_NOT_ENOUGH_POINTS, false);
                    return;
                }
                state.lastDirectVoucherId = voucher.voucherId;
                state.investmentBonus += msg.reserved;
            }

            // ---------- part immédiate, vesting et plafond de 50 000 par 24 h ----------
            val immediate: int = withVesting ? msg.reserved / 2 : msg.reserved as int;
            val vested: int = msg.reserved - immediate;
            if (kind != KIND_PRESALE) {
                state.rollDay();
                if (state.dayReceived + immediate > MEMBER_DAILY_CAP) {
                    // passager : le bon pourra être réclamé de nouveau s'il n'a pas expiré
                    reject(storage.minter, storage.key, msg, voucher.recipient, REJECT_DAILY_CAP, true);
                    return;
                }
                state.dayReceived += immediate;
            }
            if (vested > 0) {
                val tranche: int = vested / VESTING_TRANCHES;
                val now = blockchain.now();
                var k = 1;
                while (k <= VESTING_TRANCHES) {
                    val amount: int = (k == VESTING_TRANCHES) ? vested - tranche * (VESTING_TRANCHES - 1) : tranche;
                    state.addVesting((now + k * VESTING_INTERVAL) / ONE_DAY, amount);
                    k += 1;
                }
            }

            storage.state = state.toCell();
            contract.setData(storage.toCell());

            keepChildReserve();
    createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.minter,
                value: 0,
                body: MintApproved {
                    queryId: msg.queryId,
                    category: msg.category,
                    reserved: msg.reserved,
                    immediate: immediate as coins,
                    memberId: storage.key,
                    recipient: state.owner,
                }
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        ClaimVesting => {
            val previous = storage.loadMemberState();
            assert (previous != null) throw ERR_NOT_INITIALIZED;
            var state = previous!;
            assert (in.senderAddress == state.owner) throw ERR_NOT_OWNER;

            // toutes les tranches échues, dans la limite du plafond du jour ; le reste attend
            val today = blockchain.now() / ONE_DAY;
            var due = 0;
            var r = state.vesting.findFirst();
            while (r.isFound && (r.getKey() <= today)) {
                due += r.loadValue();
                state.vesting.delete(r.getKey());
                r = state.vesting.findFirst();
            }
            state.rollDay();
            val allowance = MEMBER_DAILY_CAP - state.dayReceived;
            val release = min(due, allowance);
            assert (release > 0) throw ERR_NOTHING_DUE;
            state.addVesting(today, due - release);
            state.dayReceived += release;
            storage.state = state.toCell();
            contract.setData(storage.toCell());

            keepChildReserve();
    createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.minter,
                value: 0,
                body: ReleaseVested {
                    queryId: msg.queryId,
                    amount: release as coins,
                    memberId: storage.key,
                    recipient: state.owner,
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
    vestingLocked: int      // tranches pas encore échues
    vestingDue: int         // tranches échues, réclamables
}

get fun get_member_state(): MemberStateReply {
    val storage = ChildInit.fromCell(contract.getData());
    val previous = storage.loadMemberState();
    if (previous == null) {
        return {
            initialized: false, owner: null, referralEligible: false, hasPayment: false, flags: 0,
            lastDirectVoucherId: 0, rewardablePoints: 0, convertedPoints: 0, investmentBonus: 0,
            dayReceived: 0, vestingLocked: 0, vestingDue: 0,
        };
    }
    val state = previous!;
    val today = blockchain.now() / ONE_DAY;
    var locked = 0;
    var due = 0;
    var r = state.vesting.findFirst();
    while (r.isFound) {
        if (r.getKey() <= today) {
            due += r.loadValue();
        } else {
            locked += r.loadValue();
        }
        r = state.vesting.iterateNext(r);
    }
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
        vestingLocked: locked,
        vestingDue: due,
    }
}
