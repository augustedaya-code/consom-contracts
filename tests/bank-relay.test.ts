// Lot E14 : conversion par la banque d'échange présentée par le relais du serveur, pour un membre SANS portefeuille.
// Le bon type 8 reste signé par 2 témoins sur 3, à usage unique (numéro croissant), lié au membre par sa clé (memberId) et à
// ses Points. Il ne crée et ne rend aucun ConsoM : la banque brûle sur son stock. Son champ `recipient` n'est ni vérifié ni
// lié au compte membre ; le serveur y met l'adresse du relais. Le relais reste interdit de réception (A16).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import type { Address, Transaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { setup, hasTx, describeTxs, rejectReason } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err, voucherToCell, signVoucher, claimBody, decodeConversionResult } from '../wrappers/ConsoMMinter.ts';
import type { VoucherData, ConversionResult } from '../wrappers/ConsoMMinter.ts';

const BURN_NOTIFICATION = 0x7bdd97de;
const NO_WALLET_MEMBER = 7n;          // empreinte d'un membre qui n'a jamais rattaché de portefeuille
const REJECT_STALE_VOUCHER = 15;
const REJECT_FORBIDDEN = 17;

async function withRelay(genesis = true) {
    const relayAddress = (await (await Blockchain.create()).treasury('relay')).address;
    const env = await setup({ forbiddenRecipients: [relayAddress] });
    const relay = await env.blockchain.treasury('relay');
    if (genesis) await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return { env, relay };
}

// Bon de conversion par la banque pour le membre sans portefeuille : `recipient` = le relais (non utilisé)
const bankVoucher = (env: Env, relay: Address, points: bigint, o: Partial<VoucherData> = {}) =>
    env.voucher({ kind: Kind.BANK_CONVERSION, points, waveAmount: 0n, amount: 0n, memberId: NO_WALLET_MEMBER, recipient: relay, ...o });

// Envoie `sent` signé avec les signatures de `signed` (pour tester un bon modifié après signature)
const sendTampered = async (env: Env, from: any, signed: VoucherData, sent: VoucherData) => {
    const signedCell = voucherToCell(signed);
    const body = claimBody(0n, voucherToCell(sent), signVoucher(signedCell, 0, env.witnesses[0].secretKey), signVoucher(signedCell, 1, env.witnesses[1].secretKey));
    return env.minter.sendClaim(from.getSender(), toNano('0.5'), body);
};

function resultFor(r: { transactions: Transaction[] }, to: Address): ConversionResult | null {
    for (const tx of r.transactions) {
        const info = tx.inMessage?.info;
        if (info?.type !== 'internal' || !info.dest.equals(to)) continue;
        const res = decodeConversionResult(tx.inMessage!.body);
        if (res) return res;
    }
    return null;
}

