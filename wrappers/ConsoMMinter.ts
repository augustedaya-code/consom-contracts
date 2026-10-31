// Interface TypeScript de l'émetteur ConsoM : construction du stockage initial, des bons et des messages,
// lecture des get-methods. La sérialisation suit exactement les structures de contracts/consom/*.tolk.
import { Address, beginCell, Cell, contractAddress, SendMode } from '@ton/core';
import type { Builder, Contract, ContractProvider, Sender } from '@ton/core';
import { sign } from '@ton/crypto';

export const ONE_CONSOM = 1_000_000_000n;
export const consom = (n: number | bigint) => BigInt(n) * ONE_CONSOM;

export const NETWORK_MAINNET = -239;
export const NETWORK_TESTNET = -3;

export const Kind = {
    PRESALE: 0,
    PURCHASE_RECORD: 1,
    REFERRAL: 2,
    FIRST_PURCHASE: 3,
    CONVERSION: 4,
    MISSION_TG: 5,
    MISSION_FB: 6,
    INVESTMENT: 7,
    BANK_CONVERSION: 8,
    OWN_CONVERSION: 9,
    CHIKA_BONUS: 10,
    FOUNDER_CLAIM: 11,
    EARLY_CONTRIBUTION: 12,
} as const;

export const Category = { PRESALE: 0, PURCHASE: 1, REFERRAL: 2, MISSIONS: 3, FOUNDERS: 4, TEAM: 5, CHIKA: 6, FOUNDATION: 7, EARLY: 8 } as const;

export const Op = {
    ClaimVoucher: 0xc0150001,
    CheckClaim: 0xc0150002,
    MintApproved: 0xc0150003,
    ClaimRejected: 0xc0150004,
    GuardianPause: 0xc0150010,
    GuardianUnpause: 0xc0150011,
    ProposeWitness: 0xc0150012,
    CancelWitness: 0xc0150013,
    ExecuteWitness: 0xc0150014,
    GenesisFoundersDeposit: 0xc0150020,
    ReleaseTeamShare: 0xc0150050,
    ConversionResult: 0xc0150060,
    AssignFounderShares: 0xc0150047,
    VerifyOwnConversion: 0xc0150043,
    BankBurn: 0xc0150040,
    EscrowBurn: 0xc0150041,
    ReturnEscrow: 0xc0150042,
    WithdrawRequest: 0xc0150045,
    WithdrawShares: 0xc0150046,
    DepositTag: 0xc0150032,
    OwnConversionTag: 0xc0150033,
    JettonTransfer: 0x0f8a7ea5,
    Burn: 0x595f07bc,
    InternalTransfer: 0x178d4519,
} as const;

export const Err = {
    PAUSED: 400, WRONG_NETWORK: 401, WRONG_MINTER: 402, EXPIRED: 403, VALIDITY_TOO_LONG: 404,
    BAD_SIGNATURE: 405, SAME_WITNESS: 406, BAD_WITNESS_INDEX: 407, NOT_RECIPIENT: 408, UNKNOWN_KIND: 409,
    WINDOW_CLOSED: 410, WRONG_AMOUNT: 411, CATEGORY_CAP: 412, DAILY_CAP: 413, SUPPLY_CAP: 414,
    POINTS_TOO_HIGH: 415, NOT_ENOUGH_TON: 416, BURN_NOT_ALLOWED: 417, NOT_GUARDIAN: 420, PAUSE_TOO_SOON: 421,
    REPLACE_TOO_SOON: 422, REPLACE_PENDING: 423, NO_PENDING: 424, TIMELOCK: 425, DUPLICATE_KEY: 426, ZERO_KEY: 427,
    NOT_CHILD: 430, NOT_WALLET: 431, GENESIS_DONE: 440, GENESIS_NOT_DONE: 441, NOTHING_TO_RELEASE: 442, NO_FOUNDER_SHARES: 443, EARLY_TOTAL: 444,
    // contrôles au déploiement (un contrat gravé avec des données interdites refuse tout message)
    DEPLOY_SAME_KEYS: 480, DEPLOY_NO_GUARDIAN: 481, DEPLOY_NO_TEAM: 482, DEPLOY_GUARDIAN_SYSTEM: 483,
    DEPLOY_TEAM_SYSTEM: 484, DEPLOY_TEAM_FORBIDDEN: 485, DEPLOY_FORBIDDEN_LIST: 486,
} as const;

