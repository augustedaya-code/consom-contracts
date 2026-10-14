// Fabrique les messages de test de ConsoM (testnet) : bons signés, transferts, brûlages, gardien.
// Utilisé par la page de test (navigateur) et vérifié par tests/testpage.test.ts dans le simulateur.
// `TON` fournit : Address, beginCell, Cell, contractAddress, toNano, sign, keyPairFromSeed, sha256Sync.
// AUCUNE clé de ce fichier ne doit servir hors du testnet.

export function createConsoMTestLib(TON, cfg) {
    const { Address, beginCell, Cell, contractAddress, toNano } = TON;
    const ONE = 1_000_000_000n;
    const consom = (n) => BigInt(Math.round(Number(n) * 1e9));
    const KIND = { PRESALE: 0, PURCHASE_RECORD: 1, REFERRAL: 2, FIRST_PURCHASE: 3, CONVERSION: 4, MISSION_TG: 5, MISSION_FB: 6, INVESTMENT: 7, BANK_CONVERSION: 8, OWN_CONVERSION: 9 };
    const PACKS = { essentiel: [3000n, 3500n], populaire: [20000n, 17500n], grande: [50000n, 38000n] };

    const minter = Address.parse(cfg.minter);
    const bank = Address.parse(cfg.bank);
    const walletCode = Cell.fromBase64(cfg.walletCodeB64);
    const memberCode = Cell.fromBase64(cfg.memberCodeB64);
    const witnesses = cfg.witnessSeedsHex.map((h) => TON.keyPairFromSeed(Buffer.from(h, 'hex')));

    // Identifiant de membre de test : empreinte de l'adresse du membre (dans l'application, ce sera l'identifiant TonMarché)
    const memberIdOf = (owner) => BigInt('0x' + TON.sha256Sync(Buffer.from(owner.toRawString())).toString('hex'));
    let lastId = 0n;
    const nextVoucherId = () => {
        const id = BigInt(Date.now()) * 1000n;
        lastId = id > lastId ? id : lastId + 1n;
        return lastId;
    };
    const nowSeconds = () => (cfg.nowSeconds ? cfg.nowSeconds() : Math.floor(Date.now() / 1000));
    const randomRef = () => BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'));

    // ---------- Adresses ----------

    // Wallet ConsoM d'un propriétaire : wallet shardé (même shard que le propriétaire, profondeur 8)
    function walletAddressOf(owner) {
        const data = beginCell().storeCoins(0).storeAddress(owner).storeAddress(minter).endCell();
        const init = { code: walletCode, data, splitDepth: 8 };
        const raw = contractAddress(0, init);
        const hash = Buffer.from(raw.hash);
        hash[0] = owner.hash[0];   // les 8 premiers bits viennent de l'adresse du propriétaire
        return new Address(0, hash);
    }

    function memberAccountOf(memberId) {
        const data = beginCell().storeAddress(minter).storeUint(memberId, 256).storeMaybeRef(null).endCell();
        return contractAddress(0, { code: memberCode, data });
    }

    // ---------- Bons ----------

    function voucher(owner, o) {
        const payment = beginCell()
            .storeUint(o.waveRef ?? randomRef(), 256)
            .storeCoins(o.waveAmount ?? 0n)
            .storeCoins(o.points ?? 0n)
            .storeUint(o.memberId ?? memberIdOf(owner), 256)
            .endCell();
        return beginCell()
            .storeInt(cfg.networkId, 32)
            .storeAddress(minter)
            .storeUint(o.voucherId ?? nextVoucherId(), 64)
            .storeUint(o.kind, 8)
            .storeUint(o.level ?? 0, 8)
            .storeUint(nowSeconds() + 3 * 86400, 32)
            .storeAddress(owner)
            .storeCoins(o.amount ?? 0n)
            .storeRef(payment)
            .endCell();
    }

    function signatures(v) {
        return [0, 1].map((i) => beginCell().storeUint(i, 8).storeBuffer(TON.sign(v.hash(), witnesses[i].secretKey)).endCell());
    }

    function claimMessage(owner, o) {
        const v = voucher(owner, o);
        const [a, b] = signatures(v);
        const body = beginCell().storeUint(0xc0150001, 32).storeUint(0, 64).storeRef(v).storeRef(a).storeRef(b).endCell();
        return { to: minter, value: toNano('0.35'), body };
    }

    // ---------- Actions de la page ----------

    const actions = {
        presale: (owner, pack) => {
            const [qty, price] = PACKS[pack];
            return claimMessage(owner, { kind: KIND.PRESALE, amount: qty * ONE, waveAmount: price });
        },
        purchaseRecord: (owner, points) => claimMessage(owner, { kind: KIND.PURCHASE_RECORD, points: BigInt(points), waveAmount: BigInt(points) * 2n }),
        conversionReward: (owner, points) => claimMessage(owner, { kind: KIND.CONVERSION, points: BigInt(points), amount: BigInt(points) * ONE * 3500n / 10000n }),
        firstPurchase: (owner) => claimMessage(owner, { kind: KIND.FIRST_PURCHASE, amount: 500n * ONE, waveAmount: 1000n }),
        missionTelegram: (owner) => claimMessage(owner, { kind: KIND.MISSION_TG, amount: 150n * ONE }),
        missionFacebook: (owner) => claimMessage(owner, { kind: KIND.MISSION_FB, amount: 150n * ONE }),
        referral: (owner, points, level) => {
            const rate = [0n, 1500n, 700n, 350n, 150n, 50n][level];
            return claimMessage(owner, { kind: KIND.REFERRAL, level, points: BigInt(points), waveAmount: BigInt(points) * 2n, amount: BigInt(points) * ONE * rate / 10000n });
        },
        bankConversion: (owner, points) => claimMessage(owner, { kind: KIND.BANK_CONVERSION, points: BigInt(points) }),
        // Conversion avec ses propres ConsoM : transfert vers la banque avec le bon signé (l'excédent est rendu)
        ownConversion: (owner, points, sendConsom) => {
            const v = voucher(owner, { kind: KIND.OWN_CONVERSION, points: BigInt(points) });
            const [a, b] = signatures(v);
            const payload = beginCell().storeUint(0xc0150033, 32).storeRef(v).storeRef(a).storeRef(b).endCell();
            const body = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(0, 64)
                .storeCoins(consom(sendConsom))
                .storeAddress(bank).storeAddress(owner)
                .storeMaybeRef(null)
                .storeCoins(toNano('0.3'))
                .storeBit(true).storeRef(payload)
                .endCell();
            return { to: walletAddressOf(owner), value: toNano('0.5'), body };
        },
        voluntaryBurn: (owner, amountConsom) => ({
            to: walletAddressOf(owner), value: toNano('0.2'),
            body: beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64).storeCoins(consom(amountConsom)).storeAddress(owner).storeMaybeRef(null).endCell(),
        }),
        pause: () => ({ to: minter, value: toNano('0.05'), body: beginCell().storeUint(0xc0150010, 32).storeUint(0, 64).endCell() }),
        unpause: () => ({ to: minter, value: toNano('0.05'), body: beginCell().storeUint(0xc0150011, 32).storeUint(0, 64).endCell() }),
    };

    // Lien Tonkeeper : https://app.tonkeeper.com/transfer/<adresse>?amount=<nanoTON>&bin=<BoC base64 encodé>
    function tonkeeperLink(msg) {
        const to = msg.to.toString({ testOnly: true, bounceable: true, urlSafe: true });
        const bin = encodeURIComponent(msg.body.toBoc().toString('base64'));
        return `https://app.tonkeeper.com/transfer/${to}?amount=${msg.value.toString()}&bin=${bin}`;
    }

    return { actions, tonkeeperLink, walletAddressOf, memberAccountOf, memberIdOf, minter, bank, KIND };
}
