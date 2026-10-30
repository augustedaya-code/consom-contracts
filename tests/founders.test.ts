// Tests des Anciens Contributeurs (livre blanc v5.0, règle A8, et décisions du 30 octobre 2026) :
// bon signé 2 sur 3 -> 30 % de la part créés pour l'Ancien Contributeur, 70 % attribués en parts de la banque
// (prises dans les parts « à attribuer » de la genèse, sans créer de ConsoM), et le compte devient éligible.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err } from '../wrappers/ConsoMMinter.ts';

const GENESIS = consom(3_500_000);       // parts à attribuer au départ
const FOUNDATION = consom(100_000);      // réserve de la Fondation, créée à la genèse dans un stock à part
const DIRECT_RESERVE = consom(1_500_000); // réserve des 30 %
const REJECT_WRONG_OWNER = 10;
const REJECT_NOT_ELIGIBLE = 11;
const REJECT_ALREADY_DONE = 13;

const approved = (r: any) => hasTx(r, { op: Op.MintApproved, success: true });
const refusedWith = (r: any, minter: any, code: number) =>
    assert.ok(hasTx(r, { to: minter, success: false, exitCode: code }), `refus attendu (code ${code})\n${describeTxs(r)}`);

async function withGenesis(overrides = {}) {
    const env = await setup(overrides);
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

// Bon d'Ancien Contributeur : `total` = part totale T, `id` = empreinte de l'identifiant (jamais de nom ni de numéro en clair)
const founderVoucher = (env: Env, total: bigint, id: bigint, recipient = env.member.address) =>
    env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: total, waveRef: 0n, waveAmount: 0n, points: 0n, memberId: id, recipient });