// Raisons de refus lisibles par le serveur (ClaimRejected.reason) ajoutées par le lot E4 ; les autres sont dans la spécification
export const Reject = { FORBIDDEN_RECIPIENT: 17 } as const;

export const MAX_FORBIDDEN_RECIPIENTS = 8;

// Plafonds initiaux (section 3)
export const INITIAL_CAPS = {
    presale: consom(100_000_000),
    purchase: consom(55_000_000),
    referral: consom(45_000_000),
    missions: consom(19_900_000),
    founders: consom(5_000_000),
    team: consom(5_000_000),
    chika: consom(20_000_000),
    foundation: consom(100_000),
};

export type MinterConfig = {
    t0: number;
    networkId: number;
    witnessKeys: [Buffer, Buffer, Buffer];   // clés publiques Ed25519 (32 octets)
    guardian: Address;
    teamAddress: Address;                    // reçoit la part de l'équipe : gravée au déploiement, jamais modifiable
    walletCode: Cell;
    budgetCode: Cell;
    memberCode: Cell;
    bankCode: Cell;
    shareCode: Cell;
    content: Cell;
    // A16 : adresses interdites de réception (0 à 8) — wallet relais du serveur, autres wallets du serveur ou de l'équipe
    // technique. Gravées au déploiement, jamais modifiables. L'adresse de l'équipe ne peut pas y figurer.
    forbiddenRecipients: Address[];
    // Total (unités de base) des contributions du lancement anticipé à réclamer : gravé au déploiement, retenu dans la réserve
    // de prévente (la règle des invendus de T0 + 18 mois n'y touche pas). 0 = aucune contribution. Au plus 100 000 000 ConsoM.
    earlyContributionsTotal?: bigint;
    // TESTS UNIQUEMENT : état de départ différent (plafonds, offre, brûlages) pour tester les limites
    testCaps?: Partial<typeof INITIAL_CAPS>;
    testState?: { totalSupply?: bigint; burnedByConversion?: bigint };
};

const bigFromKey = (key: Buffer) => BigInt('0x' + key.toString('hex'));

// Liste interdite : chaîne de cellules de 3 adresses au plus (ForbiddenChunk dans storage.tolk), null si la liste est vide
export function forbiddenListToCell(list: Address[]): Cell | null {
    let next: Cell | null = null;
    const starts: number[] = [];
    for (let i = 0; i < list.length; i += 3) starts.push(i);
    for (const i of starts.reverse()) {
        const b = beginCell().storeAddress(list[i]).storeAddress(list[i + 1] ?? null).storeAddress(list[i + 2] ?? null).storeMaybeRef(next);
        next = b.endCell();
    }
    return next;
}

const isZeroAddress = (a: Address) => a.hash.every((byte) => byte === 0);

// Contrôles au déploiement (A3, A16), en français, AVANT d'envoyer quoi que ce soit : une erreur ici arrête le déploiement.
// Le contrat refait les mêmes contrôles à chaque message (un contrat gravé de travers refuse tout), mais mieux vaut ne jamais le déployer.
export function assertValidMinterConfig(c: MinterConfig, minter: Address, bank: Address): void {
    const fail = (why: string): never => { throw new Error(`Déploiement refusé : ${why}`); };
    if (c.witnessKeys.length !== 3) fail('il faut exactement 3 clés de témoins.');
    c.witnessKeys.forEach((k, i) => {
        if (k.length !== 32) fail(`la clé du témoin ${i + 1} doit faire 32 octets.`);
        if (k.every((byte) => byte === 0)) fail(`la clé du témoin ${i + 1} est vide (zéro).`);
    });
    const hex = c.witnessKeys.map((k) => k.toString('hex'));
    if (new Set(hex).size !== 3) fail('deux des 3 clés de témoins sont identiques : il faut 3 clés distinctes.');
    if (!c.guardian || isZeroAddress(c.guardian)) fail('l\'adresse du gardien est vide.');
    if (!c.teamAddress || isZeroAddress(c.teamAddress)) fail('l\'adresse de l\'équipe est vide.');
    if (c.guardian.equals(minter) || c.guardian.equals(bank)) fail('le gardien ne peut pas être l\'émetteur ni la banque.');
    if (c.teamAddress.equals(minter) || c.teamAddress.equals(bank)) fail('l\'adresse de l\'équipe ne peut pas être l\'émetteur ni la banque.');
    if (c.forbiddenRecipients.length > MAX_FORBIDDEN_RECIPIENTS) {
        fail(`la liste des adresses interdites de réception compte ${c.forbiddenRecipients.length} adresses, 8 au plus.`);
    }
    for (const a of c.forbiddenRecipients) {
        if (!a || isZeroAddress(a)) fail('la liste des adresses interdites de réception contient une adresse vide.');
        if (a.equals(c.teamAddress)) {
            fail('l\'adresse de l\'équipe figure dans la liste des adresses interdites de réception : la part de l\'équipe ne pourrait jamais lui être versée.');
        }
    }
}

