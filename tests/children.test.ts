// Tests du budget de paiement et du compte membre (spécification, sections 4 à 6), branchés sur l'émetteur.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beginCell, toNano } from '@ton/core';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

const Reject = {
    SLOT_USED: 1, PAYMENT_MISMATCH: 2, PRESALE_EXCLUSIVE: 3, WRONG_OWNER: 10, NOT_ELIGIBLE: 11,
    DAILY_CAP: 12, ALREADY_DONE: 13, NO_PAYMENT: 14, STALE_VOUCHER: 15, NOT_ENOUGH_POINTS: 16,
};

const referral = (points: bigint, level = 1) => {
    const rate = [0n, 250n, 130n, 70n, 40n, 10n][level];
    return { kind: Kind.REFERRAL, level, points, waveAmount: points * 2n, amount: (points * consom(1) * rate) / 10000n };
};

describe('Budget de paiement', () => {
    it('une même récompense ne peut pas être versée deux fois pour un paiement', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        const v = env.voucher(referral(1000n));
        await env.claim(v);
        const r = await env.claim({ ...v, voucherId: 999n });
        assert.equal(rejectReason(r), Reject.SLOT_USED, describeTxs(r));
        // les autres niveaux du même paiement restent possibles (autres parrains)
        const r2 = await env.claim(env.voucher({ ...referral(1000n, 2), waveRef: v.waveRef, memberId: 1n }));
        assert.ok(hasTx(r2, { op: Op.MintApproved, success: true }), describeTxs(r2));
        assert.equal((await env.budgetState(v.waveRef))!.slots, 8 | 16);
    });

    it('refuse des données différentes de celles déjà attestées pour ce paiement', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        const v = env.voucher(referral(1000n));
        await env.claim(v);
        const r = await env.claim(env.voucher({ ...referral(900n, 2), waveRef: v.waveRef }));
        assert.equal(rejectReason(r), Reject.PAYMENT_MISMATCH, describeTxs(r));
    });

    it('un paiement de prévente ne donne aucune autre récompense, et inversement', async () => {
        const env = await setup();
        const presale = env.voucher();
        await env.claim(presale);
        const r = await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveRef: presale.waveRef, waveAmount: presale.waveAmount }));
        assert.equal(rejectReason(r), Reject.PRESALE_EXCLUSIVE, describeTxs(r));
        const purchase = env.voucher({ kind: Kind.PURCHASE_RECORD, points: 100n, waveAmount: 3500n, amount: 0n });
        await env.claim(purchase);
        const r2 = await env.claim(env.voucher({ waveRef: purchase.waveRef, points: 100n }));
        assert.equal(rejectReason(r2), Reject.PRESALE_EXCLUSIVE, describeTxs(r2));
    });

    it('n\'accepte de messages que de l\'émetteur', async () => {
        const env = await setup();
        const v = env.voucher();
        await env.claim(v);
        const budget = await env.minter.getChildAddress(true, v.waveRef);
        const r = await env.stranger.send({ to: budget, value: toNano('0.2'), body: beginCell().storeUint(Op.CheckClaim, 32).storeUint(0, 64).endCell() });
        assert.ok(hasTx(r, { to: budget, success: false, exitCode: 450 }), describeTxs(r));
    });

    it('un refus passager du compte membre (plafond du jour) libère l\'emplacement : le bon repasse le lendemain', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        // 1 800 000 Points au niveau 1 = 45 000 ConsoM ; un 2e parrainage identique dépasserait 50 000
        await env.claim(env.voucher(referral(1_800_000n)));
        const second = env.voucher({ ...referral(1_800_000n), validUntil: T0 + 3 * DAY });
        const r = await env.claim(second);
        assert.equal(rejectReason(r), Reject.DAILY_CAP, describeTxs(r));
        assert.equal((await env.budgetState(second.waveRef))!.slots, 0, 'emplacement libéré');
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(45_000), 'réservation libérée');
        env.blockchain.now = T0 + DAY;
        const again = await env.claim(second);
        assert.ok(hasTx(again, { op: Op.MintApproved, success: true }), describeTxs(again));
    });
});

