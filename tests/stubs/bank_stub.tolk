// CONTRAT DE TEST UNIQUEMENT — remplace la future « banque d'échange » pour tester l'émetteur seul.
// Comportement : reçoit des ConsoM ; TestBurn demande à son wallet ConsoM de brûler un montant
// (ce qui correspond à un brûlage de conversion).

import "../../contracts/jetton/messages"
import "../../contracts/consom/addresses"

struct (0x7e570002) TestBurn {
    queryId: uint64
    wallet: address
    amount: coins
}

type BankStubMessage = TestBurn | TransferNotificationForRecipient

contract BankStub {
    incomingMessages: BankStubMessage
    storage: BankInit
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy BankStubMessage.fromSlice(in.body);
    match (msg) {
        TestBurn => {
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.wallet,
                value: 0,
                body: AskToBurn {
                    queryId: msg.queryId,
                    jettonAmount: msg.amount,
                    sendExcessesTo: in.senderAddress,
                    customPayload: null,
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        TransferNotificationForRecipient => {
            // dépôt reçu : rien à faire dans ce contrat de test
        }
    }
}