export function minterConfigToCell(c: MinterConfig): Cell {
    const k = { ...INITIAL_CAPS, ...(c.testCaps ?? {}) };
    const st = c.testState ?? {};
    const caps = beginCell()
        .storeCoins(k.presale)
        .storeCoins(k.purchase)
        .storeCoins(k.referral)
        .storeCoins(k.missions)
        .storeCoins(k.founders)
        .storeCoins(k.team)
        .storeCoins(k.chika)
        .storeCoins(k.foundation)
        .storeBit(false)        // presaleSettled
        .storeUint(0, 32)       // dayStart
        .storeCoins(0)          // dayMinted
        .storeCoins(0)          // founderShares (rempli par la genèse)
        .storeCoins(c.earlyContributionsTotal ?? 0n)   // earlyHold
        .endCell();
    const witnesses = beginCell()
        .storeUint(bigFromKey(c.witnessKeys[0]), 256)
        .storeUint(bigFromKey(c.witnessKeys[1]), 256)
        .storeUint(bigFromKey(c.witnessKeys[2]), 256)
        .storeMaybeRef(null)    // pending
        .storeUint(0, 32)       // lastReplaceAt
        .endCell();
    const config = beginCell()
        .storeAddress(c.guardian)
        .storeAddress(c.teamAddress)
        .storeRef(c.walletCode)
        .storeRef(c.budgetCode)
        .storeRef(c.memberCode)
        .storeMaybeRef(forbiddenListToCell(c.forbiddenRecipients))
        .endCell();
    const extra = beginCell()
        .storeRef(c.content)
        .storeRef(beginCell().storeRef(c.bankCode).storeRef(c.shareCode).endCell())
        .endCell();
    return beginCell()
        .storeCoins(st.totalSupply ?? 0n)
        .storeCoins(st.burnedByConversion ?? 0n)
        .storeUint(c.t0, 32)
        .storeInt(c.networkId, 32)
        .storeUint(0, 32)       // pausedUntil
        .storeUint(0, 32)       // lastPauseStart
        .storeBit(false)        // genesisDone
        .storeRef(caps)
        .storeRef(witnesses)
        .storeRef(config)
        .storeRef(extra)
        .endCell();
}

// ---------- Bons ----------

export type VoucherData = {
    networkId: number;
    minter: Address;
    voucherId: bigint;
    kind: number;
    level: number;
    validUntil: number;
    recipient: Address;
    amount: bigint;
    waveRef: bigint;
    waveAmount: bigint;
    points: bigint;
    memberId: bigint;
};

export function voucherToCell(v: VoucherData): Cell {
    const payment = beginCell()
        .storeUint(v.waveRef, 256)
        .storeCoins(v.waveAmount)
        .storeCoins(v.points)
        .storeUint(v.memberId, 256)
        .endCell();
    return beginCell()
        .storeInt(v.networkId, 32)
        .storeAddress(v.minter)
        .storeUint(v.voucherId, 64)
        .storeUint(v.kind, 8)
        .storeUint(v.level, 8)
        .storeUint(v.validUntil, 32)
        .storeAddress(v.recipient)
        .storeCoins(v.amount)
        .storeRef(payment)
        .endCell();
}

// Signature d'un témoin : Ed25519 sur l'empreinte de la cellule du bon
export function signVoucher(voucher: Cell, index: number, secretKey: Buffer): Cell {
    const signature = sign(voucher.hash(), secretKey);
    return beginCell().storeUint(index, 8).storeBuffer(signature).endCell();
}

