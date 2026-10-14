// Outils communs aux tests : déploiement d'un émetteur avec contrats de remplacement, bons signés,
// recherche de transactions et lecture des soldes.
import { Address, beginCell, Cell, toNano } from '@ton/core';
import type { Transaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import type { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { keyPairFromSeed } from '@ton/crypto';
import type { KeyPair } from '@ton/crypto';
import { compileTolk } from '../scripts/compile.ts';
import {
    ConsoMMinter, NETWORK_TESTNET, Kind, voucherToCell, signVoucher, claimBody, consom,
} from '../wrappers/ConsoMMinter.ts';
import type { MinterConfig, VoucherData } from '../wrappers/ConsoMMinter.ts';

export const T0 = 1_800_000_000;   // ouverture fictive du réseau pour les tests
export const DAY = 86_400;

export type Env = Awaited<ReturnType<typeof setup>>;

export async function setup(overrides: Partial<MinterConfig> = {}) {
    const blockchain = await Blockchain.create();
    blockchain.now = T0;

    const [minterCode, walletCode, budgetCode, memberCode, bankCode] = await Promise.all([
        compileTolk('contracts/consom/minter.tolk'),
        compileTolk('contracts/jetton/JettonWallet.tolk'),
        compileTolk('contracts/consom/budget.tolk'),
        compileTolk('contracts/consom/member.tolk'),
        compileTolk('tests/stubs/bank_stub.tolk'),
    ]);

    const witnesses: KeyPair[] = [1, 2, 3].map((i) => keyPairFromSeed(Buffer.alloc(32, i)));
    const deployer = await blockchain.treasury('deployer');
    const guardian = await blockchain.treasury('guardian');
    const member = await blockchain.treasury('member');
    const stranger = await blockchain.treasury('stranger');

    const config: MinterConfig = {
        t0: T0,
        networkId: NETWORK_TESTNET,
        witnessKeys: [witnesses[0].publicKey, witnesses[1].publicKey, witnesses[2].publicKey],
        guardian: guardian.address,
        walletCode,
        budgetCode,
        memberCode,
        bankCode,
        content: beginCell().storeUint(0x01, 8).storeStringTail('https://tonmarche.example/consom.json').endCell(),
        ...overrides,
    };
    const minter = blockchain.openContract(ConsoMMinter.createFromConfig(config, minterCode));
    const deploy = await minter.sendDeploy(deployer.getSender(), toNano('1'));

    // banque de test, déployée avec les données initiales que l'émetteur attend (BankInit)
    const bankInit = { code: bankCode, data: beginCell().storeAddress(minter.address).storeMaybeRef(null).endCell() };
    const bankAddress = await minter.getBankAddress();
    await deployer.send({ to: bankAddress, value: toNano('0.5'), init: bankInit, body: beginCell().storeUint(0x7362d09c, 32).storeUint(0, 64).storeCoins(0).storeAddress(null).storeBit(false).endCell() });
    const bankDeployed = await blockchain.getContract(bankAddress);
    if (bankDeployed.accountState?.type !== 'active') {
        throw new Error('la banque de test n\'a pas été déployée à l\'adresse calculée par l\'émetteur');
    }

    let nextVoucherId = 1n;
    let nextWave = 1n;

    // Un bon valide par défaut : pack Essentiel de prévente, pour `member`
    const voucher = (o: Partial<VoucherData> = {}): VoucherData => ({
        networkId: config.networkId,
        minter: minter.address,
        voucherId: nextVoucherId++,
        kind: Kind.PRESALE,
        level: 0,
        validUntil: (blockchain.now ?? T0) + 3600,
        recipient: member.address,
        amount: consom(3000),
        waveRef: 0xabc000n + nextWave++,
        waveAmount: 3500n,
        points: 0n,
        memberId: 1n,
        ...o,
    });

    // Envoie un bon signé par les témoins `signers` (index), avec éventuellement des clés de signature forcées
    const claim = async (v: VoucherData, opts: {
        signers?: [number, number];
        keys?: [Buffer, Buffer];
        from?: SandboxContract<TreasuryContract>;
        value?: bigint;
    } = {}) => {
        const signers = opts.signers ?? [0, 1];
        const keys = opts.keys ?? [witnesses[signers[0]].secretKey, witnesses[signers[1]].secretKey];
        const cell = voucherToCell(v);
        const body = claimBody(0n, cell, signVoucher(cell, signers[0], keys[0]), signVoucher(cell, signers[1], keys[1]));
        const from = opts.from ?? member;
        return minter.sendClaim(from.getSender(), opts.value ?? toNano('0.5'), body);
    };

    const balanceOf = async (owner: Address): Promise<bigint> => {
        const walletAddress = await minter.getWalletAddress(owner);
        const contract = await blockchain.getContract(walletAddress);
        if (contract.accountState?.type !== 'active') return 0n;
        return (await contract.get('get_wallet_data')).stackReader.readBigNumber();
    };

    // État d'un compte membre ou d'un budget de paiement (null s'il n'est pas encore déployé)
    const memberState = async (memberId: bigint) => {
        const c = await blockchain.getContract(await minter.getChildAddress(false, memberId));
        if (c.accountState?.type !== 'active') return null;
        const s = (await c.get('get_member_state')).stackReader;
        return {
            initialized: s.readBoolean(), owner: s.readAddressOpt(), referralEligible: s.readBoolean(),
            hasPayment: s.readBoolean(), flags: s.readNumber(), lastDirectVoucherId: s.readBigNumber(),
            rewardablePoints: s.readBigNumber(), convertedPoints: s.readBigNumber(), investmentBonus: s.readBigNumber(),
            dayReceived: s.readBigNumber(), vestingLocked: s.readBigNumber(), vestingDue: s.readBigNumber(),
        };
    };
    const budgetState = async (waveRef: bigint) => {
        const c = await blockchain.getContract(await minter.getChildAddress(true, waveRef));
        if (c.accountState?.type !== 'active') return null;
        const s = (await c.get('get_budget_state')).stackReader;
        return { initialized: s.readBoolean(), waveAmount: s.readBigNumber(), points: s.readBigNumber(), slots: s.readNumber() };
    };
    // Réclamer les tranches de vesting échues depuis l'adresse liée
    const claimVesting = async (memberId: bigint, from = member) => from.send({
        to: await minter.getChildAddress(false, memberId), value: toNano('0.3'),
        body: beginCell().storeUint(0xc0150008, 32).storeUint(0, 64).endCell(),
    });

    return { blockchain, minter, deploy, memberState, budgetState, claimVesting, config, witnesses, deployer, guardian, member, stranger, voucher, claim, balanceOf, codes: { minterCode, walletCode, budgetCode, memberCode, bankCode } };
}

// ---------- Transactions ----------

// Raison du refus (REJECT_*) portée par le message ClaimRejected reçu par l'émetteur, ou null
export function rejectReason(r: { transactions: Transaction[] }): number | null {
    for (const tx of r.transactions) {
        const body = tx.inMessage?.body.beginParse();
        if (!body || body.remainingBits < 32 || body.loadUint(32) !== 0xc0150004) continue;
        body.loadUint(64); body.loadUint(8); body.loadCoins(); body.loadBit(); body.loadUintBig(256); body.loadAddress();
        return body.loadUint(16);
    }
    return null;
}

type TxFilter = { from?: Address; to?: Address; op?: number; success?: boolean; exitCode?: number };

function matches(tx: Transaction, f: TxFilter): boolean {
    const info = tx.inMessage?.info;
    if (!info || info.type !== 'internal') return false;
    if (f.from && !info.src.equals(f.from)) return false;
    if (f.to && !info.dest.equals(f.to)) return false;
    if (f.op !== undefined) {
        const s = tx.inMessage!.body.beginParse();
        if (s.remainingBits < 32 || s.loadUint(32) !== f.op) return false;
    }
    const d = tx.description;
    if (d.type !== 'generic') return false;
    const compute = d.computePhase;
    const exitCode = compute.type === 'vm' ? compute.exitCode : undefined;
    const success = compute.type === 'vm' && compute.success && !d.aborted;
    if (f.success !== undefined && success !== f.success) return false;
    if (f.exitCode !== undefined && exitCode !== f.exitCode) return false;
    return true;
}

export function findTx(txs: Transaction[], f: TxFilter): Transaction | undefined {
    return txs.find((tx) => matches(tx, f));
}

export function hasTx(r: { transactions: Transaction[] }, f: TxFilter): boolean {
    return findTx(r.transactions, f) !== undefined;
}

// Liste lisible des transactions (pour comprendre un test qui échoue)
export function describeTxs(r: { transactions: Transaction[] }): string {
    return r.transactions.map((tx) => {
        const info = tx.inMessage?.info;
        const d = tx.description;
        const code = d.type === 'generic' && d.computePhase.type === 'vm' ? d.computePhase.exitCode : '-';
        const body = tx.inMessage?.body.beginParse();
        const op = body && body.remainingBits >= 32 ? '0x' + body.loadUint(32).toString(16) : '(vide)';
        const dest = info && info.type !== 'external-out' ? info.dest.toString() : '?';
        return `${dest.slice(0, 10)}… op=${op} code=${code} aborted=${d.type === 'generic' ? d.aborted : '?'}`;
    }).join('\n');
}

export { consom, Kind, toNano, Cell };
