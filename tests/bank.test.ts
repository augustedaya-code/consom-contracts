// Tests de la banque d'échange et des conversions (spécification, sections 8 et 9).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beginCell, toNano } from '@ton/core';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, withdrawRequestBody } from '../wrappers/ConsoMMinter.ts';

const BURN_NOTIFICATION = 0x7bdd97de;

// Au départ (V = 100), convertir P Points brûle P × 10^8 unités de base, soit P / 10 ConsoM
const bankConversion = (env: any, points: bigint) =>
    env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points, waveAmount: 0n, amount: 0n }));
const ownVoucher = (env: any, points: bigint) =>
    env.voucher({ kind: Kind.OWN_CONVERSION, points, waveAmount: 0n, amount: 0n });

async function withGenesis() {
    const env = await setup();
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

describe('Genèse de la banque', () => {
    it('les 3 500 000 ConsoM des Anciens Contributeurs deviennent des parts à attribuer', async () => {
        const env = await withGenesis();
        const st = await env.bankState();
        assert.equal(st.depositorStock, consom(3_500_000));
        assert.equal(st.totalShares, consom(3_500_000));
        assert.equal(st.unassignedShares, consom(3_500_000));
        assert.equal(st.ownerlessStock, 0n);
        assert.equal(st.isOpen, false, 'fermée pendant 12 mois');
    });
});

describe('Conversion via la banque', () => {
    it('brûle le montant calculé par l\'émetteur, au prorata des deux stocks', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());                                     // le membre a 3 000 ConsoM
        const burnVoluntary = await env.member.send({                       // 1 000 brûlés volontairement -> stock sans propriétaire
            to: await env.minter.getWalletAddress(env.member.address), value: toNano('0.2'),
            body: beginCell().storeUint(Op.Burn, 32).storeUint(0, 64).storeCoins(consom(1000))
                .storeAddress(env.member.address).storeMaybeRef(null).endCell(),
        });
        assert.ok(hasTx(burnVoluntary, { op: BURN_NOTIFICATION, success: true }));

        const r = await bankConversion(env, 1_000_000n);                    // 100 000 ConsoM à brûler
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        const st = await env.bankState();
        const fromOwnerless = (consom(100_000) * consom(1000)) / consom(3_501_000);
        assert.equal(st.ownerlessStock, consom(1000) - fromOwnerless);
        assert.equal(st.depositorStock, consom(3_500_000) - (consom(100_000) - fromOwnerless));
        assert.equal(st.totalShares, consom(3_500_000), 'les parts ne changent pas');
        assert.equal((await env.minter.getState()).burnedByConversion, consom(100_000));
    });

    it('un bon de conversion ne sert qu\'une fois', async () => {
        const env = await withGenesis();
        const v = env.voucher({ kind: Kind.BANK_CONVERSION, points: 1000n, waveAmount: 0n, amount: 0n });
        await env.claim(v);
        const r = await env.claim(v);
        assert.equal(rejectReason(r), 15, describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(100));
    });

    it('plafond de 5 % du stock par 24 h ; au-delà, rien n\'est brûlé', async () => {
        const env = await withGenesis();
        await bankConversion(env, 1_750_000n);                              // 175 000 = 5 % de 3 500 000
        const r = await bankConversion(env, 10n);
        assert.ok(!hasTx(r, { op: BURN_NOTIFICATION }), 'aucun brûlage au-delà du plafond');
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.BankBurn, success: true }), describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(175_000));
        env.blockchain.now = T0 + DAY;
        const next = await bankConversion(env, 10n);
        assert.ok(hasTx(next, { op: BURN_NOTIFICATION, success: true }), 'nouvelle période de 24 h');
    });

    it('la banque garde ses propres TON : le membre ne récupère que ce qu\'il a envoyé', async () => {
        const env = await withGenesis();
        const bankTonBefore = (await env.blockchain.getContract(env.bankAddress)).balance;
        const memberBefore = (await env.blockchain.getContract(env.member.address)).balance;
        await bankConversion(env, 1000n);
        const memberAfter = (await env.blockchain.getContract(env.member.address)).balance;
        assert.ok(memberAfter < memberBefore, 'la conversion coûte des frais au membre');
        assert.ok((await env.blockchain.getContract(env.bankAddress)).balance >= bankTonBefore - toNano('0.001'));
    });

    it('banque vide : la conversion est refusée', async () => {
        const env = await setup();
        const r = await bankConversion(env, 100n);
        assert.ok(!hasTx(r, { op: BURN_NOTIFICATION }), describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
    });

    it('refusée pendant une pause', async () => {
        const env = await withGenesis();
        await env.minter.sendPause(env.guardian.getSender());
        const r = await bankConversion(env, 100n);
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: 400 }), describeTxs(r));
    });

    it('reste possible après la fin des récompenses (18 mois)', async () => {
        const env = await withGenesis();
        env.blockchain.now = T0 + 600 * DAY;
        const r = await bankConversion(env, 100n);
        assert.ok(hasTx(r, { op: BURN_NOTIFICATION, success: true }), describeTxs(r));
    });
});