describe('Anciens Contributeurs : réclamation', () => {
    it('crée 30 % de T pour l\'Ancien Contributeur et lui attribue 70 % en parts de la banque', async () => {
        const env = await withGenesis();
        const T = consom(100_000);
        const r = await env.claim(founderVoucher(env, T, 777n));
        assert.ok(approved(r), describeTxs(r));

        // 30 % créés dans son wallet
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
        const caps = await env.minter.getCaps();
        assert.equal(caps.founders, DIRECT_RESERVE - consom(30_000), 'pris dans la réserve Anciens Contributeurs');
        assert.equal((await env.minter.getJettonData()).totalSupply, GENESIS + FOUNDATION + consom(30_000), 'seuls les 30 % sont de nouveaux ConsoM');

        // 70 % en parts : prises dans les parts à attribuer, aucun ConsoM ne bouge dans la banque
        const bank = await env.bankState();
        assert.equal(bank.unassignedShares, GENESIS - consom(70_000));
        assert.equal(bank.totalShares, GENESIS, 'le total des parts ne change pas');
        assert.equal(bank.depositorStock, GENESIS, 'le stock de la banque ne change pas');
        assert.equal(await env.balanceOf(env.bankAddress), GENESIS + FOUNDATION);
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        assert.equal(caps.founderShares, GENESIS - consom(70_000), 'le compteur de l\'émetteur suit les parts à attribuer');
    });

    it('l\'Ancien Contributeur devient éligible (participant à la prévente) dans son compte membre', async () => {
        const env = await withGenesis();
        assert.equal(await env.memberState(777n), null);
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        const st = (await env.memberState(777n))!;
        assert.equal(st.referralEligible, true);
        assert.equal(st.flags & 8, 8, 'réclamation marquée');
        assert.equal(st.dayReceived, 0n, 'pas compté dans le plafond de 50 000 par 24 h');
        // preuve : une récompense qui exige la prévente (bonus de 1er achat) est maintenant acceptée
        const bonus = env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500), memberId: 777n });
        assert.ok(approved(await env.claim(bonus)), 'éligible grâce à la réclamation');
        assert.equal(await env.balanceOf(env.member.address), consom(30_000) + consom(500));
    });

    it('sans réclamation, le même membre est refusé (règle d\'équité)', async () => {
        const env = await withGenesis();
        const bonus = env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500), memberId: 777n });
        assert.equal(rejectReason(await env.claim(bonus)), REJECT_NOT_ELIGIBLE);
    });

    it('pas soumise au plafond de 50 000 par membre : 30 % de 400 000 = 120 000 d\'un coup', async () => {
        const env = await withGenesis();
        const r = await env.claim(founderVoucher(env, consom(400_000), 777n));
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(120_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(280_000));
    });

    it('compte dans le plafond global de 2 000 000 par 24 h (seuls les 30 % créés)', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        assert.equal((await env.minter.getCaps()).dayMinted, consom(30_000));
        // l'équipe libère 2 000 000 à T0 + 36 mois : le plafond du jour est alors atteint, la réclamation attend
        env.blockchain.now = T0 + 36 * 30 * DAY;
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        const r = await env.claim(founderVoucher(env, consom(100_000), 778n));
        refusedWith(r, env.minter.address, Err.DAILY_CAP);
        assert.equal(await env.memberState(778n), null, 'rien n\'est marqué : le bon reste utilisable');
        env.blockchain.now = T0 + 36 * 30 * DAY + DAY;       // le lendemain
        assert.ok(approved(await env.claim(founderVoucher(env, consom(100_000), 778n))));
    });

    it('une seule réclamation par identifiant : la seconde est refusée et rien n\'est repris', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        const before = await env.minter.getCaps();
        const r = await env.claim(founderVoucher(env, consom(100_000), 777n));
        assert.equal(rejectReason(r), REJECT_ALREADY_DONE, describeTxs(r));
        const after = await env.minter.getCaps();
        assert.equal(after.founders, before.founders, 'la réservation est rendue');
        assert.equal(after.founderShares, before.founderShares, 'les parts réservées sont rendues');
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        assert.equal((await env.bankState()).unassignedShares, GENESIS - consom(70_000));
    });

    it('le même bon présenté deux fois ne sert qu\'une fois', async () => {
        const env = await withGenesis();
        const v = founderVoucher(env, consom(100_000), 777n);
        await env.claim(v);
        const r = await env.claim(v);
        assert.equal(rejectReason(r), REJECT_ALREADY_DONE);
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
    });

    it('un identifiant déjà réclamé reste refusé même avec une autre adresse ; un autre identifiant est accepté', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        const other = await env.blockchain.treasury('other');
        assert.equal(rejectReason(await env.claim(founderVoucher(env, consom(100_000), 777n, other.address))), REJECT_WRONG_OWNER);
        assert.ok(approved(await env.claim(founderVoucher(env, consom(50_000), 778n, other.address))));
        assert.equal(await env.balanceOf(other.address), consom(15_000));
        assert.equal((await env.shareState(other.address))!.shares, consom(35_000));
    });

    it('sans limite de temps : ni la fenêtre de 18 mois, ni celle de 24 mois ne s\'appliquent', async () => {
        const env = await withGenesis();
        for (const [i, days] of [[1n, 600], [2n, 800], [3n, 3650]] as [bigint, number][]) {
            env.blockchain.now = T0 + days * DAY;
            const r = await env.claim(founderVoucher(env, consom(10_000), 700n + i));
            assert.ok(approved(r), `à T0 + ${days} jours\n${describeTxs(r)}`);
        }
        assert.equal(await env.balanceOf(env.member.address), 3n * consom(3_000));
    });

    it('un autre type de bon reste refusé hors de sa fenêtre (la règle n\'est pas élargie)', async () => {
        const env = await withGenesis();
        env.blockchain.now = T0 + 800 * DAY;
        refusedWith(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n })), env.minter.address, Err.WINDOW_CLOSED);
    });

    it('n\'importe qui peut présenter le bon : tout va à l\'adresse du bon', async () => {
        const env = await withGenesis();
        const r = await env.claim(founderVoucher(env, consom(100_000), 777n), { from: env.stranger });
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));
        assert.equal(await env.balanceOf(env.stranger.address), 0n);
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        assert.equal(await env.shareState(env.stranger.address), null);
    });

    it('demande deux témoins sur trois différents et une signature valable', async () => {
        const env = await withGenesis();
        refusedWith(await env.claim(founderVoucher(env, consom(100_000), 777n), { signers: [1, 1] }), env.minter.address, Err.SAME_WITNESS);
        refusedWith(await env.claim(founderVoucher(env, consom(100_000), 777n), { keys: [env.witnesses[0].secretKey, env.witnesses[0].secretKey] }), env.minter.address, Err.BAD_SIGNATURE);
        assert.equal(await env.memberState(777n), null);
        assert.ok(approved(await env.claim(founderVoucher(env, consom(100_000), 777n), { signers: [1, 2] })));
    });

    it('est bloquée par la pause du gardien', async () => {
        const env = await withGenesis();
        await env.minter.sendPause(env.guardian.getSender());
        refusedWith(await env.claim(founderVoucher(env, consom(100_000), 777n)), env.minter.address, Err.PAUSED);
        assert.equal(await env.balanceOf(env.member.address), 0n);
    });

    it('refusée avant la genèse : les parts à attribuer n\'existent pas encore', async () => {
        const env = await setup();
        refusedWith(await env.claim(founderVoucher(env, consom(100_000), 777n)), env.minter.address, Err.GENESIS_NOT_DONE);
        assert.equal((await env.minter.getCaps()).founders, consom(5_000_000));
    });

    it('refuse un envoi avec trop peu de TON pour traverser les contrats et la banque', async () => {
        const env = await withGenesis();
        refusedWith(await env.claim(founderVoucher(env, consom(100_000), 777n), { value: toNano('0.3') }), env.minter.address, Err.NOT_ENOUGH_TON);
        assert.equal(await env.memberState(777n), null);
    });
});

