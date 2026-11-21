// Lot E14a-2 (décision du 21 novembre 2026) : la réserve des Anciens Contributeurs passe de 5 000 000 à 15 000 000
// (13 456 000 pour la liste réelle + 1 544 000 de réserve pour d'éventuelles réclamations), pris sur la prévente
// (100 000 000 -> 90 000 000). L'offre maximale reste 250 000 000. Règle 70/30 inchangée : 10 500 000 dans la banque à la
// genèse (parts à attribuer), 4 500 000 dans la réserve des 30 %.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { setup, hasTx, describeTxs, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, Err, INITIAL_CAPS, assertValidMinterConfig } from '../wrappers/ConsoMMinter.ts';

const PRESALE_END = 18 * 30 * DAY;

async function withGenesis(overrides = {}) {
    const env = await setup(overrides);
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

describe('Lot E14a-2 : réserves', () => {
    it('prévente 90 000 000, Anciens Contributeurs 15 000 000, les autres inchangées, total exactement 250 000 000', async () => {
        const env = await setup();
        const c = await env.minter.getCaps();
        assert.equal(c.presale, consom(90_000_000));
        assert.equal(c.founders, consom(15_000_000));
        assert.equal(c.purchase, consom(55_000_000));
        assert.equal(c.referral, consom(45_000_000));
        assert.equal(c.missions, consom(19_900_000));
        assert.equal(c.team, consom(5_000_000));
        assert.equal(c.chika, consom(20_000_000));
        assert.equal(c.foundation, consom(100_000));
        const total = c.presale + c.founders + c.purchase + c.referral + c.missions + c.team + c.chika + c.foundation;
        assert.equal(total, consom(250_000_000));
        assert.equal((await env.minter.getJettonData()).totalSupply, 0n, 'rien de créé avant la genèse');
    });

    it('genèse : 10 500 000 dans la banque en parts à attribuer, 4 500 000 restent dans la réserve des 30 %', async () => {
        const env = await withGenesis();
        const c = await env.minter.getCaps();
        assert.equal(c.founderShares, consom(10_500_000));
        assert.equal(c.founders, consom(4_500_000));
        const bank = await env.bankState();
        assert.equal(bank.depositorStock, consom(10_500_000));
        assert.equal(bank.totalShares, consom(10_500_000));
        assert.equal(bank.unassignedShares, consom(10_500_000));
        assert.equal((await env.minter.getJettonData()).totalSupply, consom(10_600_000), '10 500 000 + 100 000 (Fondation)');
    });

    it('banque : plafond de conversion de 5 % par 24 h = 525 000 ConsoM sur un stock de 10 500 000', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points: 10n, waveAmount: 0n, amount: 0n }));   // ouvre la période
        assert.equal((await env.bankState()).dayCap, consom(525_000));
    });
});

describe('Lot E14a-2 : prévente plafonnée à 90 000 000', () => {
    it('une contribution du lancement anticipé au-delà de 90 000 000 est refusée (montant)', async () => {
        const env = await withGenesis({ earlyContributionsTotal: consom(90_000_000) });
        const r = await env.claim(env.voucher({ kind: Kind.EARLY_CONTRIBUTION, amount: consom(90_000_000) + 10n, waveRef: 0xe1n, waveAmount: 0n, points: 0n }));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.WRONG_AMOUNT }), describeTxs(r));
    });

    it('le total gravé des contributions du lancement anticipé ne peut pas dépasser 90 000 000', async () => {
        const env = await setup();
        const minter = env.minter.address;
        assert.throws(() => assertValidMinterConfig({ ...env.config, earlyContributionsTotal: consom(90_000_000) + 1n }, minter, env.bankAddress), /90 000 000/);
        assert.doesNotThrow(() => assertValidMinterConfig({ ...env.config, earlyContributionsTotal: consom(90_000_000) }, minter, env.bankAddress));
    });

    it('règle des invendus à T0 + 18 mois sur 90 000 000 : 50 % retirés, 25 % aux achats, 25 % au parrainage', async () => {
        const env = await setup();
        await env.claim(env.voucher());                                    // 5 000 vendus
        env.blockchain.now = T0 + PRESALE_END;
        const c = await env.minter.getCaps();
        assert.equal(c.presaleSettled, true);
        assert.equal(c.presale, 0n);
        // reste : 89 995 000 -> 22 498 750 aux achats, 22 498 750 au parrainage, 44 997 500 retirés
        assert.equal(c.purchase, consom(55_000_000 + 22_498_750));
        assert.equal(c.referral, consom(45_000_000 + 22_498_750));
    });

    it('retenue du lancement anticipé (earlyHold) de 20 000 000 : la règle des invendus ne s\'applique qu\'aux 70 000 000 restants', async () => {
        const env = await setup({ earlyContributionsTotal: consom(20_000_000) });
        env.blockchain.now = T0 + PRESALE_END;
        const c = await env.minter.getCaps();
        assert.equal(c.presaleSettled, true);
        assert.equal(c.presale, consom(20_000_000), 'la retenue reste dans la réserve de prévente');
        assert.equal(c.purchase, consom(55_000_000 + 17_500_000));
        assert.equal(c.referral, consom(45_000_000 + 17_500_000));
        assert.equal(INITIAL_CAPS.presale, consom(90_000_000));
    });

    it('retenue de 20 000 000 avant 18 mois : un pack de prévente ne peut prendre que les 70 000 000 hors retenue', async () => {
        const env = await setup({ earlyContributionsTotal: consom(20_000_000), testCaps: { presale: consom(20_000_000) + consom(3_000) } });
        const r = await env.claim(env.voucher());                         // pack de 5 000 : seuls 3 000 hors retenue
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        assert.ok(!hasTx(r, { op: Op.MintApproved }));
    });
});
