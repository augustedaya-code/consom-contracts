// Banque d'échange (spécification, sections 8 et 9).
//
// Elle détient des ConsoM pour le compte de ses déposants et les brûle pour les conversions.
// Deux stocks, tous dans son wallet ConsoM :
//   - le stock des déposants, divisé en parts (contrat « parts d'un déposant », un par déposant) ;
//   - les jetons reçus pour une conversion avec ses propres ConsoM, en attente de la vérification du bon.
// Le stock n'est fait QUE de ConsoM déposés (dont la genèse des Anciens Contributeurs) : un envoi sans objet
// reconnu est refusé et rendu à l'expéditeur. Rien n'est jamais recréé.
// Un brûlage de conversion via la banque est prélevé sur le stock des déposants, sans toucher aux parts :
// chaque déposant perd la même proportion de son dépôt.
// Seuls ses brûlages comptent pour le halving : elle ne brûle que sur ordre de l'émetteur, après un bon signé.

import "../jetton/messages"
import "../jetton/jetton-utils"
import "constants"
import "messages"
import "addresses"

const ERR_NOT_MINTER        = 460
const ERR_NOT_MY_WALLET     = 461
const ERR_NOT_SHARE         = 462
const ERR_BANK_CLOSED       = 463
const ERR_NOTHING_TO_REDEEM = 464
const ERR_UNKNOWN_DEPOSIT  = 465

const BANK_STORAGE_RESERVE   = ton("0.05")
const OWN_CONVERSION_MIN_VALUE = ton("0.2")   // TON joint au transfert pour faire vérifier le bon et brûler

const OP_FOUNDERS_TAG  = 0xc0150030
const OP_DEPOSIT_TAG   = 0xc0150032
const OP_OWN_CONV_TAG  = 0xc0150033

struct BankState {
    depositorStock: coins       // ConsoM des déposants
    totalShares: coins          // parts émises (Anciens Contributeurs compris)
    unassignedShares: coins     // parts de la genèse pas encore attribuées à chaque Ancien Contributeur
    escrow: coins               // ConsoM reçus pour des conversions avec ses propres ConsoM en cours
    dayStart: uint32
    dayCap: coins               // 5 % du stock au début de la période de 24 h
    dayBurned: coins            // brûlé via la banque pendant la période
}

contract ExchangeBank {
    author: "TonMarché"
    incomingMessages: BankMessage
    storage: BankInit
}

type BankMessage = TransferNotificationForRecipient | BankBurn | EscrowBurn | ReturnEscrow | WithdrawShares | TopUpTons

fun BankInit.loadBankState(self): BankState {
    if (self.state == null) {
        return {
            depositorStock: 0, totalShares: 0, unassignedShares: 0,
            escrow: 0, dayStart: 0, dayCap: 0, dayBurned: 0,
        };
    }
    return BankState.fromCell(self.state!);
}

fun BankInit.saveBankState(mutate self, state: BankState) {
    self.state = state.toCell();
    contract.setData(self.toCell());
}

fun BankInit.myWallet(self): address {
    return calcAddressOfJettonWallet(contract.getAddress(), self.minter, self.walletCode);
}

fun BankInit.isOpen(self): bool {
    return blockchain.now() >= self.t0 + BANK_CLOSED_PERIOD;
}



fun emptyPayload(): slice {
    return beginCell().storeBool(false).endCell().beginParse();
}

// Envoie des ConsoM depuis le wallet de la banque. Le reste du solde (hors réserve) accompagne le transfert ;
// l'excédent revient à `to`.
fun sendJettons(wallet: address, queryId: uint64, amount: coins, to: address, sendMode: int, value: coins) {
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: wallet,
        value,
        body: AskToTransfer {
            queryId,
            jettonAmount: amount,
            transferRecipient: to,
            sendExcessesTo: to,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        }
    }).send(sendMode);
}

fun sendBurn(wallet: address, queryId: uint64, amount: coins, excessesTo: address, sendMode: int, value: coins) {
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: wallet,
        value,
        body: AskToBurn {
            queryId,
            jettonAmount: amount,
            sendExcessesTo: excessesTo,
            customPayload: null,
        }
    }).send(sendMode);
}

