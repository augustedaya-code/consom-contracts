// Lot E14 (décision du 11 novembre 2026) : la banque d'échange pendant la phase de test (réseau d'essai) et au lancement
// sur le réseau principal.
//   - Réseau d'essai : tout membre peut DÉPOSER dès T0 ; personne ne peut RETIRER avant T0 + 12 mois ; les dépôts reçoivent des
//     parts (ce sont elles qui comptent pour la part des frais). Anciens Contributeurs : 70 % en parts dès la genèse, 30 % libres.
//   - Réseau principal : dépôts acceptés 30 jours après le lancement (T0), refusés ensuite jusqu'à T0 + 12 mois, acceptés après ;
//     retraits refusés avant T0 + 12 mois. Les placements de la phase de test sont recréés 1 pour 1 (bon type 13).
// Le MÊME code sert aux deux réseaux : seule la fenêtre de dépôt diffère, déduite du réseau gravé (networkId).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err, NETWORK_MAINNET, ConsoMMinter, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';
import type { TestPlacements } from '../wrappers/ConsoMMinter.ts';

const GENESIS = consom(3_500_000);
const YEAR = 365 * DAY;
const REJECT_ALREADY_DONE = 13;
const REJECT_FORBIDDEN = 17;

const founderVoucher = (env: Env, total: bigint, id: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: total, waveRef: 0n, waveAmount: 0n, points: 0n, memberId: id, recipient });
const placementVoucher = (env: Env, amount: bigint, id: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.TEST_PLACEMENT, amount, waveRef: 0n, waveAmount: 0n, points: 0n, memberId: id, recipient });
const bankConversion = (env: Env, points: bigint, memberId = 99n) =>
    env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points, waveAmount: 0n, amount: 0n, memberId }));

// Le dépôt a-t-il été accepté (parts créées) ou rendu (jetons revenus) ?
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

async function mainnet(testPlacements?: TestPlacements, overrides = {}) {
    const env = await setup({ networkId: NETWORK_MAINNET, testPlacements, ...overrides });
    await env.minter.sendGenesis(env.deployer.getSender(), toNano(testPlacements ? '0.4' : '0.3'));
    return env;
}

