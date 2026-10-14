// CONTRAT DE TEST UNIQUEMENT — remplace le futur « budget de paiement » pour tester l'émetteur seul.
// Comportement : refuse le bon si le montant payé vaut 13 FCFA, sinon le transmet au compte membre.

import "../../contracts/consom/messages"
import "../../contracts/consom/addresses"

contract BudgetStub {
    incomingMessages: CheckClaim
    storage: ChildInit
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy CheckClaim.fromSlice(in.body);
    val storage = ChildInit.fromCell(contract.getData());
    assert (in.senderAddress == storage.minter) throw 430;
    val voucher = msg.voucher.load();
    val payment = voucher.payment.load();

    if (payment.waveAmount == 13) {
        createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.minter,
            value: 0,
            body: ClaimRejected {
                queryId: msg.queryId,
                category: msg.category,
                reserved: msg.reserved,
                fromBudget: true,
                key: storage.key,
                refundTo: voucher.recipient,
            }
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }

    val memberInit: ChildInit = { minter: storage.minter, key: payment.memberId, state: null };
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: { stateInit: { code: msg.memberCode, data: memberInit.toCell() } },
        value: 0,
        body: CheckClaim {
            queryId: msg.queryId,
            category: msg.category,
            reserved: msg.reserved,
            voucher: msg.voucher,
            memberCode: msg.memberCode,
        }
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}