describe('Conversion avec ses propres ConsoM', () => {
    it('brûle le montant requis et rend l\'excédent', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());                                     // 3 000 ConsoM
        const r = await env.ownConversion(ownVoucher(env, 100n), consom(20)); // 10 requis, 20 envoyés
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.VerifyOwnConversion, success: true }), describeTxs(r));
        assert.ok(hasTx(r, { to: env.minter.address, op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(2990));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(10));
        assert.equal((await env.bankState()).escrow, 0n);
    });

    it('rend tous les jetons si le montant envoyé ne suffit pas', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        await env.ownConversion(ownVoucher(env, 100n), consom(5));
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
        assert.equal((await env.bankState()).escrow, 0n);
    });

    it('rend tous les jetons si le bon est invalide ou déjà utilisé', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        await env.ownConversion(ownVoucher(env, 100n), consom(10), [1, 1]);    // deux fois le même témoin
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        const v = ownVoucher(env, 100n);
        await env.ownConversion(v, consom(10));
        await env.ownConversion(v, consom(10));                                 // même bon
        assert.equal(await env.balanceOf(env.member.address), consom(2990));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(10));
    });

    it('n\'est pas soumise au plafond de 5 % et compte pour le halving', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher({ amount: consom(50000), waveAmount: 38000n }));   // 50 000 ConsoM
        await bankConversion(env, 1_750_000n);                                          // plafond de la banque atteint
        const r = await env.ownConversion(ownVoucher(env, 400_000n), consom(40_000));
        assert.ok(hasTx(r, { op: BURN_NOTIFICATION, success: true }), describeTxs(r));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(215_000));
    });

    it('rend les jetons pendant une pause', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        await env.minter.sendPause(env.guardian.getSender());
        await env.ownConversion(ownVoucher(env, 100n), consom(10));
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
    });
});

describe('Dépôts et retraits', () => {
    it('un envoi sans objet rejoint le stock sans propriétaire', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        await env.sendToBank(env.member, consom(100));
        assert.equal((await env.bankState()).ownerlessStock, consom(100));
        assert.equal(await env.balanceOf(env.member.address), consom(2900));
    });

    it('fermée aux dépôts pendant 12 mois : les jetons sont rendus', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        await env.deposit(env.member, consom(1000));
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        assert.equal((await env.bankState()).depositorStock, consom(3_500_000));
    });

    it('après 12 mois : dépôt en parts, retrait 24 h plus tard à la valeur des parts', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        env.blockchain.now = T0 + 365 * DAY;
        await env.deposit(env.member, consom(1000));
        const share = await env.shareState(env.member.address);
        assert.equal(share!.shares, consom(1000), 'au départ, 1 part = 1 ConsoM');
        assert.equal(await env.balanceOf(env.member.address), consom(2000));

        const early = await env.withdraw(env.member);
        assert.ok(hasTx(early, { success: false, exitCode: 472 }), 'retrait avant 24 h refusé');

        // une conversion via la banque fait perdre à chacun la même proportion de son dépôt
        await bankConversion(env, 1_000_000n);   // 100 000 brûlés sur 3 501 000
        env.blockchain.now = T0 + 366 * DAY;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(r));
        const expected = (consom(1000) * (consom(3_501_000) - consom(100_000))) / consom(3_501_000);
        assert.equal(await env.balanceOf(env.member.address), consom(2000) + expected);
        assert.equal((await env.shareState(env.member.address))!.shares, 0n);
    });

    it('seul le propriétaire des parts peut retirer', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());
        env.blockchain.now = T0 + 365 * DAY;
        await env.deposit(env.member, consom(1000));
        env.blockchain.now = T0 + 367 * DAY;
        const share = await env.shareState(env.member.address);
        const r = await env.stranger.send({ to: share!.address, value: toNano('0.3'), body: withdrawRequestBody(0n) });
        assert.ok(hasTx(r, { success: false, exitCode: 471 }), describeTxs(r));
    });

    it('la banque n\'obéit qu\'à l\'émetteur', async () => {
        const env = await withGenesis();
        const fake = beginCell().storeUint(Op.BankBurn, 32).storeUint(0, 64).storeCoins(consom(1000)).storeAddress(env.stranger.address).endCell();
        const r = await env.stranger.send({ to: env.bankAddress, value: toNano('0.2'), body: fake });
        assert.ok(hasTx(r, { to: env.bankAddress, success: false, exitCode: 460 }), describeTxs(r));
        assert.equal((await env.bankState()).depositorStock, consom(3_500_000));
    });
});

