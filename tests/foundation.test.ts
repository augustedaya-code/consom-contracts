// Tests de la réserve de la Fondation (livre blanc v5.0, règle A13) : 100 000 ConsoM sous clé dès le lancement, dans un stock
// à part de la banque ; ouverture automatique après T0 + 24 mois si la banque reste vide 30 jours de suite ; ensuite dernier
// recours (la banque d'abord), SANS rien brûler.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beginCell, toNano } from '@ton/core';
import { setup, hasTx, describeTxs, T0, DAY } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err, decodeConversionResult, jettonTransferBody } from '../wrappers/ConsoMMinter.ts';

const BURN_NOTIFICATION = 0x7bdd97de;
const FOUNDATION = consom(100_000);
const DEPOSITORS = consom(3_500_000);
const T24 = 24 * 30 * DAY;      // T0 + 24 mois

async function withGenesis() {
    const env = await setup();
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

// Résultat de conversion (ConversionResult) reçu par celui qui a présenté le bon
function resultOf(r: { transactions: any[] }) {
    for (const tx of r.transactions) {
        const body = tx.inMessage?.body;
        if (!body) continue;
        const res = decodeConversionResult(body);
        if (res) return { ...res, to: tx.inMessage.info.dest };
    }
    return null;
}

// 1 Point = 10^8 unités de base au départ : `points` Points demandent points / 10 ConsoM
const convert = (env: Env, points: bigint) =>
    env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points, waveAmount: 0n, amount: 0n }));

// Banque vidée par les retraits : un Ancien Contributeur (le membre) réclame les 5 000 000, puis retire tout le stock des
// déposants à T0 + `emptyAtDays`. La réserve de la Fondation reste intacte dans le wallet de la banque.
async function emptiedBank(emptyAtDays: number) {
    const env = await withGenesis();
    await env.claim(env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: consom(5_000_000), waveRef: 0n, waveAmount: 0n, points: 0n, memberId: 777n }));
    env.blockchain.now = T0 + emptyAtDays * DAY;
    await env.withdraw(env.member);
    const bank = await env.bankState();
    assert.equal(bank.depositorStock, 0n, 'banque vide');
    assert.equal((await env.foundationState()).emptySince, env.blockchain.now, '« vide depuis » noté');
    return env;
}

// Banque dont il ne reste que `left` unités de base de stock des déposants : un Ancien Contributeur (le membre) réclame les
// 5 000 000, puis retire presque tout à T0 + `atDays`.
async function bankWithStockLeft(left: bigint, atDays: number) {
    const env = await withGenesis();
    await env.claim(env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: consom(5_000_000), waveRef: 0n, waveAmount: 0n, points: 0n, memberId: 777n }));
    env.blockchain.now = T0 + atDays * DAY;
    await env.withdraw(env.member, DEPOSITORS - left);
    assert.equal((await env.bankState()).depositorStock, left);
    return env;
}

describe('Réserve de la Fondation : genèse', () => {
    it('100 000 ConsoM créés une fois, dans un stock à part ; offre totale +100 000 ; réserve CAT_FOUNDATION vidée', async () => {
        const env = await withGenesis();
        const f = await env.foundationState();
        assert.equal(f.stock, FOUNDATION);
        assert.equal(f.isOpen, false);
        assert.equal(f.emptySince, 0);
        assert.equal(f.openableAt, 0);
        const bank = await env.bankState();
        assert.equal(bank.depositorStock, DEPOSITORS, 'jamais mélangé au stock des déposants');
        assert.equal(bank.totalShares, DEPOSITORS, 'jamais en parts');
        assert.equal(bank.unassignedShares, DEPOSITORS);
        assert.equal(await env.balanceOf(env.bankAddress), DEPOSITORS + FOUNDATION);
        assert.equal((await env.minter.getJettonData()).totalSupply, DEPOSITORS + FOUNDATION, 'compte dans l\'offre totale');
        assert.equal((await env.minter.getCaps()).foundation, 0n, 'réserve CAT_FOUNDATION vidée à la genèse');
    });

    it('la genèse ne se fait qu\'une fois : la Fondation ne peut pas être recréée', async () => {
        const env = await withGenesis();
        const r = await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.GENESIS_DONE }), describeTxs(r));
        assert.equal((await env.foundationState()).stock, FOUNDATION);
        assert.equal((await env.minter.getJettonData()).totalSupply, DEPOSITORS + FOUNDATION);
    });
});

