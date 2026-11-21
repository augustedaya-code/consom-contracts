// Lot E14 (décisions du 11 novembre 2026) : la banque d'échange pendant la phase de test et au lancement du réseau principal,
// et la recréation 1 pour 1 de tous les ConsoM de la phase de test.
//   - Réseau d'essai (phase de test, 6 mois) : la banque est FERMÉE aux dépôts des membres (ConsoM renvoyés) ; elle ne contient
//     que les 70 % des Anciens Contributeurs, placés par la genèse et attribués par leur bon (30 % dans leur portefeuille).
//     Personne ne retire.
//   - Réseau principal : dépôts ouverts 30 jours après le lancement (T0), puis fermés jusqu'à T0 + 12 mois ; aucun retrait
//     avant T0 + 12 mois (Anciens Contributeurs compris).
//   - Recréation au réseau principal, 1 pour 1, une seule fois par membre, chaque ConsoM repris dans sa réserve d'origine :
//       * banque : les 70 % des Anciens Contributeurs (genèse + bon type 11) et ceux des contributeurs de la prévente (bon type 12) ;
//       * portefeuilles : les 30 % (mêmes bons) et tous les autres ConsoM, par la liste publiée (bon type 13).
// Le MÊME code sert aux deux réseaux : seule la fenêtre de dépôt diffère, déduite du réseau gravé (networkId).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err, NETWORK_MAINNET, ConsoMMinter, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';
import type { TestCarry } from '../wrappers/ConsoMMinter.ts';

const GENESIS = consom(10_500_000);
const FOUNDATION = consom(100_000);
const YEAR = 365 * DAY;
const REJECT_ALREADY_DONE = 13;
const REJECT_FORBIDDEN = 17;

const founderVoucher = (env: Env, total: bigint, id: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: total, waveRef: 0n, waveAmount: 0n, points: 0n, memberId: id, recipient });
const earlyVoucher = (env: Env, total: bigint, ref: bigint, memberId: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.EARLY_CONTRIBUTION, amount: total, waveRef: ref, waveAmount: 0n, points: 0n, memberId, recipient });
const carryVoucher = (env: Env, amount: bigint, memberId: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.TEST_CARRY, amount, waveRef: 0n, waveAmount: 0n, points: 0n, memberId, recipient });

// Le dépôt a-t-il été accepté (parts créées) ou renvoyé (jetons revenus, stock inchangé) ?
async function depositAccepted(env: Env, who: any, amount: bigint): Promise<boolean> {
    const before = await env.balanceOf(who.address);
    const stockBefore = (await env.bankState()).depositorStock;
    await env.deposit(who, amount);
    const after = await env.balanceOf(who.address);
    const stockAfter = (await env.bankState()).depositorStock;
    if (after === before && stockAfter === stockBefore) return false;
    assert.equal(after, before - amount, 'dépôt accepté : les jetons quittent le wallet');
    assert.equal(stockAfter, stockBefore + amount, 'dépôt accepté : le stock des déposants monte');
    return true;
}

async function testnet() {
    const env = await setup();
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

async function mainnet(overrides = {}) {
    const env = await setup({ networkId: NETWORK_MAINNET, ...overrides });
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

describe('Lot E14 — phase de test (réseau d\'essai) : banque fermée aux dépôts des membres', () => {
    it('la banque publie sa règle : aucun dépôt, retraits à T0 + 12 mois', async () => {
        const env = await testnet();
        const st = await env.bankState();
        assert.equal(st.depositsOpen, false);
        assert.equal(st.isOpen, false, 'retraits fermés');
        assert.equal(st.depositsUntil, T0, 'réseau d\'essai : pas de première fenêtre de dépôt');
        assert.equal(st.withdrawalsFrom, T0 + YEAR);
    });

    it('le dépôt d\'un membre est refusé pendant toute la phase de test : ses ConsoM lui sont renvoyés', async () => {
        const env = await testnet();
        await env.claim(env.voucher());                                      // prévente : 5 000 ConsoM
        assert.equal(await depositAccepted(env, env.member, consom(1000)), false, 'jour du début du test');
        env.blockchain.now = T0 + 180 * DAY;                                 // fin des 6 mois de test
        assert.equal(await depositAccepted(env, env.member, consom(1000)), false, 'à 6 mois');
        assert.equal(await env.balanceOf(env.member.address), consom(5000), 'tout est revenu');
        assert.equal(await env.shareState(env.member.address), null, 'aucune part');
        assert.equal((await env.bankState()).depositorStock, GENESIS, 'la banque ne contient que la genèse');
    });

    it('Anciens Contributeurs : 70 % placés d\'office dès le début du test, 30 % dans le portefeuille ; personne ne retire', async () => {
        const env = await testnet();
        // au début de la phase de test, le serveur présente le bon de chaque Ancien Contributeur (il paie les frais)
        const r = await env.claim(founderVoucher(env, consom(100_000), 777n), { from: env.stranger, value: toNano('0.5') });
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(30_000), '30 % dans son portefeuille');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000), '70 % en parts de la banque');
        const st = await env.bankState();
        assert.equal(st.depositorStock, GENESIS, 'ces 70 % étaient déjà dans la banque (genèse) : rien n\'est ajouté');
        assert.equal(st.unassignedShares, GENESIS - consom(70_000));

        assert.equal(await depositAccepted(env, env.member, consom(10_000)), false, 'il ne peut pas ajouter ses 30 % pendant le test');
        env.blockchain.now = T0 + 180 * DAY;
        const w = await env.withdraw(env.member);
        assert.ok(hasTx(w, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(w));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000), 'parts rétablies');
    });
});

