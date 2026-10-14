// CONTRAT DE TEST UNIQUEMENT — remplace le futur « compte membre » pour tester l'émetteur seul.
// Comportement : refuse le bon si Points = 13 ; sinon accepte, avec 100 % immédiat pour la prévente
// et 50 % immédiat pour les récompenses (le reste reste réservé, comme le vesting).
// TestRelease permet de simuler la libération d'une tranche de vesting.

import "../../contracts/consom/messages"
import "../../contracts/consom/addresses"
import "../../contracts/consom/constants"

struct (0x7e570001) TestRelease {
    queryId: uint64
    recipient: address
    amount: coins
}

type MemberStubMessage = CheckClaim | TestRelease

contract MemberStub {
    incomingMessages: MemberStubMessage
    storage: ChildInit
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy MemberStubMessage.fromSlice(in.body);
    val storage = ChildInit.fromCell(contract.getData());

    match (msg) {
        CheckClaim => {
            val voucher = msg.voucher.load();
            val payment = voucher.payment.load();
            if (payment.points == 13) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.minter,
                    value: 0,
                    body: ClaimRejected {
                        queryId: msg.queryId,
                        category: msg.category,
                        reserved: msg.reserved,
                        fromBudget: false,
                        key: storage.key,
                        refundTo: voucher.recipient,
                    }
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }
            val immediate = (voucher.kind == KIND_PRESALE) ? msg.reserved : (msg.reserved / 2) as coins;
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.minter,
                value: 0,
                body: MintApproved {
                    queryId: msg.queryId,
                    category: msg.category,
                    reserved: msg.reserved,
                    immediate,
                    memberId: storage.key,
                    recipient: voucher.recipient,
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        TestRelease => {
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.minter,
                value: 0,
                body: ReleaseVested {
                    queryId: msg.queryId,
                    memberId: storage.key,
                    recipient: msg.recipient,
                    amount: msg.amount,
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
    }
}