describe('Anciens Contributeurs : montants et réserves', () => {
    it('refuse une part totale nulle, trop grande, ou qui ne tombe pas juste (multiple de 10 unités)', async () => {
        const env = await withGenesis();
        for (const T of [0n, consom(5_000_000) + 10n, consom(100) + 1n, 5n]) {
            refusedWith(await env.claim(founderVoucher(env, T, 777n)), env.minter.address, Err.WRONG_AMOUNT);
        }
        assert.equal(await env.memberState(777n), null);
    });

    it('les 5 000 000 se partagent exactement : 1 500 000 créés + 3 500 000 en parts, puis plus rien', async () => {
        const env = await withGenesis();
        const a = await env.blockchain.treasury('a');
        const b = await env.blockchain.treasury('b');
        assert.ok(approved(await env.claim(founderVoucher(env, consom(3_333_333) + 10n, 1n, a.address))));
        assert.ok(approved(await env.claim(founderVoucher(env, consom(5_000_000) - consom(3_333_333) - 10n, 2n, b.address))));
        const caps = await env.minter.getCaps();
        assert.equal(caps.founders, 0n, 'réserve des 30 % vide');
        assert.equal(caps.founderShares, 0n);
        assert.equal((await env.bankState()).unassignedShares, 0n, 'toutes les parts de la genèse sont attribuées');
        assert.equal((await env.minter.getJettonData()).totalSupply, GENESIS + FOUNDATION + DIRECT_RESERVE, 'jamais plus que 5 000 000 au total');
        assert.equal((await env.shareState(a.address))!.shares + (await env.shareState(b.address))!.shares, GENESIS);
        assert.equal((await env.balanceOf(a.address)) + (await env.balanceOf(b.address)), DIRECT_RESERVE);
        // plus rien à réclamer
        refusedWith(await env.claim(founderVoucher(env, 10n, 3n)), env.minter.address, Err.CATEGORY_CAP);
        assert.equal(await env.memberState(3n), null);
    });

    it('refuse si la réserve des 30 % ne suffit pas, sans rien marquer', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(4_000_000), 1n));                 // 1 200 000 créés, il reste 300 000
        const before = await env.minter.getCaps();
        refusedWith(await env.claim(founderVoucher(env, consom(1_000_010), 2n)), env.minter.address, Err.CATEGORY_CAP);
        assert.deepEqual(await env.minter.getCaps(), before);
        assert.equal(await env.memberState(2n), null);
        assert.ok(approved(await env.claim(founderVoucher(env, consom(1_000_000), 2n))), 'ce qui reste est réclamable');
    });

    it('refuse si les parts à attribuer ne suffisent pas, même quand la réserve des 30 % est large', async () => {
        // réserve des 30 % artificiellement grande (test uniquement) : seules les parts à attribuer (3 500 000) limitent
        const env = await withGenesis({ testCaps: { founders: consom(20_000_000) } });
        await env.claim(founderVoucher(env, consom(4_000_000), 1n));                 // 2 800 000 parts attribuées
        const before = await env.minter.getCaps();
        refusedWith(await env.claim(founderVoucher(env, consom(2_000_000), 2n)), env.minter.address, Err.NO_FOUNDER_SHARES);
        assert.deepEqual(await env.minter.getCaps(), before, 'plafonds inchangés');
        assert.equal(await env.memberState(2n), null);
        assert.equal((await env.bankState()).unassignedShares, GENESIS - consom(2_800_000));
    });
});

