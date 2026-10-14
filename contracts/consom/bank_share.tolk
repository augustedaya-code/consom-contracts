// Parts d'un déposant de la banque d'échange (spécification, section 9) : un contrat par déposant.
// Son adresse dépend de la banque et de l'adresse du déposant. Il retient le nombre de parts et la date du
// dernier dépôt ; le retrait n'est possible que 24 h après ce dépôt et seulement si la banque est ouverte.

import "../jetton/messages"
import "constants"
import "messages"
import "addresses"

const ERR_NOT_BANK        = 470
const ERR_NOT_OWNER       = 471
const ERR_TOO_EARLY       = 472
const ERR_NOT_ENOUGH      = 473

const SHARE_STORAGE_RESERVE = ton("0.01")

struct ShareState {
    shares: coins
    lastDepositAt: uint32
}

contract BankShare {
    author: "TonMarché"
    incomingMessages: ShareMessage
    storage: ShareInit
}

type ShareMessage = AddShares | WithdrawRequest

fun ShareInit.loadShareState(self): ShareState {
    if (self.state == null) {
        return { shares: 0, lastDepositAt: 0 };
    }
    return ShareState.fromCell(self.state!);
}

fun ShareInit.saveShareState(mutate self, state: ShareState) {
    self.state = state.toCell();
    contract.setData(self.toCell());
}

// Un retrait refusé par la banque (encore fermée) rend les parts
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy WithdrawShares.fromSlice(in.bouncedBody);
    var storage = ShareInit.fromCell(contract.getData());
    var state = storage.loadShareState();
    state.shares += msg.shares;
    storage.saveShareState(state);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy ShareMessage.fromSlice(in.body);
    var storage = ShareInit.fromCell(contract.getData());
    var state = storage.loadShareState();

    match (msg) {
        AddShares => {
            assert (in.senderAddress == storage.bank) throw ERR_NOT_BANK;
            state.shares += msg.shares;
            state.lastDepositAt = msg.at;
            storage.saveShareState(state);
            keepReserve(in.valueCoins, SHARE_STORAGE_RESERVE);
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.owner,
                value: 0,
                body: ReturnExcessesBack { queryId: msg.queryId }
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        WithdrawRequest => {
            assert (in.senderAddress == storage.owner) throw ERR_NOT_OWNER;
            assert (blockchain.now() >= state.lastDepositAt + BANK_WITHDRAW_DELAY) throw ERR_TOO_EARLY;
            val shares = (msg.shares == 0) ? state.shares : msg.shares;
            assert ((shares > 0) && (shares <= state.shares)) throw ERR_NOT_ENOUGH;
            state.shares -= shares;
            storage.saveShareState(state);
            keepReserve(in.valueCoins, SHARE_STORAGE_RESERVE);
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.bank,
                value: 0,
                body: WithdrawShares { queryId: msg.queryId, shares, owner: storage.owner }
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }
    }
}

struct ShareStateReply {
    shares: int
    lastDepositAt: int
}

get fun get_share_state(): ShareStateReply {
    val storage = ShareInit.fromCell(contract.getData());
    val state = storage.loadShareState();
    return { shares: state.shares, lastDepositAt: state.lastDepositAt };
}