describe('Lot E14 — phase de test (réseau d\'essai)', () => {
    it('la banque dit publiquement sa règle : dépôts ouverts dès T0, retraits à T0 + 12 mois', async () => {
        const env = await testnet();
        const st = await env.bankState();
        assert.equal(st.depositsOpen, true);
        assert.equal(st.isOpen, false, 'retraits fermés');
        assert.equal(st.depositsUntil, T0 + YEAR, 'réseau d\'essai : la première fenêtre de dépôt couvre les 12 mois');
        assert.equal(st.withdrawalsFrom, T0 + YEAR);
    });

    it('tout membre peut déposer dès le début et pendant toute la phase de test ; il reçoit des parts', async () => {
        const env = await testnet();
        await env.claim(env.voucher());                                      // prévente : 5 000 ConsoM
        assert.ok(await depositAccepted(env, env.member, consom(1000)), 'dépôt le jour du lancement du test');
        env.blockchain.now = T0 + 180 * DAY;                                 // fin des 6 mois de test
        assert.ok(await depositAccepted(env, env.member, consom(500)), 'dépôt à 6 mois');
        const share = await env.shareState(env.member.address);
        assert.equal(share!.shares, consom(1500), '1 part = 1 ConsoM tant que rien n\'est brûlé');
    });

    it('personne ne peut retirer pendant la phase de test : les parts sont rétablies', async () => {
        const env = await testnet();
        await env.claim(env.voucher());
        await env.deposit(env.member, consom(1000));
        env.blockchain.now = T0 + 180 * DAY;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(r));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(1000), 'parts rétablies');
        assert.equal(await env.balanceOf(env.member.address), consom(4000));
    });

    it('part des frais : chaque déposant a des parts au prorata de son dépôt, et perd la même proportion quand la banque brûle', async () => {
        const env = await testnet();
        await env.claim(env.voucher());                                                     // membre : 5 000
        await env.claim(env.voucher({ recipient: env.stranger.address, memberId: 2n }));     // autre membre : 5 000
        await env.deposit(env.member, consom(3000));
        await env.deposit(env.stranger, consom(1000));
        const st = await env.bankState();
        assert.equal(st.totalShares, GENESIS + consom(4000));
        const a = (await env.shareState(env.member.address))!.shares;
        const b = (await env.shareState(env.stranger.address))!.shares;
        assert.equal(a, consom(3000));
        assert.equal(b, consom(1000));
        // les 10 % de frais (hors chaîne) se répartissent au prorata des parts publiées : 3 000 / 3 504 000 et 1 000 / 3 504 000
        assert.equal(a, 3n * b, 'le premier touche 3 fois plus de frais que le second');

        await bankConversion(env, 1_000_000n);                               // 100 000 brûlés sur le stock des déposants
        const after = await env.bankState();
        assert.equal(after.totalShares, st.totalShares, 'les parts ne bougent pas');
        assert.equal(await env.minter.getState().then((s) => s.burnedByConversion), consom(100_000));
        // valeur d'un dépôt = parts × stock / total des parts : même proportion perdue pour tous
        const valueA = (a * after.depositorStock) / after.totalShares;
        const valueB = (b * after.depositorStock) / after.totalShares;
        assert.equal(valueA / 3n, valueB);
    });

    it('Anciens Contributeurs : 70 % placés d\'office dès le début du test, 30 % libres ; ils peuvent ajouter, pas retirer', async () => {
        const env = await testnet();
        // au début de la phase de test, le serveur présente le bon de chaque Ancien Contributeur (il paie les frais)
        const r = await env.claim(founderVoucher(env, consom(100_000), 777n), { from: env.stranger, value: toNano('0.5') });
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(30_000), '30 % dans son portefeuille');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000), '70 % en parts de la banque');
        assert.equal((await env.bankState()).unassignedShares, GENESIS - consom(70_000));

        assert.ok(await depositAccepted(env, env.member, consom(10_000)), 'il peut placer une partie de ses 30 %');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(80_000));

        env.blockchain.now = T0 + 180 * DAY;
        const w = await env.withdraw(env.member);
        assert.ok(hasTx(w, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(w));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(80_000));
    });
});