describe('Réserve de la Fondation : intouchable avant l\'ouverture', () => {
    it('même en retirant tout le stock des déposants, les 100 000 restent dans la banque', async () => {
        const env = await emptiedBank(400);
        assert.equal(await env.balanceOf(env.bankAddress), FOUNDATION);
        assert.equal((await env.foundationState()).stock, FOUNDATION);
        assert.equal((await env.bankState()).depositorStock, 0n);
    });

    it('personne ne peut transférer ni brûler les jetons du wallet de la banque', async () => {
        const env = await withGenesis();
        const bankWallet = await env.minter.getWalletAddress(env.bankAddress);
        const transfer = await env.stranger.send({
            to: bankWallet, value: toNano('0.3'),
            body: jettonTransferBody({ amount: FOUNDATION, to: env.stranger.address, responseTo: env.stranger.address, forwardTon: 0n }),
        });
        assert.ok(hasTx(transfer, { to: bankWallet, success: false }), describeTxs(transfer));
        const burn = await env.stranger.send({
            to: bankWallet, value: toNano('0.3'),
            body: beginCell().storeUint(Op.Burn, 32).storeUint(0, 64).storeCoins(FOUNDATION).storeAddress(env.stranger.address).storeMaybeRef(null).endCell(),
        });
        assert.ok(hasTx(burn, { to: bankWallet, success: false }), describeTxs(burn));
        assert.equal(await env.balanceOf(env.bankAddress), DEPOSITORS + FOUNDATION);
        assert.equal(await env.balanceOf(env.stranger.address), 0n);
    });

    it('la banque n\'obéit qu\'à l\'émetteur : un faux ordre de brûlage ne touche à rien', async () => {
        const env = await withGenesis();
        const fake = beginCell().storeUint(Op.BankBurn, 32).storeUint(0, 64).storeCoins(FOUNDATION).storeAddress(env.stranger.address).endCell();
        const r = await env.stranger.send({ to: env.bankAddress, value: toNano('0.2'), body: fake });
        assert.ok(hasTx(r, { to: env.bankAddress, success: false, exitCode: 460 }), describeTxs(r));
        assert.equal((await env.foundationState()).stock, FOUNDATION);
    });

    it('un envoi qui se fait passer pour la création de la Fondation est refusé et rendu', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());                      // 3 000 ConsoM pour le membre
        env.blockchain.now = T0 + 400 * DAY;
        const payload = beginCell().storeUint(0xc0150031, 32).endCell();
        await env.sendToBank(env.member, consom(1000), payload);
        assert.equal(await env.balanceOf(env.member.address), consom(3000), 'jetons rendus');
        assert.equal((await env.foundationState()).stock, FOUNDATION, 'stock de la Fondation inchangé');
        assert.equal((await env.bankState()).depositorStock, DEPOSITORS, 'stock des déposants inchangé');
    });

    it('banque vide mais réserve fermée : la conversion est refusée, rien n\'est brûlé', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + 400 * DAY;                 // vide depuis 34 jours, mais avant T0 + 24 mois
        const r = await convert(env, 1000n);
        const res = resultOf(r)!;
        assert.equal(res.accepted, false, describeTxs(r));
        assert.equal(res.burned, 0n);
        assert.equal(res.coveredByFoundation, 0n);
        assert.ok(!hasTx(r, { op: BURN_NOTIFICATION }), 'rien brûlé');
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
        assert.equal((await env.foundationState()).isOpen, false);
    });
});