describe('Lot E14 — conversion par la banque envoyée par le relais (membre sans portefeuille)', () => {
    it('acceptée : la banque brûle, le relais reçoit le résultat, aucune adresse n\'est liée au membre', async () => {
        const { env, relay } = await withRelay();
        const r = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(100), '1 000 Points = 100 ConsoM brûlés (V = 100)');
        assert.equal((await env.bankState()).depositorStock, consom(10_500_000 - 100), 'pris sur le stock des Anciens Contributeurs');
        assert.deepEqual(resultFor(r, relay.address), { queryId: 0n, accepted: true, required: consom(100), burned: consom(100), coveredByFoundation: 0n });
        const m = await env.memberState(NO_WALLET_MEMBER);
        assert.equal(m!.owner, null, 'le compte du membre n\'est lié à aucune adresse (ni au relais)');
        assert.equal(await env.balanceOf(relay.address), 0n, 'le relais ne reçoit aucun ConsoM');
    });

    it('le même bon rejoué est refusé (numéro déjà utilisé), rien n\'est brûlé', async () => {
        const { env, relay } = await withRelay();
        const v = bankVoucher(env, relay.address, 1000n);
        await env.claim(v, { from: relay });
        const again = await env.claim(v, { from: relay });
        assert.equal(rejectReason(again), REJECT_STALE_VOUCHER, describeTxs(again));
        assert.ok(!hasTx(again, { op: BURN_NOTIFICATION }));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(100));
    });

    it('un bon modifié pour un autre membre ou un autre montant de Points est refusé (signature invalide)', async () => {
        const { env, relay } = await withRelay();
        const v = bankVoucher(env, relay.address, 1000n);
        const otherMember = await sendTampered(env, relay, v, { ...v, memberId: 8n });
        assert.ok(hasTx(otherMember, { to: env.minter.address, success: false, exitCode: Err.BAD_SIGNATURE }), describeTxs(otherMember));
        const otherAmount = await sendTampered(env, relay, v, { ...v, points: 100_000n });
        assert.ok(hasTx(otherAmount, { to: env.minter.address, success: false, exitCode: Err.BAD_SIGNATURE }), describeTxs(otherAmount));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
        assert.equal(await env.memberState(8n), null);
    });

    it('un bon sans 2 témoins différents est refusé', async () => {
        const { env, relay } = await withRelay();
        const sameWitness = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay, signers: [0, 0] });
        assert.ok(hasTx(sameWitness, { to: env.minter.address, success: false, exitCode: Err.SAME_WITNESS }), describeTxs(sameWitness));
        const fakeKey = Buffer.alloc(64, 9);
        const forged = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay, keys: [env.witnesses[0].secretKey, fakeKey] });
        assert.ok(hasTx(forged, { to: env.minter.address, success: false, exitCode: Err.BAD_SIGNATURE }), describeTxs(forged));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
    });

    it('le relais ne reçoit jamais de ConsoM : un bon qui crée des ConsoM vers lui est refusé (raison 17)', async () => {
        const { env, relay } = await withRelay();
        await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });
        await env.claim(bankVoucher(env, relay.address, 2000n), { from: relay });
        const mint = await env.claim(env.voucher({ recipient: relay.address, memberId: 9n }), { from: relay });   // pack de prévente vers le relais
        assert.equal(rejectReason(mint), REJECT_FORBIDDEN, describeTxs(mint));
        assert.equal(await env.balanceOf(relay.address), 0n);
        assert.equal((await env.minter.getState()).burnedByConversion, consom(300));
    });

    it('le membre rattache un portefeuille plus tard : sa première réclamation lie l\'adresse ; le relais peut toujours convertir pour lui', async () => {
        const { env, relay } = await withRelay();
        await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });
        await env.claim(env.voucher({ memberId: NO_WALLET_MEMBER }), { from: relay });            // prévente vers son portefeuille
        assert.equal(await env.balanceOf(env.member.address), consom(5000));
        assert.equal((await env.memberState(NO_WALLET_MEMBER))!.owner!.toString(), env.member.address.toString());
        const wrong = await env.claim(env.voucher({ memberId: NO_WALLET_MEMBER, recipient: env.stranger.address }), { from: relay });
        assert.equal(rejectReason(wrong), 10, 'une création vers une autre adresse reste refusée');
        const r = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });
        assert.ok(hasTx(r, { op: BURN_NOTIFICATION, success: true }), describeTxs(r));
    });

    it('conversion avec ses propres ConsoM : inchangée, elle part du portefeuille du membre ; le relais ne peut pas l\'utiliser', async () => {
        const { env, relay } = await withRelay();
        await env.claim(env.voucher(), { from: relay });                                        // 5 000 ConsoM chez le membre
        const own = env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n });
        const r = await env.ownConversion(own, consom(20));
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(4990));
        const byRelay = await env.claim(env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n }), { from: relay });
        assert.ok(hasTx(byRelay, { to: env.minter.address, success: false, exitCode: Err.UNKNOWN_KIND }), describeTxs(byRelay));
    });

    it('banque vide : conversion refusée proprement — rien n\'est brûlé, le résultat dit « refusée », un nouveau bon passera ensuite', async () => {
        const { env, relay } = await withRelay(false);                                          // pas encore de genèse : banque vide
        const r = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });
        assert.ok(!hasTx(r, { op: BURN_NOTIFICATION }), describeTxs(r));
        assert.deepEqual(resultFor(r, relay.address), { queryId: 0n, accepted: false, required: consom(100), burned: 0n, coveredByFoundation: 0n },
            'le serveur ne retire pas les Points du membre');
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        const next = await env.claim(bankVoucher(env, relay.address, 1000n), { from: relay });   // nouveau numéro de bon
        assert.ok(hasTx(next, { op: BURN_NOTIFICATION, success: true }), describeTxs(next));
    });

    it('coût en TON pour le relais (simulateur, mêmes frais que le réseau principal)', async () => {
        const { env, relay } = await withRelay();
        const cost = async (points: bigint) => {
            const before = (await env.blockchain.getContract(relay.address)).balance;
            await env.claim(bankVoucher(env, relay.address, points), { from: relay, value: toNano('0.5') });
            return before - (await env.blockchain.getContract(relay.address)).balance;
        };
        const first = await cost(1000n);           // crée le compte du membre (réserve de 0,01 TON)
        const next = await cost(1000n);
        console.log(`  coût relais : première conversion du membre ${Number(first) / 1e9} TON, suivantes ${Number(next) / 1e9} TON`);
        assert.ok(first < toNano('0.04'), `première conversion : ${first}`);
        assert.ok(next < toNano('0.03'), `conversion suivante : ${next}`);
    });
});
