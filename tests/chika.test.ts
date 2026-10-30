// Tests du Bonus CHIKA : 0,3 % du montant payé en CHIKA (3 ConsoM pour 1 000), puisé dans une réserve à part de 20 M (lot B2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, Err, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

// Bon de bonus pour `paid` CHIKA payés ; le montant est celui que le contrat doit retrouver (0,3 %)
const bonus = (paid: bigint) => ({ kind: Kind.CHIKA_BONUS, waveAmount: paid, points: 0n, amount: (paid * consom(1) * 30n) / 10000n });

const approved = (r: any) => hasTx(r, { to: undefined, op: Op.MintApproved, success: true });

describe('Bonus CHIKA', () => {
    it('crée 0,3 % du montant payé en CHIKA (3 ConsoM pour 1 000), uniquement dans la réserve CHIKA', async () => {
        const env = await setup();
        await env.becomeEligible();
        const before = await env.minter.getCaps();
        const r = await env.claim(env.voucher(bonus(1000n)));
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + consom(3), '1 000 CHIKA payés -> 3 ConsoM');
        const after = await env.minter.getCaps();
        assert.equal(after.chika, INITIAL_CAPS.chika - consom(3));
        for (const k of ['presale', 'purchase', 'referral', 'missions', 'founders', 'team', 'foundation'] as const) {
            assert.equal(after[k], before[k], `la réserve ${k} ne doit pas bouger`);
        }
    });

    it('calcule juste sur des montants qui ne tombent pas rond', async () => {
        const env = await setup();
        await env.becomeEligible();
        for (const paid of [1n, 7n, 12_345n]) {
            const r = await env.claim(env.voucher(bonus(paid)));
            assert.ok(approved(r), `${paid} CHIKA\n${describeTxs(r)}`);
        }
        // 0,003 + 0,021 + 37,035 ConsoM
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + 3_000_000n + 21_000_000n + 37_035_000_000n);
    });

    it('refuse un montant différent de 0,3 %', async () => {
        const env = await setup();
        const v = env.voucher(bonus(2000n));
        const r = await env.claim({ ...v, amount: v.amount + 1n });
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.WRONG_AMOUNT }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), 0n);
    });

    it('réserve épuisée : refus clair, rien n\'est créé, les autres réserves ne bougent pas', async () => {
        const env = await setup({ testCaps: { chika: consom(100) } });
        const before = await env.minter.getCaps();
        const r = await env.claim(env.voucher(bonus(40_000n)));   // 120 > 100
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal((await env.minter.getState()).totalSupply, 0n);
        assert.deepEqual(await env.minter.getCaps(), before);
        assert.equal(await env.budgetState(env.voucher().waveRef - 1n), null, 'aucun budget créé');
    });

    it('s\'arrête tout seul : le dernier bonus vide la réserve, le suivant est refusé', async () => {
        const env = await setup({ testCaps: { chika: consom(99) } });
        await env.becomeEligible();
        assert.ok(approved(await env.claim(env.voucher(bonus(33_000n)))));   // 99 : pile la réserve
        assert.equal((await env.minter.getCaps()).chika, 0n);
        const r = await env.claim(env.voucher(bonus(10n)));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        // les autres types de bons continuent de marcher
        assert.ok(approved(await env.claim(env.voucher())));
    });

    it('un même bon rejoué est refusé et la réserve est rendue', async () => {
        const env = await setup();
        await env.becomeEligible();
        const v = env.voucher(bonus(2000n));
        await env.claim(v);
        const r = await env.claim({ ...v, voucherId: 999n });   // même commande, autre numéro de bon
        assert.equal(rejectReason(r), 1, describeTxs(r));        // REJECT_SLOT_USED
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + consom(6));
        assert.equal((await env.minter.getCaps()).chika, INITIAL_CAPS.chika - consom(6));
    });

    it('respecte le plafond de 50 000 ConsoM par membre et par 24 h', async () => {
        const env = await setup();
        await env.becomeEligible();
        const over = await env.claim(env.voucher(bonus(20_000_000n)));   // 60 000 > 50 000
        assert.equal(rejectReason(over), 12, describeTxs(over));      // REJECT_DAILY_CAP
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        assert.equal((await env.minter.getCaps()).chika, INITIAL_CAPS.chika, 'réservation rendue');
        assert.ok(approved(await env.claim(env.voucher(bonus(13_000_000n)))), '39 000 passent');
    });

    it('suit la fenêtre des récompenses (24 mois) comme les autres bons', async () => {
        const env = await setup();
        env.blockchain.now = T0 + 24 * 30 * DAY;
        const r = await env.claim(env.voucher({ ...bonus(2000n), validUntil: T0 + 24 * 30 * DAY + 3600 }));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.WINDOW_CLOSED }), describeTxs(r));
    });

    it('règle d\'équité : refusé sans prévente, réservation rendue ; accepté après une prévente', async () => {
        const env = await setup();
        const v = env.voucher(bonus(2000n));
        const refused = await env.claim(v);
        assert.equal(rejectReason(refused), 11, describeTxs(refused));   // REJECT_NOT_ELIGIBLE
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal((await env.minter.getCaps()).chika, INITIAL_CAPS.chika, 'réservation rendue');
        assert.equal((await env.budgetState(v.waveRef))!.slots, 0, 'emplacement libéré');
        await env.becomeEligible();
        assert.ok(approved(await env.claim({ ...v, validUntil: v.validUntil + 3600 })), 'même bon accepté après la prévente');
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + consom(6));
    });

    it('refuse un type de bon inconnu (le suivant, 12)', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: 12, amount: 0n }));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.UNKNOWN_KIND }), describeTxs(r));
    });
});
