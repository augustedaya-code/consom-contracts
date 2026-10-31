// Réclamation par un tiers : le serveur de TonMarché (`server`) présente le bon d'un membre et paie les frais.
// Les ConsoM vont toujours à voucher.recipient ; l'excédent de TON revient à celui qui a présenté le bon.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Address, toNano } from '@ton/core';
import type { Transaction } from '@ton/core';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, Err, voucherToCell, signVoucher, ownConversionPayload } from '../wrappers/ConsoMMinter.ts';

const BURN_NOTIFICATION = 0x7bdd97de;
const REJECT_PRESALE_EXCLUSIVE = 3;   // 2e présentation d'une prévente : le budget du paiement l'a déjà versée

// TON reçu par `addr` pendant la transaction (somme des messages internes qui lui sont adressés)
const tonReceived = (r: { transactions: Transaction[] }, addr: Address): bigint =>
    r.transactions.reduce((sum, tx) => {
        const info = tx.inMessage?.info;
        return info?.type === 'internal' && info.dest.equals(addr) ? sum + info.value.coins : sum;
    }, 0n);

// Un membre qui n'a jamais reçu de TON : son adresse n'existe pas encore sur la chaîne
const poorMember = () => new Address(0, Buffer.alloc(32, 7));

describe('Réclamation par un tiers', () => {
    it('le tiers présente le bon : les ConsoM arrivent chez le membre, l\'excédent revient au tiers', async () => {
        const env = await setup();
        const server = env.stranger;
        const r = await env.claim(env.voucher(), { from: server, value: toNano('1') });
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(5000));
        assert.equal(await env.balanceOf(server.address), 0n);
        assert.equal(tonReceived(r, env.member.address), 0n, 'le membre ne reçoit aucun TON');
        assert.ok(tonReceived(r, server.address) > toNano('0.5'), 'le tiers récupère l\'excédent');
    });

    it('le membre n\'a aucun TON et reçoit quand même ses ConsoM (son wallet est créé)', async () => {
        const env = await setup();
        const poor = poorMember();
        const r = await env.claim(env.voucher({ recipient: poor }), { from: env.stranger });
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(poor), consom(5000));
        assert.equal(tonReceived(r, poor), 0n);
    });

    it('le montant minimal joint (0,25 TON) suffit pour un membre sans TON', async () => {
        const env = await setup();
        const poor = poorMember();
        await env.claim(env.voucher({ recipient: poor }), { from: env.stranger, value: toNano('0.25') });
        assert.equal(await env.balanceOf(poor), consom(5000));
    });

    it('le tiers ne peut détourner ni ConsoM ni jetons vers lui-même, quel que soit le type de bon', async () => {
        const env = await setup();
        const server = env.stranger;
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }), { from: server });
        for (const c of [
            { kind: Kind.PRESALE, amount: consom(5000), waveAmount: 4500n, points: 0n },
            { kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 0n, points: 0n },
            { kind: Kind.MISSION_TG, amount: consom(150), waveAmount: 0n, points: 0n },
            { kind: Kind.CONVERSION, amount: consom(50), waveAmount: 0n, points: 1000n },
            { kind: Kind.INVESTMENT, amount: consom(40), waveAmount: 0n, points: 1000n },
        ]) {
            const r = await env.claim(env.voucher(c), { from: server });
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `type ${c.kind}\n${describeTxs(r)}`);
        }
        assert.equal(await env.balanceOf(server.address), 0n);
        assert.equal(await env.balanceOf(env.member.address), (await env.minter.getState()).totalSupply);
        assert.equal((await env.memberState(1n))!.owner!.toString(), env.member.address.toString());
    });

    it('un même bon présenté deux fois par deux expéditeurs différents : le 2e est refusé', async () => {
        const env = await setup();
        const v = env.voucher();
        await env.claim(v, { from: env.stranger });
        const r = await env.claim(v, { from: env.member });
        assert.equal(rejectReason(r), REJECT_PRESALE_EXCLUSIVE, describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(5000));
        assert.ok(tonReceived(r, env.member.address) > 0n, 'le 2e expéditeur récupère ses frais');

        // bon sans paiement Wave (bonus de conversion) : refusé par numéro de bon déjà utilisé
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const c = env.voucher({ kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(50) });
        await env.claim(c, { from: env.stranger });
        const again = await env.claim(c, { from: env.member });
        assert.ok(hasTx(again, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(again));
        assert.equal(await env.balanceOf(env.member.address), consom(5000 + 50));
    });

    it('un refus de l\'émetteur ou d\'un contrat enfant rend l\'excédent au tiers, jamais au membre', async () => {
        const env = await setup();
        const server = env.stranger;
        // refus du compte membre (aucun Point) : ClaimRejected
        const r = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 13n, waveAmount: 0n, amount: (13n * consom(1) * 500n) / 10000n }), { from: server });
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(r));
        assert.ok(tonReceived(r, server.address) > toNano('0.3'));
        assert.equal(tonReceived(r, env.member.address), 0n);
        // refus du budget (emplacement déjà versé)
        const v = env.voucher();
        await env.claim(v, { from: server });
        const r2 = await env.claim(v, { from: server });
        assert.equal(rejectReason(r2), REJECT_PRESALE_EXCLUSIVE, describeTxs(r2));
        assert.equal(tonReceived(r2, env.member.address), 0n);
        assert.ok(tonReceived(r2, server.address) > toNano('0.3'));
        // refus passager (plafond de 50 000 par 24 h) : l'emplacement est libéré puis les frais rendus au tiers
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1_800_000n, waveAmount: 3_600_000n, amount: 0n }));
        await env.claim(env.voucher());
        const ref = () => env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1_800_000n, waveAmount: 3_600_000n, amount: consom(45_000), validUntil: T0 + 3 * DAY });
        await env.claim(ref(), { from: server });
        const r3 = await env.claim(ref(), { from: server });
        assert.equal(rejectReason(r3), 12, describeTxs(r3));
        assert.equal(tonReceived(r3, env.member.address), 0n);
        assert.ok(tonReceived(r3, server.address) > toNano('0.3'));
    });

    it('un tiers qui joint trop peu de TON échoue sans brûler le bon : il reste utilisable', async () => {
        const env = await setup();
        const v = env.voucher();
        const capsBefore = await env.minter.getCaps();
        const r = await env.claim(v, { from: env.stranger, value: toNano('0.1') });
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.NOT_ENOUGH_TON }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal(await env.budgetState(v.waveRef), null, 'rien n\'a été marqué côté budget');
        assert.deepEqual(await env.minter.getCaps(), capsBefore, 'aucun plafond touché');
        const ok = await env.claim(v, { from: env.stranger });
        assert.ok(hasTx(ok, { to: env.minter.address, op: Op.MintApproved, success: true }), describeTxs(ok));
        assert.equal(await env.balanceOf(env.member.address), consom(5000));
    });

    it('conversion via la banque présentée par un tiers : tout est au nom du membre, rien chez le tiers', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        const server = env.stranger;
        const before = (await env.minter.getState()).burnedByConversion;
        const v = env.voucher({ kind: Kind.BANK_CONVERSION, points: 1000n, waveAmount: 0n, amount: 0n });
        const r = await env.claim(v, { from: server, value: toNano('1') });
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion - before, consom(100));
        assert.equal(await env.balanceOf(server.address), 0n);
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal(tonReceived(r, env.member.address), 0n);
        assert.ok(tonReceived(r, server.address) > toNano('0.5'), 'les frais non utilisés reviennent au tiers');
        assert.equal((await env.memberState(1n))!.owner!.toString(), env.member.address.toString());
        // le bon est consommé : le représenter est refusé
        const again = await env.claim(v, { from: env.member });
        assert.equal(rejectReason(again), 15, describeTxs(again));
    });

    it('conversion avec ses propres ConsoM : inchangée, elle part du wallet du membre ; un tiers ne peut pas l\'utiliser', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        await env.claim(env.voucher(), { from: env.stranger });                       // 5 000 ConsoM chez le membre
        await env.claim(env.voucher({ recipient: env.stranger.address, memberId: 2n }), { from: env.stranger }); // 5 000 chez le tiers
        const v = env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n });
        const cell = voucherToCell(v);
        const payload = ownConversionPayload(cell, signVoucher(cell, 0, env.witnesses[0].secretKey), signVoucher(cell, 1, env.witnesses[1].secretKey));

        // le tiers envoie SES ConsoM avec le bon du membre : tout lui est rendu, rien n'est brûlé, le bon reste libre
        await env.sendToBank(env.stranger, consom(20), payload);
        assert.equal(await env.balanceOf(env.stranger.address), consom(5000));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);

        // le membre, lui, convertit normalement : 10 brûlés, 10 rendus
        const r = await env.sendToBank(env.member, consom(20), payload);
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(4990));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(10));
        assert.equal((await env.bankState()).escrow, 0n);
    });

    it('un bon de conversion avec ses propres ConsoM ne peut pas être présenté par ClaimVoucher', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n }), { from: env.stranger });
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.UNKNOWN_KIND }), describeTxs(r));
    });
});
