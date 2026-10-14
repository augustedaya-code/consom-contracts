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

fun calcDeployedBank(bankCode: cell, shareCode: cell, walletCode: cell): AutoDeployAddress {
    val init: BankInit = {
        minter: contract.getAddress(),
        walletCode,
        shareCode,
        state: null,
    };
    return {
        stateInit: {
            code: bankCode,
            data: init.toCell()
        }
    }
}

fun calcBankAddress(bankCode: cell, shareCode: cell, walletCode: cell, t0: int): address {
    val init: BankInit = {
        minter: contract.getAddress(),
        t0,
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

// Les contrats enfants gardent une petite réserve pour leurs frais de stockage,
// puis renvoient tout le reste de leur solde avec le message suivant (SEND_MODE_CARRY_ALL_BALANCE).
fun keepChildReserve() {
    reserveToncoinsOnBalance(CHILD_STORAGE_RESERVE, RESERVE_MODE_AT_MOST);
}