// Lit l'opcode de la charge utile (TL-B « Either Cell ^Cell ») et la renvoie positionnée après l'opcode.
fun readTag(payload: slice): (int, slice) {
    var p = payload;
    if (p.remainingBitsCount() == 0) {
        return (0, p);
    }
    if (p.loadBool()) {
        if (p.remainingRefsCount() == 0) {
            return (0, p);
        }
        p = p.loadRef().beginParse();
    }
    if (p.remainingBitsCount() < 32) {
        return (0, p);
    }
    val op = p.loadUint(32);
    return (op, p);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy BankMessage.fromSlice(in.body);
    var storage = BankInit.fromCell(contract.getData());
    var state = storage.loadBankState();

    match (msg) {

        // ---------- ConsoM reçus dans le wallet de la banque ----------
        TransferNotificationForRecipient => {
            assert (in.senderAddress == storage.myWallet()) throw ERR_NOT_MY_WALLET;
            val amount = msg.jettonAmount;
            val (tag, rest) = readTag(msg.forwardPayload);

            if (msg.transferInitiator == null) {
                // création par l'émetteur (seul l'émetteur peut créer des jetons)
                // seule la genèse existe : 70 % de l'allocation des Anciens Contributeurs, en parts à attribuer
                assert (tag == OP_FOUNDERS_TAG) throw ERR_UNKNOWN_DEPOSIT;
                state.depositorStock += amount;
                state.totalShares += amount;
                state.unassignedShares += amount;
                storage.saveBankState(state);
                return;
            }

            val from = msg.transferInitiator!;

            if ((tag == OP_OWN_CONV_TAG) && (in.valueCoins >= OWN_CONVERSION_MIN_VALUE)) {
                // conversion avec ses propres ConsoM : jetons gardés en attente, bon vérifié par l'émetteur
                var p = rest;
                val voucher = p.loadRef();
                val sigA = p.loadRef();
                val sigB = p.loadRef();
                state.escrow += amount;
                storage.saveBankState(state);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.minter,
                    value: 0,
                    body: VerifyOwnConversion {
                        queryId: msg.queryId,
                        received: amount,
                        from,
                        voucher: voucher as Cell<Voucher>,
                        sigA: sigA as Cell<WitnessSignature>,
                        sigB: sigB as Cell<WitnessSignature>,
                    }
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }

            if ((tag == OP_DEPOSIT_TAG) && (in.valueCoins >= BANK_OP_MIN_VALUE)) {
                if (!storage.isOpen()) {
                    // banque fermée aux dépôts pendant 12 mois : les jetons sont rendus
                    keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
                    sendJettons(storage.myWallet(), msg.queryId, amount, from, SEND_MODE_CARRY_ALL_BALANCE, 0);
                    return;
                }
                val shares = ((state.totalShares == 0) || (state.depositorStock == 0))
                    ? amount as int
                    : mulDivFloor(amount, state.totalShares, state.depositorStock);
                state.depositorStock += amount;
                state.totalShares += shares;
                storage.saveBankState(state);
                keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: calcDeployedShare(storage.shareCode, from),
                    value: 0,
                    body: AddShares { queryId: msg.queryId, shares: shares as coins, at: blockchain.now() }
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
                return;
            }

            // envoi sans objet reconnu, ou sans assez de TON pour être traité : refusé, les jetons retournent à
            // l'expéditeur (rien n'entre dans le stock de la banque)
            keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
            sendJettons(storage.myWallet(), msg.queryId, amount, from, SEND_MODE_CARRY_ALL_BALANCE, 0);
        }

        // ---------- Conversion via la banque (ordre de l'émetteur, après un bon signé) ----------
        BankBurn => {
            assert (in.senderAddress == storage.minter) throw ERR_NOT_MINTER;
            val now = blockchain.now();
            val stock = state.depositorStock;
            if (now >= state.dayStart + ONE_DAY) {
                state.dayStart = now;
                state.dayBurned = 0;
                state.dayCap = mulDivFloor(stock, BANK_DAILY_BURN_BP, BP_DENOMINATOR) as coins;
            }
            if ((msg.burn == 0) || (msg.burn > stock) || (state.dayBurned + msg.burn > state.dayCap)) {
                // stock insuffisant ou plafond de 5 % atteint : rien n'est brûlé, les TON sont rendus
                keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.refundTo,
                    value: 0,
                    body: ReturnExcessesBack { queryId: msg.queryId }
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
                return;
            }
            // prélèvement sur le stock des déposants ; les parts ne changent pas
            state.depositorStock -= msg.burn;
            state.dayBurned += msg.burn;
            storage.saveBankState(state);
            keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
            sendBurn(storage.myWallet(), msg.queryId, msg.burn, msg.refundTo, SEND_MODE_CARRY_ALL_BALANCE, 0);
        }

        // ---------- Conversion avec ses propres ConsoM : bon accepté ----------
        EscrowBurn => {
            assert (in.senderAddress == storage.minter) throw ERR_NOT_MINTER;
            state.escrow -= (msg.burn + msg.refund);
            storage.saveBankState(state);
            keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
            val wallet = storage.myWallet();
            if (msg.refund == 0) {
                sendBurn(wallet, msg.queryId, msg.burn, msg.to, SEND_MODE_CARRY_ALL_BALANCE, 0);
                return;
            }
            sendBurn(wallet, msg.queryId, msg.burn, msg.to, SEND_MODE_PAY_FEES_SEPARATELY, BANK_JETTON_FWD_VALUE);
            sendJettons(wallet, msg.queryId, msg.refund, msg.to, SEND_MODE_CARRY_ALL_BALANCE, 0);
        }

        // ---------- Conversion avec ses propres ConsoM : bon refusé ----------
        ReturnEscrow => {
            assert (in.senderAddress == storage.minter) throw ERR_NOT_MINTER;
            state.escrow -= msg.amount;
            storage.saveBankState(state);
            keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
            sendJettons(storage.myWallet(), msg.queryId, msg.amount, msg.to, SEND_MODE_CARRY_ALL_BALANCE, 0);
        }

        // ---------- Retrait d'un déposant (demandé à ses parts) ----------
        WithdrawShares => {
            assert (in.senderAddress == calcDeployedShare(storage.shareCode, msg.owner).calculateAddress()) throw ERR_NOT_SHARE;
            // fermée pendant 12 mois : le message rebondit et les parts sont rétablies
            assert (storage.isOpen()) throw ERR_BANK_CLOSED;
            val amount = mulDivFloor(msg.shares, state.depositorStock, state.totalShares);
            assert (amount > 0) throw ERR_NOTHING_TO_REDEEM;
            state.depositorStock -= amount;
            state.totalShares -= msg.shares;
            storage.saveBankState(state);
            keepReserve(in.valueCoins, BANK_STORAGE_RESERVE);
            sendJettons(storage.myWallet(), msg.queryId, amount as coins, msg.owner, SEND_MODE_CARRY_ALL_BALANCE, 0);
        }

        TopUpTons => {
            // accepte des TON (frais de stockage de la banque)
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

// ---------- Lecture ----------

struct BankStateReply {
    depositorStock: int
    totalShares: int
    unassignedShares: int
    escrow: int
    dayCap: int
    dayBurned: int
    isOpen: bool
}

get fun get_bank_state(): BankStateReply {
    val storage = BankInit.fromCell(contract.getData());
    val state = storage.loadBankState();
    return {
        depositorStock: state.depositorStock,
        totalShares: state.totalShares,
        unassignedShares: state.unassignedShares,
        escrow: state.escrow,
        dayCap: state.dayCap,
        dayBurned: state.dayBurned,
        isOpen: storage.isOpen(),
    }
}

get fun get_share_address(owner: address): address {
    val storage = BankInit.fromCell(contract.getData());
    return calcDeployedShare(storage.shareCode, owner).calculateAddress();
}

// Valeur actuelle de `shares` parts, en unités de base
get fun get_shares_value(shares: int): int {
    val storage = BankInit.fromCell(contract.getData());
    val state = storage.loadBankState();
    if (state.totalShares == 0) {
        return 0;
    }
    return mulDivFloor(shares, state.depositorStock, state.totalShares);
}
