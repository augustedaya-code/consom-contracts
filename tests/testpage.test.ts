// La bibliothèque de la page de test (tools/testpage) produit des messages que les contrats acceptent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@ton/core';
import { sign, keyPairFromSeed, sha256_sync } from '@ton/crypto';
import { setup, hasTx, describeTxs } from './helpers.ts';
import { consom, Op } from '../wrappers/ConsoMMinter.ts';
// @ts-ignore — bibliothèque JavaScript partagée avec la page de test
import { createConsoMTestLib } from '../tools/testpage/consom-test-lib.js';

const TON = { ...core, sign, keyPairFromSeed, sha256Sync: sha256_sync };

async function libFor(env: any) {
    await env.minter.sendGenesis(env.deployer.getSender(), core.toNano('0.3'));
    return createConsoMTestLib(TON, {
        minter: env.minter.address.toString(),
        bank: env.bankAddress.toString(),
        networkId: -3,
        walletCodeB64: env.codes.walletCode.toBoc().toString('base64'),
        memberCodeB64: env.codes.memberCode.toBoc().toString('base64'),
        witnessSeedsHex: [1, 2, 3].map((i) => Buffer.alloc(32, i).toString('hex')),
        nowSeconds: () => env.blockchain.now,
    });
}

const send = (env: any, msg: any) => env.member.send({ to: msg.to, value: msg.value, body: msg.body });

describe('Page de test', () => {
    it('calcule les mêmes adresses que les contrats', async () => {
        const env = await setup();
        const lib = await libFor(env);
        assert.ok(lib.walletAddressOf(env.member.address).equals(await env.minter.getWalletAddress(env.member.address)));
        const memberId = lib.memberIdOf(env.member.address);
        assert.ok(lib.memberAccountOf(memberId).equals(await env.minter.getChildAddress(false, memberId)));
    });

    it('chaque action produit un message accepté', async () => {
        const env = await setup();
        const lib = await libFor(env);
        const me = env.member.address;
        const ok = async (label: string, msg: any, op = Op.MintApproved) => {
            const r = await send(env, msg);
            assert.ok(hasTx(r, { op, success: true }), `${label}\n${describeTxs(r)}`);
        };
        await ok('prévente', lib.actions.presale(me, 'essentiel'));
        assert.equal(await env.balanceOf(me), consom(3000));
        await ok('achat', lib.actions.purchaseRecord(me, 1000));
        await ok('1er achat', lib.actions.firstPurchase(me));
        await ok('mission Telegram', lib.actions.missionTelegram(me));
        await ok('mission Facebook', lib.actions.missionFacebook(me));
        await ok('parrainage', lib.actions.referral(me, 1000, 1));
        await ok('récompense de conversion', lib.actions.conversionReward(me, 1000));
        await ok('conversion via la banque', lib.actions.bankConversion(me, 1000), 0x7bdd97de);
        const before = await env.balanceOf(me);
        await ok('conversion avec ses ConsoM', lib.actions.ownConversion(me, 100, 20), 0x7bdd97de);
        assert.equal(await env.balanceOf(me), before - consom(10), 'brûle 10, rend 10');
        assert.ok(lib.tonkeeperLink(lib.actions.presale(me, 'grande')).startsWith('https://app.tonkeeper.com/transfer/'));
    });

    it('les actions du gardien fonctionnent depuis son adresse', async () => {
        const env = await setup();
        const lib = await libFor(env);
        const p = lib.actions.pause();
        const r = await env.guardian.send({ to: p.to, value: p.value, body: p.body });
        assert.ok(hasTx(r, { to: env.minter.address, success: true }));
        assert.ok((await env.minter.getState()).pausedUntil > 0);
        const u = lib.actions.unpause();
        await env.guardian.send({ to: u.to, value: u.value, body: u.body });
        assert.equal((await env.minter.getState()).pausedUntil, 0);
    });

    it('lit les résultats sur l\'émetteur (format tonapi) : acceptés, refusés et pourquoi', async () => {
        const env = await setup();
        const lib = await libFor(env);
        const me = env.member.address;
        const minterTxs: any[] = [];
        const record = (r: any) => {
            for (const tx of r.transactions) {
                const info = tx.inMessage?.info;
                if (info?.type !== 'internal' || !info.dest.equals(env.minter.address)) continue;
                const d = tx.description as any;
                minterTxs.unshift({
                    utime: tx.now,
                    in_msg: { source: { address: info.src.toRawString() }, raw_body: tx.inMessage!.body.toBoc().toString('hex') },
                    compute_phase: { exit_code: d.computePhase?.type === 'vm' ? d.computePhase.exitCode : 0 },
                });
            }
        };
        record(await send(env, lib.actions.presale(me, 'essentiel')));
        record(await send(env, lib.actions.conversionReward(me, 1000)));      // aucun Point : refusé (16)
        record(await send(env, lib.actions.purchaseRecord(me, 1000)));
        record(await send(env, lib.actions.conversionReward(me, 1000)));      // accepté : +50
        const rows = lib.describeMinterTxs(minterTxs, me);
        const titles = rows.map((r: any) => `${r.status} ${r.title} | ${r.detail}`);
        assert.ok(titles.some((t: string) => t.startsWith('ok') && t.includes('Prévente — Accepté : +3')), titles.join('\n'));
        assert.ok(titles.some((t: string) => t.startsWith('refused Bonus de conversion — Refusé') && t.includes('pas assez de Points')), titles.join('\n'));
        assert.ok(titles.some((t: string) => t.includes('Points enregistrés')), titles.join('\n'));
        assert.ok(titles.some((t: string) => t.startsWith('ok Bonus de conversion — Accepté : +50')), titles.join('\n'));
        assert.ok(!titles.some((t: string) => t.includes('compte ouvert')), 'les envois d\'une autre adresse ne sont pas montrés');
    });
});