describe('Lot E14 — réseau principal : les 12 mois partent du lancement', () => {
    it('la banque publie sa règle : 30 jours de dépôts, puis rien jusqu\'à 12 mois', async () => {
        const env = await mainnet();
        const st = await env.bankState();
        assert.equal(st.depositsOpen, true);
        assert.equal(st.depositsUntil, T0 + 30 * DAY);
        assert.equal(st.withdrawalsFrom, T0 + YEAR);
    });

    it('dépôt accepté pendant les 30 jours après le lancement, refusé ensuite jusqu\'à 12 mois, accepté après', async () => {
        const env = await mainnet();
        await env.claim(env.voucher());                                      // 5 000 ConsoM
        assert.ok(await depositAccepted(env, env.member, consom(100)), 'jour du lancement');
        env.blockchain.now = T0 + 30 * DAY - 1;
        assert.ok(await depositAccepted(env, env.member, consom(100)), 'dernière seconde des 30 jours');
        env.blockchain.now = T0 + 30 * DAY;
        assert.equal(await depositAccepted(env, env.member, consom(100)), false, '30 jours passés : renvoyé');
        assert.equal((await env.bankState()).depositsOpen, false);
        env.blockchain.now = T0 + YEAR - 1;
        assert.equal(await depositAccepted(env, env.member, consom(100)), false, 'juste avant 12 mois : renvoyé');
        env.blockchain.now = T0 + YEAR;
        assert.ok(await depositAccepted(env, env.member, consom(100)), '12 mois : de nouveau ouvert');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(300), '1 part = 1 ConsoM');
    });

    it('retrait refusé avant 12 mois après le lancement, accepté après', async () => {
        const env = await mainnet();
        await env.claim(env.voucher());
        await env.deposit(env.member, consom(1000));
        env.blockchain.now = T0 + YEAR - 1;
        const early = await env.withdraw(env.member);
        assert.ok(hasTx(early, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(early));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(1000), 'parts rétablies');
        env.blockchain.now = T0 + YEAR;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(5000));
    });

    it('Anciens Contributeurs : peuvent ajouter pendant les 30 jours, pas après ; aucun retrait avant 12 mois après le lancement', async () => {
        const env = await mainnet();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        env.blockchain.now = T0 + 10 * DAY;
        assert.ok(await depositAccepted(env, env.member, consom(5000)));
        env.blockchain.now = T0 + 40 * DAY;
        assert.equal(await depositAccepted(env, env.member, consom(5000)), false);
        env.blockchain.now = T0 + 300 * DAY;
        const w = await env.withdraw(env.member);
        assert.ok(hasTx(w, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(w));
        env.blockchain.now = T0 + YEAR;
        const ok = await env.withdraw(env.member);
        assert.ok(hasTx(ok, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(ok));
        assert.equal(await env.balanceOf(env.member.address), consom(100_000), '30 % + 5 000 ajoutés - 5 000 + 75 000 retirés');
    });
});

