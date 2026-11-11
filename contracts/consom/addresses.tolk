// Adresses des contrats liés à l'émetteur, calculées à partir de leur code et de leurs données initiales.
// Les contrats enfants (budget de paiement, compte membre) et la banque d'échange DOIVENT être déployés
// avec exactement ces données initiales ; c'est ce qui permet à l'émetteur de reconnaître leurs messages.

import "../jetton/jetton-utils"
import "constants"

// Données initiales d'un budget de paiement (clé = waveRef) ou d'un compte membre (clé = memberId).
// `state` est vide au déploiement ; le contrat enfant le remplit à son premier message.
struct ChildInit {
    minter: address
    key: uint256
    state: cell?
}

// Données initiales de la banque d'échange (tout ce qu'elle doit connaître est fixé à sa création)
struct BankInit {
    minter: address
    t0: uint32
    depositWindow: uint32    // lot E14 : durée (secondes) après T0 pendant laquelle les dépôts sont acceptés ; fixée par
                             // l'émetteur selon le réseau gravé (bankDepositWindow), elle fait partie de l'adresse de la banque
    walletCode: cell         // pour calculer l'adresse de son propre wallet ConsoM
    shareCode: cell          // code des contrats « parts d'un déposant »
    state: cell?
}

// Données initiales des parts d'un déposant
struct ShareInit {
    bank: address
    owner: address
    state: cell?
}

fun calcDeployedChild(code: cell, key: uint256): AutoDeployAddress {
    val init: ChildInit = {
        minter: contract.getAddress(),
        key,
        state: null,
    };
    return {
        stateInit: {
            code,
            data: init.toCell()
        }
    }
}

fun calcChildAddress(code: cell, key: uint256): address {
    return calcDeployedChild(code, key).calculateAddress()
}

// Lot E14 (décision du 11 novembre 2026) : fenêtre de dépôt de la banque, déduite du réseau gravé (jamais un paramètre libre).
//   - réseau principal : 30 jours après le lancement (T0), puis fermée jusqu'à T0 + 12 mois ;
//   - réseau d'essai (phase de test) : 12 mois, c'est-à-dire ouverte aux dépôts dès T0 et sans interruption.
// Dans les deux cas, aucun retrait avant T0 + 12 mois.
fun bankDepositWindow(networkId: int): int {
    return (networkId == NETWORK_MAINNET) ? BANK_MAINNET_DEPOSIT_WINDOW : BANK_CLOSED_PERIOD;
}

fun calcBankAddress(bankCode: cell, shareCode: cell, walletCode: cell, t0: int, networkId: int): address {
    val init: BankInit = {
        minter: contract.getAddress(),
        t0,
        depositWindow: bankDepositWindow(networkId),
        walletCode,
        shareCode,
        state: null,
    };
    val deployed: AutoDeployAddress = {
        stateInit: {
            code: bankCode,
            data: init.toCell()
        }
    };
    return deployed.calculateAddress()
}

// Appelé par la banque : adresse des parts d'un déposant
fun calcDeployedShare(shareCode: cell, owner: address): AutoDeployAddress {
    val init: ShareInit = {
        bank: contract.getAddress(),
        owner,
        state: null,
    };
    return {
        stateInit: {
            code: shareCode,
            data: init.toCell()
        }
    }
}

fun calcWalletAddress(owner: address, walletCode: cell): address {
    return calcAddressOfJettonWallet(owner, contract.getAddress(), walletCode)
}

// Avant de renvoyer « tout le solde » (SEND_MODE_CARRY_ALL_BALANCE), un contrat garde ce qu'il avait avant ce
// message, et au moins `minimum` pour ses frais de stockage : il ne renvoie que ce qu'il vient de recevoir.
fun keepReserve(inValue: coins, minimum: coins) {
    val before = contract.getOriginalBalance() - inValue;
    reserveToncoinsOnBalance(max(before, minimum), RESERVE_MODE_AT_MOST);
}