describe('Réserve de la Fondation : ouverture automatique', () => {
    it('banque vide 30 jours mais avant T0 + 24 mois : pas d\'ouverture ; à T0 + 24 mois : ouverte', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24 - DAY;
        let f = await env.foundationState();
        assert.equal(f.isOpen, false, 'vide depuis plus de 30 jours, mais trop tôt');
        assert.equal(f.openableAt, T0 + T24, 'date d\'ouverture possible : T0 + 24 mois');
        env.blockchain.now = T0 + T24;
        f = await env.foundationState();
        assert.equal(f.isOpen, true);
        assert.equal(f.openableAt, T0 + T24);
    });

    it('après T0 + 24 mois : vide 29 jours = fermée, un dépôt au 20e jour remet à zéro, 30 jours de suite = ouverte pour toujours', async () => {
        const W = T24;                                        // la banque se vide à T0 + 24 mois exactement
        const env = await emptiedBank(W / DAY);
        let f = await env.foundationState();
        assert.equal(f.openableAt, T0 + W + 30 * DAY, 'ouvrirait 30 jours après le vidage');

        env.blockchain.now = T0 + W + 29 * DAY;
        assert.equal((await env.foundationState()).isOpen, false, '29 jours : pas d\'ouverture');

        // un dépôt au 20e jour remet le compteur à zéro
        env.blockchain.now = T0 + W + 20 * DAY;
        await env.deposit(env.member, consom(1000));
        f = await env.foundationState();
        assert.equal(f.emptySince, 0, '« vide depuis » effacé par le dépôt');
        assert.equal(f.openableAt, 0);
        env.blockchain.now = T0 + W + 60 * DAY;
        assert.equal((await env.foundationState()).isOpen, false, 'la banque n\'est plus vide');

        // la banque se vide de nouveau : le compteur repart de ce moment
        env.blockchain.now = T0 + W + 61 * DAY;
        await env.withdraw(env.member);
        const emptyAt = T0 + W + 61 * DAY;
        assert.equal((await env.foundationState()).emptySince, emptyAt);
        env.blockchain.now = emptyAt + 30 * DAY - 1;
        assert.equal((await env.foundationState()).isOpen, false, '30 jours moins une seconde');
        env.blockchain.now = emptyAt + 30 * DAY;
        f = await env.foundationState();
        assert.equal(f.isOpen, true, '30 jours de suite : ouverte');
        assert.equal(f.openableAt, emptyAt + 30 * DAY);

        // un nouveau dépôt ne la referme pas
        await env.deposit(env.member, consom(1000));
        f = await env.foundationState();
        assert.equal(f.isOpen, true, 'ouverte pour toujours');
        assert.equal(f.openableAt, emptyAt + 30 * DAY, 'date d\'ouverture conservée');
        assert.equal(f.emptySince, 0);
        env.blockchain.now += 400 * DAY;
        assert.equal((await env.foundationState()).isOpen, true);
    });
});

