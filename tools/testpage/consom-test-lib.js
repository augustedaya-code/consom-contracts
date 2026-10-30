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
        conversionReward: (owner, points) => claimMessage(owner, { kind: KIND.CONVERSION, points: BigInt(points), amount: BigInt(points) * ONE * 500n / 10000n }),
        firstPurchase: (owner) => claimMessage(owner, { kind: KIND.FIRST_PURCHASE, amount: 500n * ONE, waveAmount: 1000n }),
        missionTelegram: (owner) => claimMessage(owner, { kind: KIND.MISSION_TG, amount: 150n * ONE }),
        missionFacebook: (owner) => claimMessage(owner, { kind: KIND.MISSION_FB, amount: 150n * ONE }),
        referral: (owner, points, level) => {
            const rate = [0n, 250n, 130n, 70n, 40n, 10n][level];
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

    // ---------- Lecture des résultats ----------
    // `txs` : transactions de l'émetteur au format tonapi (/v2/blockchain/accounts/<émetteur>/transactions), les plus récentes d'abord.
    // Renvoie, pour l'adresse `owner`, une ligne lisible par opération : { time, status: 'ok' | 'refused' | 'info', title, detail }.
    const REJECT_TEXT = {
        1: 'cette récompense a déjà été versée pour ce paiement (bon déjà utilisé)',
        2: 'montant ou Points différents de ceux déjà attestés pour ce paiement',
        3: 'un paiement de prévente ne donne pas d\'autre récompense',
        10: 'ce compte membre est lié à une autre adresse',
        11: 'parrainage refusé : il faut d\'abord une prévente',
        12: 'plafond de 50 000 ConsoM par 24 h atteint (réessayer demain)',
        13: 'bonus ou mission déjà reçu',
        14: 'mission refusée : il faut d\'abord un achat enregistré',
        15: 'bon de conversion déjà utilisé : préparer un nouveau bon',
        16: 'pas assez de Points valides (jamais enregistrés, déjà convertis, ou plus de 7 jours)',
    };
    const ERROR_TEXT = {
        400: 'l\'émetteur est en pause', 401: 'bon signé pour un autre réseau', 402: 'bon signé pour un autre contrat',
        403: 'bon expiré : préparer un nouveau bon', 404: 'bon valable trop longtemps', 405: 'signature invalide',
        406: 'deux signatures du même témoin', 407: 'témoin inconnu',
        408: 'le compte ouvert dans Tonkeeper n\'est pas celui inscrit sur le bon',
        409: 'type de bon inconnu', 410: 'hors de la période autorisée', 411: 'montant incorrect',
        412: 'plafond de la catégorie atteint', 413: 'plafond journalier global atteint', 414: 'offre maximale atteinte',
        415: 'trop de Points pour le montant payé', 416: 'pas assez de Gram joints',
        420: 'réservé au gardien', 421: 'une pause a déjà eu lieu dans les 30 derniers jours',
    };
    const KIND_TEXT = ['Prévente', 'Enregistrement d\'achat', 'Parrainage', 'Bonus de 1er achat', 'Bonus de conversion',
        'Mission Telegram', 'Mission Facebook', 'Bonus d\'investissement', 'Conversion via la banque', 'Conversion avec ses ConsoM'];
    const fmtConsom = (nano) => (Number(nano) / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 2 });

    function describeMinterTxs(txs, owner) {
        const me = owner.toRawString();
        const out = [];
        for (const tx of txs) {
            const m = tx.in_msg;
            if (!m || !m.raw_body) continue;
            const src = m.source && m.source.address;
            const exit = tx.compute_phase ? tx.compute_phase.exit_code : 0;
            let body;
            try { body = Cell.fromBoc(Buffer.from(m.raw_body, 'hex'))[0].beginParse(); } catch (e) { continue; }
            if (body.remainingBits < 32) continue;
            const op = body.loadUint(32);
            const base = { time: tx.utime };
            try {
                if (op === 0xc0150001 && src === me) {
                    let kind = null;
                    try { const v = Cell.fromBoc(Buffer.from(m.raw_body, 'hex'))[0].refs[0].beginParse(); v.loadInt(32); v.loadAddress(); v.loadUint(64); kind = v.loadUint(8); } catch (e) { /* bon illisible */ }
                    const what = kind !== null && KIND_TEXT[kind] ? KIND_TEXT[kind] : 'Bon';
                    if (exit !== 0) out.push({ ...base, status: 'refused', title: what + ' : refusé par l\'émetteur', detail: ERROR_TEXT[exit] || ('code ' + exit) });
                    else out.push({ ...base, status: 'info', kindLabel: what, title: what + ' : bon reçu par l\'émetteur', detail: 'en cours de vérification…' });
                } else if (op === 0xc0150003) {
                    body.loadUint(64); body.loadUint(8);
                    const reserved = body.loadCoins(); body.loadUintBig(256);
                    const recipient = body.loadAddress();
                    const hasBurn = body.loadBit();
                    if (recipient.toRawString() !== me) continue;
                    if (hasBurn) out.push({ ...base, status: 'ok', title: 'Conversion acceptée', detail: 'la banque d\'échange brûle les ConsoM' });
                    else if (reserved === 0n) out.push({ ...base, status: 'ok', title: 'Accepté', detail: 'Points enregistrés (aucun ConsoM créé)' });
                    else out.push({ ...base, status: 'ok', title: 'Accepté : +' + fmtConsom(reserved) + ' ConsoM', detail: 'créés dans ton wallet ConsoM' });
                } else if (op === 0xc0150004) {
                    body.loadUint(64); body.loadUint(8); body.loadCoins(); body.loadBit(); body.loadUintBig(256);
                    const refundTo = body.loadAddress();
                    const reason = body.loadUint(16);
                    if (refundTo.toRawString() !== me) continue;
                    out.push({ ...base, status: 'refused', title: 'Refusé', detail: REJECT_TEXT[reason] || ('raison ' + reason) });
                } else if (op === 0x7bdd97de) {
                    body.loadUint(64);
                    const amount = body.loadCoins();
                    const initiator = body.loadAddress();
                    const excessesTo = body.loadMaybeAddress();
                    const fromBank = initiator.equals(bank);
                    if (!fromBank && initiator.toRawString() !== me) continue;
                    if (fromBank && !(excessesTo && excessesTo.toRawString() === me)) continue;
                    if (fromBank) out.push({ ...base, status: 'ok', title: fmtConsom(amount) + ' ConsoM brûlés', detail: 'conversion terminée (compte pour le halving)' });
                    else if (exit === 0) out.push({ ...base, status: 'ok', title: 'Brûlage volontaire de ' + fmtConsom(amount) + ' ConsoM', detail: 'recréés dans la banque d\'échange' });
                    else out.push({ ...base, status: 'refused', title: 'Brûlage volontaire annulé', detail: (ERROR_TEXT[exit] || ('code ' + exit)) + ' ; tes ConsoM sont rendus' });
                } else if ((op === 0xc0150010 || op === 0xc0150011) && src === me) {
                    const what = op === 0xc0150010 ? 'Pause' : 'Levée de la pause';
                    out.push({ ...base, status: exit === 0 ? 'ok' : 'refused', title: what + (exit === 0 ? ' : faite' : ' : refusée'), detail: exit === 0 ? '' : (ERROR_TEXT[exit] || ('code ' + exit)) });
                }
            } catch (e) { /* message d'un autre format : ignoré */ }
        }
        // chaque réponse reprend le nom du bon envoyé juste avant ; le bon « en cours » n'est alors plus utile
        const used = new Set();
        for (const r of out) {
            if (r.status === 'info' || r.kindLabel) continue;
            const sent = out.find((x) => x.status === 'info' && !used.has(x) && x.time <= r.time && r.time - x.time <= 60);
            if (sent) { used.add(sent); r.title = sent.kindLabel + ' — ' + r.title; }
        }
        return out.filter((r) => !used.has(r));
    }

    return { actions, tonkeeperLink, walletAddressOf, memberAccountOf, memberIdOf, describeMinterTxs, minter, bank, KIND };
}