export function claimBody(queryId: bigint, voucher: Cell, sigA: Cell, sigB: Cell): Cell {
    return beginCell()
        .storeUint(Op.ClaimVoucher, 32)
        .storeUint(queryId, 64)
        .storeRef(voucher)
        .storeRef(sigA)
        .storeRef(sigB)
        .endCell();
}

const simpleOp = (op: number, queryId = 0n, extra?: (b: Builder) => Builder) => {
    const b = beginCell().storeUint(op, 32).storeUint(queryId, 64);
    return (extra ? extra(b) : b).endCell();
};

// ---------- Contrat ----------

export class ConsoMMinter implements Contract {
    readonly address: Address;
    readonly init?: { code: Cell; data: Cell };

    constructor(address: Address, init?: { code: Cell; data: Cell }) {
        this.address = address;
        this.init = init;
    }

    static createFromConfig(config: MinterConfig, code: Cell, workchain = 0) {
        const data = minterConfigToCell(config);
        const init = { code, data };
        const address = contractAddress(workchain, init);
        const bank = contractAddress(workchain, { code: config.bankCode, data: bankInitData(address, config.t0, config.walletCode, config.shareCode) });
        assertValidMinterConfig(config, address, bank);
        return new ConsoMMinter(address, init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendClaim(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendRaw(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendGenesis(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendRaw(provider, via, value, simpleOp(Op.GenesisFoundersDeposit));
    }

    // N'importe qui peut libérer la part de l'équipe (il ne paie que les frais) : elle va à l'adresse gravée
    async sendReleaseTeam(provider: ContractProvider, via: Sender, value = 200_000_000n) {
        await this.sendRaw(provider, via, value, simpleOp(Op.ReleaseTeamShare));
    }

    async sendPause(provider: ContractProvider, via: Sender) {
        await this.sendRaw(provider, via, 50_000_000n, simpleOp(Op.GuardianPause));
    }

    async sendUnpause(provider: ContractProvider, via: Sender) {
        await this.sendRaw(provider, via, 50_000_000n, simpleOp(Op.GuardianUnpause));
    }

    async sendProposeWitness(provider: ContractProvider, via: Sender, index: number, newKey: Buffer) {
        await this.sendRaw(provider, via, 50_000_000n,
            simpleOp(Op.ProposeWitness, 0n, (b) => b.storeUint(index, 8).storeUint(bigFromKey(newKey), 256)));
    }

    async sendCancelWitness(provider: ContractProvider, via: Sender) {
        await this.sendRaw(provider, via, 50_000_000n, simpleOp(Op.CancelWitness));
    }

    async sendExecuteWitness(provider: ContractProvider, via: Sender) {
        await this.sendRaw(provider, via, 50_000_000n, simpleOp(Op.ExecuteWitness));
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const r = await provider.get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
        return r.stack.readAddress();
    }

    async getBankAddress(provider: ContractProvider): Promise<Address> {
        return (await provider.get('get_bank_address', [])).stack.readAddress();
    }

    async getChildAddress(provider: ContractProvider, isBudget: boolean, key: bigint): Promise<Address> {
        const r = await provider.get('get_child_address', [
            { type: 'int', value: isBudget ? -1n : 0n },
            { type: 'int', value: key },
        ]);
        return r.stack.readAddress();
    }

    async getJettonData(provider: ContractProvider) {
        const s = (await provider.get('get_jetton_data', [])).stack;
        return {
            totalSupply: s.readBigNumber(),
            mintable: s.readBoolean(),
            admin: s.readAddressOpt(),
            content: s.readCell(),
            walletCode: s.readCell(),
        };
    }

    async getState(provider: ContractProvider) {
        const s = (await provider.get('get_consom_state', [])).stack;
        return {
            totalSupply: s.readBigNumber(),
            burnedByConversion: s.readBigNumber(),
            t0: s.readNumber(),
            networkId: s.readNumber(),
            pausedUntil: s.readNumber(),
            lastPauseStart: s.readNumber(),
            genesisDone: s.readBoolean(),
            halvingSteps: s.readNumber(),
        };
    }

    async getCaps(provider: ContractProvider) {
        const s = (await provider.get('get_caps', [])).stack;
        return {
            presale: s.readBigNumber(),
            purchase: s.readBigNumber(),
            referral: s.readBigNumber(),
            missions: s.readBigNumber(),
            founders: s.readBigNumber(),
            team: s.readBigNumber(),
            chika: s.readBigNumber(),
            foundation: s.readBigNumber(),
            presaleSettled: s.readBoolean(),
            dayStart: s.readNumber(),
            dayMinted: s.readBigNumber(),
            founderShares: s.readBigNumber(),
            earlyHold: s.readBigNumber(),
        };
    }

    async getTeamVesting(provider: ContractProvider) {
        const s = (await provider.get('get_team_vesting', [])).stack;
        return { unlocked: s.readBigNumber(), created: s.readBigNumber(), nextReleaseAt: s.readNumber() };
    }

    async getTeamAddress(provider: ContractProvider): Promise<Address> {
        return (await provider.get('get_team_address', [])).stack.readAddress();
    }

    async getBurnForPoints(provider: ContractProvider, points: bigint): Promise<bigint> {
        return (await provider.get('get_burn_for_points', [{ type: 'int', value: points }])).stack.readBigNumber();
    }

    // A16 : la liste des adresses interdites de réception, exactement comme gravée au déploiement
    async getForbiddenRecipients(provider: ContractProvider): Promise<Address[]> {
        const s = (await provider.get('get_forbidden_recipients', [])).stack;
        const count = s.readNumber();
        const list: Address[] = [];
        for (let i = 0; i < MAX_FORBIDDEN_RECIPIENTS; i++) {
            const a = s.readAddressOpt();
            if (a) list.push(a);
        }
        if (list.length !== count) throw new Error('liste interdite incohérente');
        return list;
    }

    async getWitnessKeys(provider: ContractProvider) {
        const s = (await provider.get('get_witnesses', [])).stack;
        return {
            key0: s.readBigNumber(),
            key1: s.readBigNumber(),
            key2: s.readBigNumber(),
            pending: s.readCellOpt(),
            lastReplaceAt: s.readNumber(),
        };
    }
}

// ---------- Banque d'échange ----------

// Données initiales de la banque (BankInit) : l'émetteur calcule l'adresse de la banque à partir d'elles
export function bankInitData(minter: Address, t0: number, walletCode: Cell, shareCode: Cell): Cell {
    return beginCell()
        .storeAddress(minter)
        .storeUint(t0, 32)
        .storeRef(walletCode)
        .storeRef(shareCode)
        .storeMaybeRef(null)
        .endCell();
}

// Corps d'un transfert de ConsoM (TEP-74) depuis le wallet de `owner` vers `to`, avec une charge utile
export function jettonTransferBody(o: { amount: bigint; to: Address; responseTo: Address; forwardTon: bigint; payload?: Cell }): Cell {
    const b = beginCell()
        .storeUint(Op.JettonTransfer, 32)
        .storeUint(0, 64)
        .storeCoins(o.amount)
        .storeAddress(o.to)
        .storeAddress(o.responseTo)
        .storeMaybeRef(null)
        .storeCoins(o.forwardTon);
    if (o.payload) b.storeBit(true).storeRef(o.payload);
    else b.storeBit(false);
    return b.endCell();
}

// Résultat d'une conversion via la banque, envoyé par la banque à celui qui a présenté le bon (op 0xc0150060).
// `burned` : part couverte par la banque (brûlée, frais de 10 % aux déposants) ;
// `coveredByFoundation` : part couverte par la réserve de la Fondation (rien n'est brûlé, frais de 10 % à la Fondation).
export type ConversionResult = { queryId: bigint; accepted: boolean; required: bigint; burned: bigint; coveredByFoundation: bigint };

export function decodeConversionResult(body: Cell): ConversionResult | null {
    const s = body.beginParse();
    if (s.remainingBits < 32 || s.loadUint(32) !== Op.ConversionResult) return null;
    return {
        queryId: s.loadUintBig(64),
        accepted: s.loadUint(8) === 1,
        required: s.loadCoins(),
        burned: s.loadCoins(),
        coveredByFoundation: s.loadCoins(),
    };
}

export const depositPayload = () => beginCell().storeUint(Op.DepositTag, 32).endCell();

export const ownConversionPayload = (voucher: Cell, sigA: Cell, sigB: Cell) =>
    beginCell().storeUint(Op.OwnConversionTag, 32).storeRef(voucher).storeRef(sigA).storeRef(sigB).endCell();

export const withdrawRequestBody = (shares: bigint) =>
    beginCell().storeUint(Op.WithdrawRequest, 32).storeUint(0, 64).storeCoins(shares).endCell();
