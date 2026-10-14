// Adresses des contrats liés à l'émetteur, calculées à partir de leur code et de leurs données initiales.
// Les contrats enfants (budget de paiement, compte membre) et la banque d'échange DOIVENT être déployés
// avec exactement ces données initiales ; c'est ce qui permet à l'émetteur de reconnaître leurs messages.

import "../jetton/jetton-utils"

// Données initiales d'un budget de paiement (clé = waveRef) ou d'un compte membre (clé = memberId).
// `state` est vide au déploiement ; le contrat enfant le remplit à son premier message.
struct ChildInit {
    minter: address
    key: uint256
    state: cell?
}

// Données initiales de la banque d'échange
struct BankInit {
    minter: address
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

fun calcBankAddress(bankCode: cell): address {
    val init: BankInit = {
        minter: contract.getAddress(),
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

fun calcWalletAddress(owner: address, walletCode: cell): address {
    return calcAddressOfJettonWallet(owner, contract.getAddress(), walletCode)
}
