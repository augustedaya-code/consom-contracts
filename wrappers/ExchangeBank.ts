// Interface TypeScript de la banque d'échange : déploiement et lecture.
import { Address, beginCell, Cell, contractAddress, SendMode } from '@ton/core';
import type { Contract, ContractProvider, Sender } from '@ton/core';
import { bankInitData } from './ConsoMMinter.ts';

export class ExchangeBank implements Contract {
    readonly address: Address;
    readonly init?: { code: Cell; data: Cell };

    constructor(address: Address, init?: { code: Cell; data: Cell }) {
        this.address = address;
        this.init = init;
    }

    // Les données initiales doivent être exactement celles que l'émetteur utilise pour calculer l'adresse de la banque
    static createForMinter(minter: Address, t0: number, walletCode: Cell, shareCode: Cell, bankCode: Cell, workchain = 0) {
        const init = { code: bankCode, data: bankInitData(minter, t0, walletCode, shareCode) };
        return new ExchangeBank(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async getState(provider: ContractProvider) {
        const s = (await provider.get('get_bank_state', [])).stack;
        return {
            depositorStock: s.readBigNumber(), ownerlessStock: s.readBigNumber(), totalShares: s.readBigNumber(),
            unassignedShares: s.readBigNumber(), escrow: s.readBigNumber(), dayCap: s.readBigNumber(),
            dayBurned: s.readBigNumber(), isOpen: s.readBoolean(),
        };
    }
}
