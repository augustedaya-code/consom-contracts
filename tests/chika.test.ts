// Tests du Bonus CHIKA : 10 % du montant payé en CHIKA, puisé dans une réserve à part de 20 M (lot B2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, Err, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

// Bon de bonus pour `paid` CHIKA payés ; le montant est celui que le contrat doit retrouver (10 %)
const bonus = (paid: bigint) => ({ kind: Kind.CHIKA_BONUS, waveAmount: paid, points: 0n, amount: (paid * consom(1)) / 10n });

const approved = (r: any) => hasTx(r, { to: undefined, op: Op.MintApproved, success: true });

describe('Bonus CHIKA', () => {
    it('crée 10 % du montant payé en CHIKA, uniquement dans la réserve CHIKA', async () => {
        const env = await setup();
        const before = await env.minter.getCaps();
        const r = await env.claim(env.voucher(bonus(2000n)));
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(200));
        const after = await env.minter.getCaps();
        assert.equal(after.chika, INITIAL_CAPS.chika - consom(200));
        for (const k of ['presale', 'purchase', 'referral', 'missions', 'founders', 'team'] as const) {
            assert.equal(after[k], before[k], `la réserve ${k} ne doit pas bouger`);
        }
    });

    it('calcule juste sur des montants qui ne tombent pas rond', async () => {
        const env = await setup();
        for (const paid of [1n, 7n, 12_345n]) {
            const r = await env.claim(env.voucher(bonus(paid)));
            assert.ok(approved(r), `${paid} CHIKA\n${describeTxs(r)}`);
        }
        // 0,1 + 0,7 + 1 234,5 ConsoM
        assert.equal(await env.balanceOf(env.member.address), 100_000_000n + 700_000_000n + 1_234_500_000_000n);
    });

    it('refuse un montant différent de 10 %', async () => {
        const env = await setup();
        const v = env.voucher(bonus(2000n));
        const r = await env.claim({ ...v, amount: v.amount + 1n });
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.WRONG_AMOUNT }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), 0n);
    });

    it('réserve épuisée : refus clair, rien n\'est créé, les autres réserves ne bougent pas', async () => {
        const env = await setup({ testCaps: { chika: consom(100) } });
        const before = await env.minter.getCaps();
        const r = await env.claim(env.voucher(bonus(2000n)));   // 200 > 100
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal((await env.minter.getState()).totalSupply, 0n);
        assert.deepEqual(await env.minter.getCaps(), before);
        assert.equal(await env.budgetState(env.voucher().waveRef - 1n), null, 'aucun budget créé');
    });

    it('s\'arrête tout seul : le dernier bonus vide la réserve, le suivant est refusé', async () => {
        const env = await setup({ testCaps: { chika: consom(100) } });
        assert.ok(approved(await env.claim(env.voucher(bonus(1000n)))));   // 100 : pile la réserve
        assert.equal((await env.minter.getCaps()).chika, 0n);
        const r = await env.claim(env.voucher(bonus(10n)));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        // les autres types de bons continuent de marcher
        assert.ok(approved(await env.claim(env.voucher())));
    });

    it('un même bon rejoué est refusé et la réserve est rendue', async () => {
        const env = await setup();
        const v = env.voucher(bonus(2000n));
        await env.claim(v);
        const r = await env.claim({ ...v, voucherId: 999n });   // même commande, autre numéro de bon
        assert.equal(rejectReason(r), 1, describeTxs(r));        // REJECT_SLOT_USED
        assert.equal(await env.balanceOf(env.member.address), consom(200));
        assert.equal((await env.minter.getCaps()).chika, INITIAL_CAPS.chika - consom(200));
    });

    it('respecte le plafond de 50 000 ConsoM par membre et par 24 h', async () => {
        const env = await setup();
        const over = await env.claim(env.voucher(bonus(600_000n)));   // 60 000 > 50 000
        assert.equal(rejectReason(over), 12, describeTxs(over));      // REJECT_DAILY_CAP
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal((await env.minter.getCaps()).chika, INITIAL_CAPS.chika, 'réservation rendue');
        assert.ok(approved(await env.claim(env.voucher(bonus(400_000n)))), '40 000 passent');
    });

    it('suit la fenêtre des récompenses (18 mois) comme les autres bons', async () => {
        const env = await setup();
        env.blockchain.now = T0 + 18 * 30 * DAY;
        const r = await env.claim(env.voucher({ ...bonus(2000n), validUntil: T0 + 18 * 30 * DAY + 3600 }));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.WINDOW_CLOSED }), describeTxs(r));
    });

    it('refuse un type de bon inconnu (le suivant, 11)', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: 11, amount: 0n }));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.UNKNOWN_KIND }), describeTxs(r));
    });
});