describe('Compte membre', () => {
    it('lie le compte à l\'adresse de la première réclamation', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        assert.ok((await env.memberState(1n))!.owner!.equals(env.member.address));
        // un bon du même membre au profit d'une autre adresse est refusé, même envoyé par cette adresse
        const r = await env.claim(env.voucher({ recipient: env.stranger.address }), { from: env.stranger });
        assert.equal(rejectReason(r), Reject.WRONG_OWNER, describeTxs(r));
        assert.equal(await env.balanceOf(env.stranger.address), 0n);
    });

    it('le parrainage exige une prévente ; sinon l\'emplacement est perdu', async () => {
        const env = await setup();
        const v = env.voucher(referral(1000n));
        const r = await env.claim(v);
        assert.equal(rejectReason(r), Reject.NOT_ELIGIBLE, describeTxs(r));
        assert.equal((await env.budgetState(v.waveRef))!.slots, 8, 'emplacement non libéré (section 6)');
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral, 'réservation de l\'émetteur libérée');
    });

    it('règle d\'équité : sans prévente, chaque récompense est refusée ; après une prévente, la même est acceptée', async () => {
        const env = await setup();
        // un achat attesté (Points) ne suffit pas : il n'y a pas eu de prévente
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 100_000n, waveAmount: 200_000n, amount: 0n }));
        const rewards = [
            { kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(50) },
            { kind: Kind.INVESTMENT, points: 1000n, waveAmount: 0n, amount: consom(40) },
            { kind: Kind.CHIKA_BONUS, points: 0n, waveAmount: 1000n, amount: consom(3) },
            { kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500) },
            { kind: Kind.MISSION_TG, points: 0n, waveAmount: 0n, amount: consom(150) },
            { kind: Kind.MISSION_FB, points: 0n, waveAmount: 0n, amount: consom(150) },
        ];
        const caps = await env.minter.getCaps();
        for (const c of rewards) {
            const r = await env.claim(env.voucher(c));
            assert.equal(rejectReason(r), Reject.NOT_ELIGIBLE, `type ${c.kind}\n${describeTxs(r)}`);
        }
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.deepEqual({ ...(await env.minter.getCaps()), dayMinted: 0n }, { ...caps, dayMinted: 0n }, 'toutes les réservations sont rendues');
        await env.becomeEligible();
        for (const c of rewards) {
            const r = await env.claim(env.voucher(c));
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `type ${c.kind}\n${describeTxs(r)}`);
        }
        assert.equal(await env.balanceOf(env.member.address), consom(3000 + 50 + 40 + 3 + 500 + 150 + 150));
    });

    it('le pack de prévente lui-même ne demande aucune condition', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher());
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
    });

    it('bonus de 1er achat une seule fois par membre', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n }));
        const r = await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n }));
        assert.equal(rejectReason(r), Reject.ALREADY_DONE, describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(3000 + 500));
    });

    it('les missions exigent la prévente et ne se reçoivent qu\'une fois', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.equal(rejectReason(r), Reject.NOT_ELIGIBLE, describeTxs(r));
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        const r2 = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.equal(rejectReason(r2), Reject.ALREADY_DONE, describeTxs(r2));
        const r3 = await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) }));
        assert.ok(hasTx(r3, { op: Op.MintApproved, success: true }), describeTxs(r3));
    });

    it('la récompense de conversion ne dépasse jamais les Points attestés', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 600n, waveAmount: 0n, amount: consom(30) }));
        const r = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 600n, waveAmount: 0n, amount: consom(30) }));
        assert.equal(rejectReason(r), Reject.NOT_ENOUGH_POINTS, describeTxs(r));
        const ok = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 400n, waveAmount: 0n, amount: consom(20) }));
        assert.ok(hasTx(ok, { op: Op.MintApproved, success: true }), describeTxs(ok));
        assert.equal((await env.memberState(1n))!.convertedPoints, 1000n);
    });

    it('un bon de conversion déjà utilisé, ou plus ancien qu\'un bon utilisé, est refusé', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const v = env.voucher({ kind: Kind.CONVERSION, points: 100n, waveAmount: 0n, amount: consom(5) });
        await env.claim(v);
        assert.equal(rejectReason(await env.claim(v)), Reject.STALE_VOUCHER);
        assert.equal(rejectReason(await env.claim({ ...v, voucherId: v.voucherId - 1n })), Reject.STALE_VOUCHER);
    });

    it('le bonus d\'investissement (0,04 ConsoM par CHIKA) est limité à 30 % des Points attestés', async () => {
        const env = await setup();
        await env.becomeEligible();
        // 1 000 Points attestés : le total des bonus d'investissement ne peut pas dépasser 300 ConsoM
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 4500n, amount: consom(180) }));
        const r = await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 3750n, amount: consom(150) }));   // 180 + 150 > 300
        assert.equal(rejectReason(r), Reject.NOT_ENOUGH_POINTS, describeTxs(r));
        const ok = await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 3000n, amount: consom(120) }));   // 180 + 120 = 300 pile
        assert.ok(hasTx(ok, { op: Op.MintApproved, success: true }), describeTxs(ok));
    });

    it('les Points d\'un achat se convertissent dans les 7 jours, sinon ils sont perdus', async () => {
        const env = await setup();
        await env.becomeEligible();
        const record = (points: bigint) => env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points, waveAmount: points * 2n, amount: 0n }));
        const convert = (points: bigint) => env.claim(env.voucher({ kind: Kind.CONVERSION, points, waveAmount: 0n, amount: points * consom(5) / 100n }));
        await record(1000n);
        env.blockchain.now = T0 + 6 * DAY;
        assert.ok(hasTx(await convert(600n), { op: Op.MintApproved, success: true }), 'J+6 : accepté');
        assert.equal((await env.memberState(1n))!.availablePoints, 400n);
        env.blockchain.now = T0 + 7 * DAY;
        assert.equal(rejectReason(await convert(400n)), Reject.NOT_ENOUGH_POINTS, 'J+7 : les 400 Points restants ont expiré');
        assert.equal((await env.memberState(1n))!.availablePoints, 0n);
        assert.equal(await env.balanceOf(env.member.address), consom(3000 + 30));
    });

    it('une conversion utilise d\'abord les Points les plus proches de l\'expiration', async () => {
        const env = await setup();
        await env.becomeEligible();
        const record = (points: bigint) => env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points, waveAmount: points * 2n, amount: 0n }));
        const convert = (points: bigint) => env.claim(env.voucher({ kind: Kind.CONVERSION, points, waveAmount: 0n, amount: points * consom(5) / 100n }));
        await record(500n);                       // expire à J+7
        env.blockchain.now = T0 + 3 * DAY;
        await record(500n);                       // expire à J+10
        env.blockchain.now = T0 + 6 * DAY;
        assert.ok(hasTx(await convert(700n), { op: Op.MintApproved, success: true }), '500 anciens + 200 récents');
        env.blockchain.now = T0 + 8 * DAY;        // les anciens auraient expiré : il reste 300 récents
        assert.equal((await env.memberState(1n))!.availablePoints, 300n);
        assert.ok(hasTx(await convert(300n), { op: Op.MintApproved, success: true }));
        assert.equal(rejectReason(await convert(1n)), Reject.NOT_ENOUGH_POINTS);
        assert.equal((await env.memberState(1n))!.convertedPoints, 1000n);
    });

    it('plafond de 50 000 ConsoM par membre et par 24 h (hors prévente)', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité (prévente, hors plafond)
        await env.claim(env.voucher(referral(1_800_000n)));   // 45 000
        const over = await env.claim(env.voucher(referral(240_000n)));   // 6 000 : 51 000 > 50 000
        assert.equal(rejectReason(over), Reject.DAILY_CAP, describeTxs(over));
        assert.equal((await env.memberState(1n))!.dayReceived, consom(45_000));
        env.blockchain.now = T0 + DAY + 1;
        const next = await env.claim(env.voucher(referral(240_000n)));
        assert.ok(hasTx(next, { op: Op.MintApproved, success: true }), 'le lendemain : accepté');
        assert.equal(await env.balanceOf(env.member.address), consom(3000 + 45_000 + 6_000));
    });

    it('le budget et le compte membre gardent 0,01 TON pour leurs frais de stockage', async () => {
        const env = await setup();
        const v = env.voucher();
        await env.claim(v);
        for (const address of [await env.minter.getChildAddress(false, 1n), await env.minter.getChildAddress(true, v.waveRef)]) {
            const balance = (await env.blockchain.getContract(address)).balance;
            assert.ok(balance >= toNano('0.009') && balance <= toNano('0.011'), `solde ${balance}`);
        }
    });

    it('n\'accepte de bons que de l\'émetteur', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        const account = await env.minter.getChildAddress(false, 1n);
        const r = await env.stranger.send({ to: account, value: toNano('0.2'), body: beginCell().storeUint(Op.CheckClaim, 32).storeUint(0, 64).endCell() });
        assert.ok(hasTx(r, { to: account, success: false, exitCode: 450 }), describeTxs(r));
    });
});
