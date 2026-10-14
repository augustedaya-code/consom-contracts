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
    const rate = [0n, 1500n, 700n, 350n, 150n, 50n][level];
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
        // 400 000 Points au niveau 1 = 60 000 ConsoM, dont 30 000 immédiats
        await env.claim(env.voucher(referral(400_000n)));
        const second = env.voucher({ ...referral(400_000n), validUntil: T0 + 3 * DAY });
        const r = await env.claim(second);
        assert.equal(rejectReason(r), Reject.DAILY_CAP, describeTxs(r));
        assert.equal((await env.budgetState(second.waveRef))!.slots, 0, 'emplacement libéré');
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(60_000), 'réservation libérée');
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

    it('bonus de 1er achat une seule fois par membre', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n }));
        const r = await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n }));
        assert.equal(rejectReason(r), Reject.ALREADY_DONE, describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(250));
    });

    it('les missions exigent un paiement attesté et ne se reçoivent qu\'une fois', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.equal(rejectReason(r), Reject.NO_PAYMENT, describeTxs(r));
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 10n, waveAmount: 20n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        const r2 = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.equal(rejectReason(r2), Reject.ALREADY_DONE, describeTxs(r2));
        const r3 = await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) }));
        assert.ok(hasTx(r3, { op: Op.MintApproved, success: true }), describeTxs(r3));
    });

    it('la récompense de conversion ne dépasse jamais les Points attestés', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 600n, waveAmount: 0n, amount: consom(210) }));
        const r = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 600n, waveAmount: 0n, amount: consom(210) }));
        assert.equal(rejectReason(r), Reject.NOT_ENOUGH_POINTS, describeTxs(r));
        const ok = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 400n, waveAmount: 0n, amount: consom(140) }));
        assert.ok(hasTx(ok, { op: Op.MintApproved, success: true }), describeTxs(ok));
        assert.equal((await env.memberState(1n))!.convertedPoints, 1000n);
    });

    it('un bon de conversion déjà utilisé, ou plus ancien qu\'un bon utilisé, est refusé', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const v = env.voucher({ kind: Kind.CONVERSION, points: 100n, waveAmount: 0n, amount: consom(35) });
        await env.claim(v);
        assert.equal(rejectReason(await env.claim(v)), Reject.STALE_VOUCHER);
        assert.equal(rejectReason(await env.claim({ ...v, voucherId: v.voucherId - 1n })), Reject.STALE_VOUCHER);
    });

    it('le bonus d\'investissement est limité à 30 % des Points attestés', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 600n, amount: consom(180) }));
        const r = await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 500n, amount: consom(150) }));
        assert.equal(rejectReason(r), Reject.NOT_ENOUGH_POINTS, describeTxs(r));
        const ok = await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 400n, amount: consom(120) }));
        assert.ok(hasTx(ok, { op: Op.MintApproved, success: true }), describeTxs(ok));
    });

    it('vesting : 50 % tout de suite, puis 10 % à J+30, J+60, J+90, J+120 et J+150', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(350) }));
        assert.equal(await env.balanceOf(env.member.address), consom(175));
        assert.equal((await env.memberState(1n))!.vestingLocked, consom(175));

        env.blockchain.now = T0 + 29 * DAY;
        const early = await env.claimVesting(1n);
        assert.ok(hasTx(early, { success: false, exitCode: 452 }), 'rien d\'échu avant J+30');

        env.blockchain.now = T0 + 30 * DAY;
        await env.claimVesting(1n);
        assert.equal(await env.balanceOf(env.member.address), consom(210));

        env.blockchain.now = T0 + 150 * DAY;
        await env.claimVesting(1n);
        assert.equal(await env.balanceOf(env.member.address), consom(350));
        const st = await env.memberState(1n);
        assert.equal(st!.vestingLocked + st!.vestingDue, 0n);
        assert.equal((await env.minter.getState()).totalSupply, consom(350));
    });

    it('seule l\'adresse liée peut réclamer le vesting', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(350) }));
        env.blockchain.now = T0 + 30 * DAY;
        const r = await env.claimVesting(1n, env.stranger);
        assert.ok(hasTx(r, { success: false, exitCode: 451 }), describeTxs(r));
    });

    it('les tranches de vesting comptent dans le plafond de 50 000 par 24 h', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité
        await env.claim(env.voucher(referral(300_000n)));   // 45 000 : 22 500 immédiats, 4 500 par tranche
        env.blockchain.now = T0 + 30 * DAY;
        await env.claim(env.voucher(referral(310_000n)));   // 46 500 : 23 250 immédiats
        const before = await env.balanceOf(env.member.address);
        await env.claimVesting(1n);
        // 50 000 - 23 250 = 26 750 autorisés, la tranche de 4 500 passe en entier
        assert.equal((await env.balanceOf(env.member.address)) - before, consom(4500));
        const over = await env.claim(env.voucher(referral(300_000n)));   // 22 500 immédiats > 50 000 - 27 750
        assert.equal(rejectReason(over), Reject.DAILY_CAP, describeTxs(over));
        assert.equal((await env.memberState(1n))!.dayReceived, consom(27_750));
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