describe('Réserve de la Fondation : dernier recours sans brûler', () => {
    it('ouverte, banque vide : conversion acceptée, rien de brûlé, stock de la Fondation et paliers inchangés', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        const supplyBefore = (await env.minter.getJettonData()).totalSupply;
        const r = await convert(env, 1000n);                  // 100 ConsoM au taux du moment
        const res = resultOf(r)!;
        assert.deepEqual(
            { accepted: res.accepted, required: res.required, burned: res.burned, covered: res.coveredByFoundation },
            { accepted: true, required: consom(100), burned: 0n, covered: consom(100) }, describeTxs(r));
        assert.ok(res.to.equals(env.member.address), 'le résultat va à celui qui a présenté le bon');
        assert.ok(!hasTx(r, { op: BURN_NOTIFICATION }), 'aucun brûlage');
        const f = await env.foundationState();
        assert.equal(f.stock, FOUNDATION, 'le stock de la Fondation ne bouge pas');
        assert.equal(f.coveredTotal, consom(100));
        assert.equal(await env.balanceOf(env.bankAddress), FOUNDATION, 'rien n\'a quitté le wallet de la banque');
        const st = await env.minter.getState();
        assert.equal(st.burnedByConversion, 0n, 'le compteur des paliers ne compte que ce qui est brûlé');
        assert.equal(st.halvingSteps, 0);
        assert.equal(st.totalSupply, supplyBefore, 'l\'offre ne baisse pas');
        assert.equal((await env.bankState()).depositorStock, 0n);
    });

    it('le bon est consommé : le même bon ne couvre pas deux fois', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        const v = env.voucher({ kind: Kind.BANK_CONVERSION, points: 1000n, waveAmount: 0n, amount: 0n });
        await env.claim(v);
        const r = await env.claim(v);
        assert.equal(resultOf(r), null, 'refusé par le compte membre avant la banque');
        assert.equal((await env.foundationState()).coveredTotal, consom(100));
    });

    it('banque partiellement suffisante : la banque brûle sa part, la Fondation couvre le reste, le résultat le dit', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        await env.deposit(env.member, consom(1000));          // stock des déposants : 1 000 ; plafond de 5 % : 50 par 24 h
        env.blockchain.now = T0 + T24 + DAY;
        const stockBefore = (await env.bankState()).depositorStock;
        const r = await convert(env, 1000n);                  // 100 ConsoM demandés
        const res = resultOf(r)!;
        assert.deepEqual(
            { accepted: res.accepted, required: res.required, burned: res.burned, covered: res.coveredByFoundation },
            { accepted: true, required: consom(100), burned: consom(50), covered: consom(50) }, describeTxs(r));
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), 'la part de la banque est brûlée');
        const st = await env.minter.getState();
        assert.equal(st.burnedByConversion, consom(50), 'seule la part brûlée compte pour les paliers');
        assert.equal((await env.bankState()).depositorStock, stockBefore - consom(50));
        const f = await env.foundationState();
        assert.equal(f.stock, FOUNDATION);
        assert.equal(f.coveredTotal, consom(50));
        assert.equal(await env.balanceOf(env.bankAddress), FOUNDATION + stockBefore - consom(50));
    });

    it('banque suffisante : tout est brûlé par la banque, la Fondation ne couvre rien', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        await env.deposit(env.member, consom(1_000_000));     // plafond de 5 % : 50 000
        env.blockchain.now = T0 + T24 + DAY;
        const r = await convert(env, 1000n);
        const res = resultOf(r)!;
        assert.deepEqual(
            { accepted: res.accepted, burned: res.burned, covered: res.coveredByFoundation },
            { accepted: true, burned: consom(100), covered: 0n }, describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(100));
        assert.equal((await env.foundationState()).coveredTotal, 0n);
    });

    it('la réserve ne couvre jamais plus que son stock en une conversion : au-delà, refus', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        const r = await convert(env, 2_000_000n);             // 200 000 ConsoM demandés > 100 000
        const res = resultOf(r)!;
        assert.equal(res.accepted, false, describeTxs(r));
        assert.equal(res.coveredByFoundation, 0n);
        assert.equal((await env.foundationState()).coveredTotal, 0n);
        const ok = await convert(env, 1_000_000n);            // 100 000 : exactement le stock
        assert.equal(resultOf(ok)!.coveredByFoundation, FOUNDATION, describeTxs(ok));
        assert.equal((await env.foundationState()).stock, FOUNDATION, 'toujours 100 000');
    });

    it('reste bloquée par la pause du gardien (c\'est une conversion via la banque)', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        await env.minter.sendPause(env.guardian.getSender());
        const r = await convert(env, 1000n);
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.PAUSED }), describeTxs(r));
        assert.equal((await env.foundationState()).coveredTotal, 0n);
    });
});

describe('Résultat de chaque conversion via la banque', () => {
    it('conversion normale : tout est brûlé par la banque, rien par la Fondation', async () => {
        const env = await withGenesis();
        const r = await convert(env, 1_000_000n);             // 100 000 ConsoM
        const res = resultOf(r)!;
        assert.deepEqual(
            { queryId: res.queryId, accepted: res.accepted, required: res.required, burned: res.burned, covered: res.coveredByFoundation },
            { queryId: 0n, accepted: true, required: consom(100_000), burned: consom(100_000), covered: 0n }, describeTxs(r));
        assert.ok(res.to.equals(env.member.address));
    });

    it('conversion refusée (plafond de 5 % atteint, réserve fermée) : le résultat dit « refusée »', async () => {
        const env = await withGenesis();
        await convert(env, 1_750_000n);                       // 175 000 = 5 % du stock
        const r = await convert(env, 10n);
        const res = resultOf(r)!;
        assert.equal(res.accepted, false, describeTxs(r));
        assert.equal(res.burned, 0n);
        assert.equal(res.coveredByFoundation, 0n);
        assert.equal(res.required, consom(1));
    });
});