describe('Lot E14 — réseau principal : les 12 mois partent du lancement', () => {
    it('la banque dit publiquement sa règle : 30 jours de dépôts, puis rien jusqu\'à 12 mois', async () => {
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
        assert.equal(await depositAccepted(env, env.member, consom(100)), false, '30 jours passés : rendu');
        assert.equal((await env.bankState()).depositsOpen, false);
        env.blockchain.now = T0 + YEAR - 1;
        assert.equal(await depositAccepted(env, env.member, consom(100)), false, 'juste avant 12 mois : rendu');
        env.blockchain.now = T0 + YEAR;
        assert.ok(await depositAccepted(env, env.member, consom(100)), '12 mois : de nouveau ouvert');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(300));
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

    it('un Ancien Contributeur est recréé à l\'identique (genèse + même bon) et peut ajouter pendant les 30 jours', async () => {
        const env = await mainnet();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        env.blockchain.now = T0 + 10 * DAY;
        assert.ok(await depositAccepted(env, env.member, consom(5000)));
        env.blockchain.now = T0 + 40 * DAY;
        assert.equal(await depositAccepted(env, env.member, consom(5000)), false);
    });
});

describe('Lot E14 — recréation des placements de la phase de test au réseau principal', () => {
    const P: TestPlacements = {
        presale: consom(6000), purchase: consom(2000), referral: consom(1000),
        missions: consom(500), chika: consom(300), founders: consom(200),
    };
    const TOTAL = consom(10_000);

    it('la genèse prend chaque montant dans SA réserve et met le total dans la banque comme parts à recréer', async () => {
        const env = await mainnet(P);
        assert.deepEqual(await env.minter.getTestPlacements(), P, 'liste gravée, lisible par tous');
        const caps = await env.minter.getCaps();
        assert.equal(caps.presale, INITIAL_CAPS.presale - P.presale);
        assert.equal(caps.purchase, INITIAL_CAPS.purchase - P.purchase);
        assert.equal(caps.referral, INITIAL_CAPS.referral - P.referral);
        assert.equal(caps.missions, INITIAL_CAPS.missions - P.missions);
        assert.equal(caps.chika, INITIAL_CAPS.chika - P.chika);
        assert.equal(caps.founders, INITIAL_CAPS.founders - GENESIS - P.founders);
        assert.equal(caps.placementShares, TOTAL);
        assert.equal(caps.founderShares, GENESIS, 'les parts des Anciens Contributeurs ne sont pas touchées');
        const st = await env.bankState();
        assert.equal(st.depositorStock, GENESIS + TOTAL);
        assert.equal(st.unassignedShares, GENESIS + TOTAL);
        assert.equal((await env.minter.getState()).totalSupply, GENESIS + consom(100_000) + TOTAL, 'rien d\'autre n\'est créé');
    });

    it('un placement est recréé 1 pour 1 en parts, sans créer de ConsoM, une seule fois par membre', async () => {
        const env = await mainnet(P);
        const supply = (await env.minter.getState()).totalSupply;
        const r = await env.claim(placementVoucher(env, consom(2500), 42n), { from: env.stranger, value: toNano('0.5') });
        assert.ok(hasTx(r, { op: Op.AssignFounderShares, success: true }), describeTxs(r));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(2500), '2 500 ConsoM placés = 2 500 parts = 2 500 ConsoM');
        assert.equal(await env.balanceOf(env.member.address), 0n, 'rien dans le portefeuille');
        assert.equal((await env.minter.getState()).totalSupply, supply, 'aucun ConsoM créé au moment du bon');
        assert.equal((await env.minter.getCaps()).placementShares, TOTAL - consom(2500));
        assert.equal((await env.bankState()).unassignedShares, GENESIS + TOTAL - consom(2500));

        const again = await env.claim(placementVoucher(env, consom(2500), 42n));
        assert.equal(rejectReason(again), REJECT_ALREADY_DONE, describeTxs(again));
        assert.equal((await env.minter.getCaps()).placementShares, TOTAL - consom(2500), 'réservation rendue');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(2500));

        // les parts recréées suivent la règle des 12 mois, puis valent exactement le placement
        env.blockchain.now = T0 + YEAR;
        await env.withdraw(env.member);
        assert.equal(await env.balanceOf(env.member.address), consom(2500));
    });

    it('jamais plus que la liste : au-delà des parts à recréer, refus', async () => {
        const env = await mainnet(P);
        const r = await env.claim(placementVoucher(env, TOTAL + 1n, 42n));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.NO_PLACEMENT_SHARES }), describeTxs(r));
    });

    it('réseau d\'essai (aucun placement gravé) : refusé ; avant la genèse : refusé', async () => {
        const env = await testnet();
        const r = await env.claim(placementVoucher(env, consom(100), 42n));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.NO_PLACEMENT_SHARES }), describeTxs(r));
        const fresh = await setup({ networkId: NETWORK_MAINNET, testPlacements: P });
        const r2 = await fresh.claim(placementVoucher(fresh, consom(100), 42n));
        assert.ok(hasTx(r2, { to: fresh.minter.address, success: false, exitCode: Err.GENESIS_NOT_DONE }), describeTxs(r2));
    });

    it('destinataire interdit : refusé (raison 17), les parts à recréer sont rendues', async () => {
        const relay = (await (await Blockchain.create()).treasury('relay')).address;
        const env = await mainnet(P, { forbiddenRecipients: [relay] });
        const r = await env.claim(placementVoucher(env, consom(100), 42n, relay));
        assert.equal(rejectReason(r), REJECT_FORBIDDEN, describeTxs(r));
        assert.equal((await env.minter.getCaps()).placementShares, TOTAL);
    });

    it('une liste qu\'une réserve ne peut pas couvrir est refusée avant le déploiement', async () => {
        const env = await setup();
        const bad = { ...P, chika: INITIAL_CAPS.chika + 1n };
        assert.throws(() => ConsoMMinter.createFromConfig({ ...env.config, networkId: NETWORK_MAINNET, testPlacements: bad }, env.codes.minterCode),
            /réserve « chika »/);
    });
});
