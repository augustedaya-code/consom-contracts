// Budget de paiement (spécification, section 4) : un contrat par paiement Wave.
//
// Son adresse dépend de l'émetteur et de l'empreinte de l'identifiant Wave (waveRef) : un même paiement
// ne peut donc avoir qu'un seul budget. Il garde ce que les témoins ont attesté (montant, Points) et
// un emplacement par récompense possible ; chaque emplacement ne peut être versé qu'une fois.
// Il n'accepte de messages que de l'émetteur.

import "../jetton/messages"
import "constants"
import "messages"
import "addresses"

const ERR_NOT_MINTER = 450

struct BudgetState {
    waveAmount: coins       // montant payé, en FCFA, tel qu'attesté la première fois
    points: coins           // Points de la commande, tels qu'attestés la première fois
    slots: uint16           // emplacements déjà versés (SLOT_*)
}

contract PaymentBudget {
    author: "TonMarché"
    incomingMessages: BudgetMessage
    storage: ChildInit
}

type BudgetMessage = CheckClaim | ReleaseSlot

fun slotOf(kind: int, level: int): int {
    if (kind == KIND_PRESALE) {
        return SLOT_PRESALE;
    }
    if (kind == KIND_PURCHASE_RECORD) {
        return SLOT_PURCHASE;
    }
    if (kind == KIND_FIRST_PURCHASE) {
        return SLOT_FIRST_PURCHASE;
    }
    if (kind == KIND_CHIKA_BONUS) {
        return SLOT_CHIKA_BONUS;
    }
    if (kind == KIND_EARLY_CONTRIBUTION) {
        return SLOT_EARLY;
    }
    if (kind == KIND_REFERRAL) {
        return 1 << (2 + level);    // niveau 1 à 5 : bits 3 à 7 (déjà vérifié par l'émetteur)
    }
    return 0;
}

fun ChildInit.loadBudgetState(self): BudgetState? {
    if (self.state == null) {
        return null;
    }
    return BudgetState.fromCell(self.state!);
}

fun reject(inValue: coins, minter: address, key: uint256, msg: CheckClaim, refundTo: address, reason: int) {
    keepReserve(inValue, CHILD_STORAGE_RESERVE);
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: minter,
        value: 0,
        body: ClaimRejected {
            queryId: msg.queryId,
            category: msg.category,
            reserved: msg.reserved,
            fromBudget: true,
            key,
            refundTo,
            reason,
            freeSlot: null,
            burnOrder: null,
        }
    }).send(SEND_MODE_CARRY_ALL_BALANCE);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy BudgetMessage.fromSlice(in.body);
    var storage = ChildInit.fromCell(contract.getData());
    assert (in.senderAddress == storage.minter) throw ERR_NOT_MINTER;

    match (msg) {
        CheckClaim => {
            // A16 : destinataire interdit de réception. Refusé avant tout : l'emplacement n'est pas marqué,
            // le même paiement pourra être présenté de nouveau avec le bon destinataire.
            if (msg.recipientForbidden) {
                reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_FORBIDDEN_RECIPIENT);
                return;
            }
            val voucher = msg.voucher.load();
            val payment = voucher.payment.load();
            val slot = slotOf(voucher.kind, voucher.level);
            val previous = storage.loadBudgetState();
            var state: BudgetState = (previous == null)
                ? { waveAmount: payment.waveAmount, points: payment.points, slots: 0 }
                : previous!;

            // tous les bons d'un même paiement doivent porter les mêmes données attestées
            if ((state.waveAmount != payment.waveAmount) || (state.points != payment.points)) {
                reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_PAYMENT_MISMATCH);
                return;
            }
            // un paiement de prévente ne donne que son pack ; un achat ne peut pas devenir une prévente
            val isPresale = voucher.kind == KIND_PRESALE;
            if ((isPresale && (state.slots != 0)) || (!isPresale && ((state.slots & SLOT_PRESALE) != 0))) {
                reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_PRESALE_EXCLUSIVE);
                return;
            }
            if ((state.slots & slot) != 0) {
                reject(in.valueCoins, storage.minter, storage.key, msg, msg.payer, REJECT_SLOT_USED);
                return;
            }

            state.slots = state.slots | slot;
            storage.state = state.toCell();
            contract.setData(storage.toCell());

            keepReserve(in.valueCoins, CHILD_STORAGE_RESERVE);
    createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.minter,
                value: 0,
                body: BudgetApproved {
                    queryId: msg.queryId,
                    category: msg.category,
                    reserved: msg.reserved,
                    voucher: msg.voucher,
                    payer: msg.payer,
                }
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        ReleaseSlot => {
            // le compte membre a refusé ce bon pour une raison passagère : l'emplacement redevient libre
            val previous = storage.loadBudgetState();
            if (previous != null) {
                var state = previous!;
                val voucher = msg.voucher.load();
                state.slots = state.slots & ~slotOf(voucher.kind, voucher.level);
                storage.state = state.toCell();
                contract.setData(storage.toCell());
            }
            keepReserve(in.valueCoins, CHILD_STORAGE_RESERVE);
    createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.refundTo,
                value: 0,
                body: ReturnExcessesBack { queryId: msg.queryId }
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }
    }
}

struct BudgetStateReply {
    initialized: bool
    waveAmount: int
    points: int
    slots: int
}

get fun get_budget_state(): BudgetStateReply {
    val storage = ChildInit.fromCell(contract.getData());
    val state = storage.loadBudgetState();
    if (state == null) {
        return { initialized: false, waveAmount: 0, points: 0, slots: 0 };
    }
    return { initialized: true, waveAmount: state!.waveAmount, points: state!.points, slots: state!.slots };
}