describe('Réserve de la Fondation : « vide » = moins de 1 ConsoM (décision du 30 octobre 2026)', () => {
    it('un stock de 0,9 ConsoM est vide : « vide depuis » est noté dès que le stock passe sous 1 ConsoM', async () => {
        const env = await bankWithStockLeft(900_000_000n, 366);
        assert.equal((await env.foundationState()).emptySince, T0 + 366 * DAY);
    });

    it('un stock d\'exactement 1 ConsoM n\'est pas vide', async () => {
        const env = await bankWithStockLeft(1_000_000_000n, 366);
        assert.equal((await env.foundationState()).emptySince, 0);
    });

    it('un dépôt de 0,05 ConsoM qui laisse le stock sous 1 ConsoM ne change rien : le compteur n\'est pas remis à zéro', async () => {
        const env = await bankWithStockLeft(900_000_000n, 366);
        const since = (await env.foundationState()).emptySince;
        env.blockchain.now = T0 + 380 * DAY;
        await env.deposit(env.member, 50_000_000n);
        assert.equal((await env.bankState()).depositorStock, 950_000_000n, 'le dépôt est bien entré');
        assert.equal((await env.foundationState()).emptySince, since, 'compteur inchangé');
    });

    it('un dépôt qui fait passer le stock à 1 ConsoM ou plus remet le compteur à zéro', async () => {
        const env = await bankWithStockLeft(900_000_000n, 366);
        env.blockchain.now = T0 + 380 * DAY;
        await env.deposit(env.member, 100_000_000n);                      // 0,9 + 0,1 = exactement 1 ConsoM
        assert.equal((await env.bankState()).depositorStock, 1_000_000_000n);
        const f = await env.foundationState();
        assert.equal(f.emptySince, 0);
        assert.equal(f.openableAt, 0);
        // et il faut repartir de zéro : un retrait qui repasse sous 1 ConsoM relance le compteur à cette date
        env.blockchain.now = T0 + 382 * DAY;
        await env.withdraw(env.member, 500_000_000n);
        assert.equal((await env.foundationState()).emptySince, T0 + 382 * DAY);
    });

    it('avec 0,9 ConsoM de stock, la réserve s\'ouvre après 30 jours ; la banque brûle ce qu\'elle peut, la Fondation couvre le reste', async () => {
        const env = await bankWithStockLeft(900_000_000n, T24 / DAY);
        env.blockchain.now = T0 + T24 + 29 * DAY;
        assert.equal((await env.foundationState()).isOpen, false, '29 jours : fermée');
        env.blockchain.now = T0 + T24 + 30 * DAY;
        assert.equal((await env.foundationState()).isOpen, true, '30 jours sous 1 ConsoM : ouverte');
        const r = await convert(env, 1000n);                                // 100 ConsoM demandés ; plafond de 5 % de 0,9 = 0,045
        const res = resultOf(r)!;
        assert.deepEqual(
            { accepted: res.accepted, burned: res.burned, covered: res.coveredByFoundation },
            { accepted: true, burned: 45_000_000n, covered: consom(100) - 45_000_000n }, describeTxs(r));
        assert.equal((await env.foundationState()).stock, FOUNDATION);
    });
});

describe('Réserve de la Fondation : au plus 100 000 ConsoM couverts par conversion (pas de plafond cumulé)', () => {
    it('la part couverte par la Fondation est limitée à 100 000 : au-delà, la conversion est refusée en entier', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        await env.deposit(env.member, consom(1_000_000));                  // plafond de 5 % : 50 000 par 24 h
        env.blockchain.now = T0 + T24 + DAY;
        // 160 000 demandés : la banque brûle 50 000, il resterait 110 000 à la Fondation > 100 000 : refusé, rien n'est brûlé
        const over = await convert(env, 1_600_000n);
        const o = resultOf(over)!;
        assert.equal(o.accepted, false, describeTxs(over));
        assert.equal(o.burned, 0n);
        assert.equal(o.coveredByFoundation, 0n);
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
        // 150 000 demandés : la banque brûle 50 000, la Fondation couvre exactement 100 000 : accepté
        const ok = await convert(env, 1_500_000n);
        const k = resultOf(ok)!;
        assert.deepEqual({ accepted: k.accepted, burned: k.burned, covered: k.coveredByFoundation },
            { accepted: true, burned: consom(50_000), covered: consom(100_000) }, describeTxs(ok));
    });

    it('pas de plafond cumulé : plusieurs conversions de 100 000 de suite sont couvertes, le stock reste à 100 000', async () => {
        const env = await emptiedBank(366);
        env.blockchain.now = T0 + T24;
        for (let i = 0; i < 3; i++) {
            const r = await convert(env, 1_000_000n);                      // 100 000 ConsoM demandés, banque vide
            assert.equal(resultOf(r)!.coveredByFoundation, FOUNDATION, `conversion ${i + 1}\n${describeTxs(r)}`);
        }
        const f = await env.foundationState();
        assert.equal(f.coveredTotal, 3n * FOUNDATION);
        assert.equal(f.stock, FOUNDATION, 'le stock de la Fondation ne bouge jamais');
        assert.equal(await env.balanceOf(env.bankAddress), FOUNDATION);
    });
});