describe('Anciens Contributeurs : banque', () => {
    it('seul l\'émetteur peut attribuer des parts de la genèse', async () => {
        const env = await withGenesis();
        const body = (await import('@ton/core')).beginCell().storeUint(Op.AssignFounderShares, 32).storeUint(0, 64)
            .storeCoins(consom(1000)).storeAddress(env.stranger.address).endCell();
        const r = await env.stranger.send({ to: env.bankAddress, value: toNano('0.2'), body });
        assert.ok(hasTx(r, { to: env.bankAddress, success: false, exitCode: 460 }), describeTxs(r));
        assert.equal((await env.bankState()).unassignedShares, GENESIS);
        assert.equal(await env.shareState(env.stranger.address), null);
    });

    it('les parts attribuées suivent les règles de la banque : fermée 12 mois, puis retrait 24 h après l\'attribution', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        // banque fermée : le retrait est refusé par la banque, les parts sont rétablies
        env.blockchain.now = T0 + 10 * DAY;
        const closed = await env.withdraw(env.member);
        assert.ok(hasTx(closed, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(closed));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000), 'parts rétablies');
        assert.equal(await env.balanceOf(env.member.address), consom(30_000));

        // après 12 mois : retrait possible, à la valeur des parts (1 part = 1 ConsoM tant que rien n'est brûlé)
        env.blockchain.now = T0 + 366 * DAY;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(100_000), '30 000 créés + 70 000 retirés de la banque');
        assert.equal((await env.shareState(env.member.address))!.shares, 0n);
        assert.equal((await env.bankState()).depositorStock, GENESIS - consom(70_000));
    });

    it('réclamé après l\'ouverture de la banque : retrait seulement 24 h après l\'attribution', async () => {
        const env = await withGenesis();
        env.blockchain.now = T0 + 400 * DAY;
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        const early = await env.withdraw(env.member);
        assert.ok(hasTx(early, { success: false, exitCode: 472 }), describeTxs(early));
        env.blockchain.now = T0 + 401 * DAY + 5;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(100_000));
    });

    it('les parts d\'un Ancien Contributeur perdent comme celles des autres déposants quand la banque brûle', async () => {
        const env = await withGenesis();
        await env.claim(founderVoucher(env, consom(100_000), 777n));
        await env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points: 1_000_000n, waveAmount: 0n, amount: 0n, memberId: 2n }));   // 100 000 brûlés
        env.blockchain.now = T0 + 366 * DAY;
        await env.withdraw(env.member);
        const expected = (consom(70_000) * (GENESIS - consom(100_000))) / GENESIS;
        assert.equal(await env.balanceOf(env.member.address), consom(30_000) + expected);
    });
});