describe('Lot E14 — recréation 1 pour 1 au réseau principal (portefeuilles et banque)', () => {
    // ConsoM des portefeuilles de la phase de test hors prévente et Anciens Contributeurs, par réserve d'origine
    const C: TestCarry = { purchase: consom(6000), referral: consom(2000), missions: consom(1500), chika: consom(500) };
    const TOTAL = consom(10_000);

    it('banque : les 70 % d\'un Ancien Contributeur sont recréés à l\'identique (genèse + même bon), 30 % dans le portefeuille', async () => {
        const env = await mainnet();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        assert.equal((await env.bankState()).depositorStock, GENESIS);
        const again = await env.claim(founderVoucher(env, consom(100_000), 777n));
        assert.equal(rejectReason(again), REJECT_ALREADY_DONE, 'une seule fois');
    });

    it('banque : un contributeur de la prévente du test est recréé 1 pour 1 (30 % portefeuille, 70 % en parts), une seule fois', async () => {
        const env = await mainnet({ earlyContributionsTotal: consom(20_000) });
        const r = await env.claim(earlyVoucher(env, consom(20_000), 0xe1n, 5n), { value: toNano('0.6') });
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(6000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000));
        assert.equal((await env.bankState()).depositorStock, GENESIS + consom(14_000));
        assert.equal((await env.minter.getCaps()).presale, INITIAL_CAPS.presale - consom(20_000), 'pris dans la réserve de prévente');
        const again = await env.claim(earlyVoucher(env, consom(20_000), 0xe1n, 5n), { value: toNano('0.6') });
        assert.ok(!hasTx(again, { op: Op.MintApproved, success: true }), 'une seule fois par contribution');
        assert.equal(await env.balanceOf(env.member.address), consom(6000));
    });

    it('portefeuilles : la genèse retire chaque montant de SA réserve, sans rien créer', async () => {
        const env = await mainnet({ testCarry: C });
        assert.deepEqual(await env.minter.getTestCarry(), C, 'liste gravée, lisible par tous');
        const caps = await env.minter.getCaps();
        assert.equal(caps.purchase, INITIAL_CAPS.purchase - C.purchase);
        assert.equal(caps.referral, INITIAL_CAPS.referral - C.referral);
        assert.equal(caps.missions, INITIAL_CAPS.missions - C.missions);
        assert.equal(caps.chika, INITIAL_CAPS.chika - C.chika);
        assert.equal(caps.presale, INITIAL_CAPS.presale, 'la prévente n\'est pas touchée (recréée par le bon type 12)');
        assert.equal(caps.carryPool, TOTAL);
        assert.equal((await env.minter.getState()).totalSupply, GENESIS + FOUNDATION, 'rien n\'est créé à la genèse pour les portefeuilles');
    });

    it('portefeuilles : la ligne d\'un membre est recréée 1 pour 1 dans son portefeuille, une seule fois', async () => {
        const env = await mainnet({ testCarry: C });
        const r = await env.claim(carryVoucher(env, consom(2500), 42n), { from: env.stranger });
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(2500), '2 500 ConsoM de test = 2 500 ConsoM');
        assert.equal((await env.minter.getCaps()).carryPool, TOTAL - consom(2500));
        assert.equal((await env.minter.getState()).totalSupply, GENESIS + FOUNDATION + consom(2500));

        const again = await env.claim(carryVoucher(env, consom(2500), 42n));
        assert.equal(rejectReason(again), REJECT_ALREADY_DONE, describeTxs(again));
        assert.equal((await env.minter.getCaps()).carryPool, TOTAL - consom(2500), 'réservation rendue');
        assert.equal(await env.balanceOf(env.member.address), consom(2500), 'rien de plus');
    });

    it('aucun ConsoM en plus : au-delà de la liste, refus ; la liste entière se recrée exactement', async () => {
        const env = await mainnet({ testCarry: C });
        const over = await env.claim(carryVoucher(env, TOTAL + 1n, 42n));
        assert.ok(hasTx(over, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(over));
        await env.claim(carryVoucher(env, consom(7000), 42n));
        await env.claim(carryVoucher(env, consom(3000), 43n, env.stranger.address));
        assert.equal((await env.minter.getCaps()).carryPool, 0n);
        const more = await env.claim(carryVoucher(env, 1n, 44n, env.team.address));
        assert.ok(hasTx(more, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(more));
        assert.equal((await env.minter.getState()).totalSupply, GENESIS + FOUNDATION + TOTAL);
    });

    it('réseau d\'essai (rien de gravé) ou avant la genèse : refusé', async () => {
        const env = await testnet();
        const r = await env.claim(carryVoucher(env, consom(100), 42n));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.CATEGORY_CAP }), describeTxs(r));
        const fresh = await setup({ networkId: NETWORK_MAINNET, testCarry: C });
        const r2 = await fresh.claim(carryVoucher(fresh, consom(100), 42n));
        assert.ok(hasTx(r2, { to: fresh.minter.address, success: false, exitCode: Err.GENESIS_NOT_DONE }), describeTxs(r2));
    });

    it('destinataire interdit : refusé (raison 17), la réserve « à recréer » est rendue', async () => {
        const relay = (await (await Blockchain.create()).treasury('relay')).address;
        const env = await mainnet({ testCarry: C, forbiddenRecipients: [relay] });
        const r = await env.claim(carryVoucher(env, consom(100), 42n, relay));
        assert.equal(rejectReason(r), REJECT_FORBIDDEN, describeTxs(r));
        assert.equal((await env.minter.getCaps()).carryPool, TOTAL);
    });

    it('une liste qu\'une réserve ne peut pas couvrir est refusée avant le déploiement', async () => {
        const env = await setup();
        const bad = { ...C, chika: INITIAL_CAPS.chika + 1n };
        assert.throws(() => ConsoMMinter.createFromConfig({ ...env.config, networkId: NETWORK_MAINNET, testCarry: bad }, env.codes.minterCode),
            /réserve « chika »/);
    });
});
