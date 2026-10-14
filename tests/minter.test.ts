// Tests de l'émetteur ConsoM (lancer : npm test). Chaque bloc correspond à une section de la spécification.
// Tous les contrats sont les vrais : émetteur, budget de paiement, compte membre, banque d'échange.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beginCell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { setup, hasTx, describeTxs, T0, DAY } from './helpers.ts';
import { consom, Kind, Op, Err, NETWORK_MAINNET, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

const expectRejected = (r: any, minterAddress: any, code: number) =>
    assert.ok(hasTx(r, { to: minterAddress, success: false, exitCode: code }),
        `refus attendu avec le code ${code}\n${describeTxs(r)}`);


describe('Déploiement et lecture', () => {
    it('démarre sans jetons, sans administrateur, avec les plafonds de la spécification', async () => {
        const env = await setup();
        const jd = await env.minter.getJettonData();
        assert.equal(jd.totalSupply, 0n);
        assert.equal(jd.admin, null, "aucun administrateur (adresse vide)");
        const caps = await env.minter.getCaps();
        assert.equal(caps.presale + caps.purchase + caps.referral + caps.missions + caps.founders + caps.team, consom(230_000_000));
        const st = await env.minter.getState();
        assert.equal(st.t0, T0);
        assert.equal(st.halvingSteps, 0);
    });

    it('au départ, convertir 100 Points demande 10 ConsoM (V = 100)', async () => {
        const env = await setup();
        assert.equal(await env.minter.getBurnForPoints(100n), consom(10));
        assert.equal(await env.minter.getBurnForPoints(1000n), consom(100));
    });

    it('refuse un code d\'opération inconnu et accepte un simple envoi de TON', async () => {
        const env = await setup();
        const r = await env.minter.sendRaw(env.stranger.getSender(), toNano('0.1'), beginCell().storeUint(0x12345678, 32).endCell());
        expectRejected(r, env.minter.address, 0xffff);
        const r2 = await env.minter.sendRaw(env.stranger.getSender(), toNano('0.1'), beginCell().endCell());
        assert.ok(hasTx(r2, { to: env.minter.address, success: true }));
    });
});

describe('Bons d\'émission : parcours accepté (sections 5 à 7)', () => {
    it('prévente : le pack Essentiel crée 3 000 ConsoM, sans vesting', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher());
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        assert.equal((await env.minter.getState()).totalSupply, consom(3000));
        assert.equal((await env.minter.getCaps()).presale, INITIAL_CAPS.presale - consom(3000));
    });

    it('accepte n\'importe quelle paire de témoins différents (0+2, 1+2)', async () => {
        const env = await setup();
        await env.claim(env.voucher(), { signers: [0, 2] });
        await env.claim(env.voucher(), { signers: [2, 1] });
        assert.equal(await env.balanceOf(env.member.address), consom(6000));
    });

    it('parrainage niveau 1 : 15 % des Points, versés en entier', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // la prévente rend le membre éligible au parrainage
        const amount = consom(150);   // 15 % de 1 000 Points
        await env.claim(env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount }));
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + amount);
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - amount);
    });

    it('les cinq niveaux de parrainage suivent 15 / 7 / 3,5 / 1,5 / 0,5 %', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité au parrainage
        const rates = [1500n, 700n, 350n, 150n, 50n];
        for (let level = 1; level <= 5; level++) {
            const amount = (1000n * consom(1) * rates[level - 1]) / 10000n;
            const r = await env.claim(env.voucher({ kind: Kind.REFERRAL, level, points: 1000n, waveAmount: 2000n, amount }));
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `niveau ${level}\n${describeTxs(r)}`);
        }
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(275));  // 27,5 % de 1 000
    });

    it('conversion : 35 % des Points convertis ; 1er achat : 500 ; missions : 150 ; investissement : 30 %', async () => {
        const env = await setup();
        // un achat attesté de 1 000 Points (enregistrement, sans ConsoM)
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const cases = [
            { kind: Kind.CONVERSION, points: 1000n, amount: consom(350) },
            { kind: Kind.FIRST_PURCHASE, points: 0n, amount: consom(500) },
            { kind: Kind.MISSION_TG, points: 0n, amount: consom(150) },
            { kind: Kind.MISSION_FB, points: 0n, amount: consom(150) },
            { kind: Kind.INVESTMENT, points: 1000n, amount: consom(300) },
        ];
        for (const c of cases) {
            const r = await env.claim(env.voucher({ ...c, waveAmount: 0n }));
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `type ${c.kind}\n${describeTxs(r)}`);
        }
        const caps = await env.minter.getCaps();
        assert.equal(caps.purchase, INITIAL_CAPS.purchase - consom(350));
        assert.equal(caps.missions, INITIAL_CAPS.missions - consom(1100));
    });

    it('enregistrement d\'achat : montant nul, aucun plafond touché', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 500n, waveAmount: 1000n, amount: 0n }));
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        assert.equal((await env.minter.getState()).totalSupply, 0n);
        assert.equal((await env.minter.getCaps()).dayMinted, 0n);
    });

    it('les récompenses sont versées en entier tout de suite (pas d\'étalement)', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(350) }));
        await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 0n, amount: consom(500) }));
        assert.equal(await env.balanceOf(env.member.address), consom(850));
        assert.equal((await env.minter.getState()).totalSupply, consom(850));
    });
});

describe('Bons d\'émission : refus (sections 5 et 10)', () => {
    it('refuse deux signatures du même témoin', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher(), { signers: [1, 1] }), env.minter.address, Err.SAME_WITNESS);
    });

    it('refuse une signature qui n\'est pas celle du témoin indiqué', async () => {
        const env = await setup();
        const intruder = keyPairFromSeed(Buffer.alloc(32, 9));
        const r = await env.claim(env.voucher(), { signers: [0, 2], keys: [env.witnesses[0].secretKey, intruder.secretKey] });
        expectRejected(r, env.minter.address, Err.BAD_SIGNATURE);
    });

    it('refuse un bon modifié après signature', async () => {
        const env = await setup();
        const v = env.voucher();
        const { voucherToCell, signVoucher, claimBody } = await import('../wrappers/ConsoMMinter.ts');
        const signed = voucherToCell(v);
        const tampered = voucherToCell({ ...v, amount: consom(50000) });
        const body = claimBody(0n, tampered, signVoucher(signed, 0, env.witnesses[0].secretKey), signVoucher(signed, 1, env.witnesses[1].secretKey));
        expectRejected(await env.minter.sendClaim(env.member.getSender(), toNano('0.5'), body), env.minter.address, Err.BAD_SIGNATURE);
    });

    it('refuse un témoin inexistant (index 3)', async () => {
        const env = await setup();
        const r = await env.claim(env.voucher(), { signers: [0, 3], keys: [env.witnesses[0].secretKey, env.witnesses[1].secretKey] });
        expectRejected(r, env.minter.address, Err.BAD_WITNESS_INDEX);
    });

    it('refuse un bon signé pour un autre réseau (testnet → réseau principal)', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ networkId: NETWORK_MAINNET })), env.minter.address, Err.WRONG_NETWORK);
    });

    it('refuse un bon signé pour un autre émetteur', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ minter: env.stranger.address })), env.minter.address, Err.WRONG_MINTER);
    });

    it('refuse un bon expiré, ou valable plus de 7 jours', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ validUntil: T0 - 1 })), env.minter.address, Err.EXPIRED);
        expectRejected(await env.claim(env.voucher({ validUntil: T0 + 8 * DAY })), env.minter.address, Err.VALIDITY_TOO_LONG);
    });

    it('refuse un bon envoyé par quelqu\'un d\'autre que son bénéficiaire (bon volé)', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher(), { from: env.stranger }), env.minter.address, Err.NOT_RECIPIENT);
    });

    it('refuse un montant différent de celui que le contrat recalcule', async () => {
        const env = await setup();
        const ref = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount: consom(150) + 1n });
        expectRejected(await env.claim(ref), env.minter.address, Err.WRONG_AMOUNT);
        expectRejected(await env.claim(env.voucher({ kind: Kind.REFERRAL, level: 6, points: 1000n, waveAmount: 2000n, amount: 0n })), env.minter.address, Err.WRONG_AMOUNT);
        expectRejected(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(300) })), env.minter.address, Err.WRONG_AMOUNT);
    });

    it('prévente : refuse un pack inconnu ou un paiement inférieur au prix', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ amount: consom(4000) })), env.minter.address, Err.WRONG_AMOUNT);
        expectRejected(await env.claim(env.voucher({ amount: consom(50000), waveAmount: 37999n })), env.minter.address, Err.WRONG_AMOUNT);
    });

    it('refuse des Points supérieurs à 0,5 par franc payé (P_max)', async () => {
        const env = await setup();
        const v = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1001n, waveAmount: 2000n, amount: (1001n * consom(1) * 1500n) / 10000n });
        expectRejected(await env.claim(v), env.minter.address, Err.POINTS_TOO_HIGH);
    });

    it('refuse un type de bon inconnu', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ kind: 10 })), env.minter.address, Err.UNKNOWN_KIND);
        // une conversion avec ses propres ConsoM n'est jamais acceptée directement (elle arrive par la banque)
        expectRejected(await env.claim(env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n })), env.minter.address, Err.UNKNOWN_KIND);
    });

    it('refuse un bon avec trop peu de TON pour traverser les contrats', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher(), { value: toNano('0.1') }), env.minter.address, Err.NOT_ENOUGH_TON);
    });

    it('refuse un message d\'approbation qui ne vient pas d\'un compte membre', async () => {
        const env = await setup();
        const fake = beginCell().storeUint(Op.MintApproved, 32).storeUint(0, 64).storeUint(0, 8)
            .storeCoins(consom(1000)).storeUint(1n, 256).storeAddress(env.stranger.address).storeMaybeRef(null).endCell();
        expectRejected(await env.minter.sendRaw(env.stranger.getSender(), toNano('0.2'), fake), env.minter.address, Err.NOT_CHILD);
        assert.equal((await env.minter.getState()).totalSupply, 0n);
    });

    it('libère la réservation quand le budget de paiement refuse', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité
        const v = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount: consom(150) });
        await env.claim(v);
        const again = await env.claim({ ...v, voucherId: v.voucherId + 1000n });   // même paiement, même niveau
        assert.ok(hasTx(again, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(again));
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(150));
        assert.equal((await env.minter.getState()).totalSupply, consom(3000 + 150));
    });

    it('libère la réservation quand le compte membre refuse', async () => {
        const env = await setup();
        // conversion sans aucun achat attesté : le compte membre refuse
        const r = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 13n, waveAmount: 0n, amount: (13n * consom(1) * 3500n) / 10000n }));
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(r));
        assert.equal((await env.minter.getCaps()).purchase, INITIAL_CAPS.purchase);
    });
});

describe('Fenêtres et plafonds (sections 3 et 10)', () => {
    it('refuse tout bon avant T0', async () => {
        const env = await setup({ t0: T0 + 1000 });   // le réseau n'ouvre que dans 1 000 secondes
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.WINDOW_CLOSED);
    });

    it('ferme la prévente à T0 + 12 mois et les récompenses à T0 + 18 mois', async () => {
        const env = await setup();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 10n, waveAmount: 20n, amount: 0n }));
        env.blockchain.now = T0 + 365 * DAY;
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.WINDOW_CLOSED);
        const r = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        env.blockchain.now = T0 + 540 * DAY;
        expectRejected(await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) })), env.minter.address, Err.WINDOW_CLOSED);
    });

    it('applique une seule fois la règle des invendus de prévente (50 % retirés, 25 % / 25 %)', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // 3 000 vendus
        env.blockchain.now = T0 + 365 * DAY;
        await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));   // déclenche la règle
        const rest = INITIAL_CAPS.presale - consom(3000);
        const caps = await env.minter.getCaps();
        assert.equal(caps.presale, 0n);
        assert.equal(caps.presaleSettled, true);
        assert.equal(caps.purchase, INITIAL_CAPS.purchase + rest / 4n);
        assert.equal(caps.referral, INITIAL_CAPS.referral + rest / 4n);
        env.blockchain.now = T0 + 400 * DAY;
        await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) }));
        assert.equal((await env.minter.getCaps()).purchase, INITIAL_CAPS.purchase + rest / 4n, 'règle appliquée une seule fois');
    });

    it('refuse un bon qui dépasse le plafond restant de sa catégorie', async () => {
        const env = await setup({ testCaps: { missions: consom(200) } });
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 10n, waveAmount: 20n, amount: 0n }));
        const r1 = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.ok(hasTx(r1, { op: Op.MintApproved, success: true }));
        expectRejected(await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) })), env.minter.address, Err.CATEGORY_CAP);
    });

    it('plafond global de 2 000 000 ConsoM par 24 h, prévente comprise', async () => {
        const env = await setup();
        for (let i = 0; i < 40; i++) {   // 40 × 50 000 = 2 000 000
            const r = await env.claim(env.voucher({ amount: consom(50000), waveAmount: 38000n }), { value: toNano('0.5') });
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `achat ${i}\n${describeTxs(r)}`);
        }
        expectRejected(await env.claim(env.voucher({ amount: consom(3000) })), env.minter.address, Err.DAILY_CAP);
        env.blockchain.now = T0 + DAY;
        const r = await env.claim(env.voucher({ amount: consom(3000) }));
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), 'nouvelle période de 24 h');
    });

    it('ne crée jamais plus de 230 M (jetons en circulation + brûlés par conversion)', async () => {
        const env = await setup({ testState: { totalSupply: consom(229_999_000), burnedByConversion: 0n } });
        const r = await env.claim(env.voucher());   // 3 000 de plus dépasseraient 230 M
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.MintApproved, success: false, exitCode: Err.SUPPLY_CAP }), describeTxs(r));
        assert.equal((await env.minter.getState()).totalSupply, consom(229_999_000));
        assert.equal(await env.balanceOf(env.member.address), 0n);
    });
});

describe('Gardien : pause et remplacement de témoin (section 10)', () => {
    it('la pause est immédiate, bloque les bons et s\'arrête seule après 14 jours', async () => {
        const env = await setup();
        await env.minter.sendPause(env.guardian.getSender());
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.PAUSED);
        env.blockchain.now = T0 + 14 * DAY;
        const r = await env.claim(env.voucher());
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
    });

    it('seul le gardien peut mettre en pause ; une seule pause par 30 jours ; la levée est immédiate', async () => {
        const env = await setup();
        expectRejected(await env.minter.sendPause(env.stranger.getSender()), env.minter.address, Err.NOT_GUARDIAN);
        await env.minter.sendPause(env.guardian.getSender());
        await env.minter.sendUnpause(env.guardian.getSender());
        const r = await env.claim(env.voucher());
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), 'levée immédiate');
        env.blockchain.now = T0 + 29 * DAY;
        expectRejected(await env.minter.sendPause(env.guardian.getSender()), env.minter.address, Err.PAUSE_TOO_SOON);
        env.blockchain.now = T0 + 30 * DAY;
        const again = await env.minter.sendPause(env.guardian.getSender());
        assert.ok(hasTx(again, { to: env.minter.address, success: true }));
    });

    it('la pause bloque les nouveaux bons mais pas les brûlages volontaires', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        await env.minter.sendPause(env.guardian.getSender());
        expectRejected(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 0n, amount: consom(500) })), env.minter.address, Err.PAUSED);
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        const burn = await burnFrom(env, env.member, consom(100), toNano('0.2'));
        assert.ok(hasTx(burn, { to: env.minter.address, op: 0x7bdd97de, success: true }), describeTxs(burn));
    });

    it('remplace un témoin seulement après 7 jours, une fois par 30 jours', async () => {
        const env = await setup();
        const newWitness = keyPairFromSeed(Buffer.alloc(32, 7));
        expectRejected(await env.minter.sendProposeWitness(env.stranger.getSender(), 2, newWitness.publicKey), env.minter.address, Err.NOT_GUARDIAN);
        expectRejected(await env.minter.sendProposeWitness(env.guardian.getSender(), 2, env.witnesses[0].publicKey), env.minter.address, Err.DUPLICATE_KEY);
        await env.minter.sendProposeWitness(env.guardian.getSender(), 2, newWitness.publicKey);
        expectRejected(await env.minter.sendProposeWitness(env.guardian.getSender(), 1, newWitness.publicKey), env.minter.address, Err.REPLACE_PENDING);
        env.blockchain.now = T0 + 7 * DAY - 1;
        expectRejected(await env.minter.sendExecuteWitness(env.guardian.getSender()), env.minter.address, Err.TIMELOCK);
        env.blockchain.now = T0 + 7 * DAY;
        await env.minter.sendExecuteWitness(env.guardian.getSender());

        // l'ancienne clé 2 ne vaut plus rien, la nouvelle fonctionne
        expectRejected(await env.claim(env.voucher(), { signers: [0, 2] }), env.minter.address, Err.BAD_SIGNATURE);
        const ok = await env.claim(env.voucher(), { signers: [0, 2], keys: [env.witnesses[0].secretKey, newWitness.secretKey] });
        assert.ok(hasTx(ok, { op: Op.MintApproved, success: true }), describeTxs(ok));

        env.blockchain.now = T0 + 30 * DAY;
        expectRejected(await env.minter.sendProposeWitness(env.guardian.getSender(), 1, keyPairFromSeed(Buffer.alloc(32, 8)).publicKey), env.minter.address, Err.REPLACE_TOO_SOON);
        env.blockchain.now = T0 + 37 * DAY;
        const later = await env.minter.sendProposeWitness(env.guardian.getSender(), 1, keyPairFromSeed(Buffer.alloc(32, 8)).publicKey);
        assert.ok(hasTx(later, { to: env.minter.address, success: true }));
    });

    it('un remplacement en attente peut être annulé', async () => {
        const env = await setup();
        await env.minter.sendProposeWitness(env.guardian.getSender(), 0, keyPairFromSeed(Buffer.alloc(32, 7)).publicKey);
        await env.minter.sendCancelWitness(env.guardian.getSender());
        env.blockchain.now = T0 + 8 * DAY;
        expectRejected(await env.minter.sendExecuteWitness(env.guardian.getSender()), env.minter.address, Err.NO_PENDING);
        assert.equal((await env.minter.getWitnessKeys()).key0, BigInt('0x' + env.witnesses[0].publicKey.toString('hex')));
    });
});

// Brûlage volontaire depuis le wallet ConsoM de `who`
async function burnFrom(env: any, who: any, amount: bigint, value: bigint) {
    const wallet = await env.minter.getWalletAddress(who.address);
    return who.send({
        to: wallet, value,
        body: beginCell().storeUint(Op.Burn, 32).storeUint(0, 64).storeCoins(amount).storeAddress(who.address).storeMaybeRef(null).endCell(),
    });
}

// Conversion via la banque : bon signé, la banque brûle sur son stock (au départ, 1 Point = 10^8 unités de base)
async function bankBurn(env: any, points: bigint) {
    return env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points, waveAmount: 0n, amount: 0n }));
}

describe('Genèse, brûlages et halving (sections 8, 9 et 11)', () => {
    it('dépose une seule fois 3 500 000 ConsoM des Anciens Contributeurs dans la banque', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        const bank = await env.minter.getBankAddress();
        assert.equal(await env.balanceOf(bank), consom(3_500_000));
        assert.equal((await env.minter.getCaps()).founders, consom(1_500_000));
        assert.equal((await env.minter.getState()).genesisDone, true);
        expectRejected(await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3')), env.minter.address, Err.GENESIS_DONE);
    });

    it('un brûlage de conversion (par la banque) est définitif et compte pour le halving', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        // 6 jours de conversions de 1 400 000 Points = 140 000 ConsoM par jour (sous le plafond de 5 %)
        for (let day = 0; day < 6; day++) {
            env.blockchain.now = T0 + day * DAY;
            const r = await bankBurn(env, 1_400_000n);
            assert.ok(hasTx(r, { to: env.minter.address, op: 0x7bdd97de, success: true }), `jour ${day}\n${describeTxs(r)}`);
        }
        const st = await env.minter.getState();
        assert.equal(st.totalSupply, consom(3_500_000 - 840_000));
        assert.equal(st.burnedByConversion, consom(840_000));
        assert.equal(st.burnedInYear1, consom(840_000));
        assert.equal(st.halvingSteps, 1);
        assert.equal(await env.minter.getBurnForPoints(100n), consom(5), 'V = 50 : 100 Points demandent 5 ConsoM');
    });

    it('un brûlage volontaire est recréé dans la banque et ne compte pas pour le halving', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // le membre a 3 000 ConsoM
        const bank = await env.minter.getBankAddress();
        const r = await burnFrom(env, env.member, consom(1000), toNano('0.2'));
        assert.ok(hasTx(r, { to: env.minter.address, op: 0x7bdd97de, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(2000));
        assert.equal(await env.balanceOf(bank), consom(1000));
        assert.equal((await env.bankState()).ownerlessStock, consom(1000), 'stock sans propriétaire');
        const st = await env.minter.getState();
        assert.equal(st.totalSupply, consom(3000), 'l\'offre ne baisse pas');
        assert.equal(st.recycled, consom(1000));
        assert.equal(st.burnedByConversion, 0n);
        assert.equal(st.halvingSteps, 0);
    });

    it('sans assez de TON pour la recréation, le brûlage volontaire est annulé', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        const r = await burnFrom(env, env.member, consom(1000), toNano('0.06'));
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.NOT_ENOUGH_TON }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(3000), 'solde rétabli');
        assert.equal((await env.minter.getState()).totalSupply, consom(3000));
    });

    it('refuse une notification de brûlage qui ne vient pas d\'un wallet ConsoM', async () => {
        const env = await setup();
        const fake = beginCell().storeUint(0x7bdd97de, 32).storeUint(0, 64).storeCoins(consom(1))
            .storeAddress(env.stranger.address).storeAddress(null).endCell();
        expectRejected(await env.minter.sendRaw(env.stranger.getSender(), toNano('0.2'), fake), env.minter.address, Err.NOT_WALLET);
    });

    it('halving : 800 000 par palier la 1re année, puis 12 000 000 avec report', async () => {
        // fin de 1re année au palier 2 (2 000 000 brûlés) : 400 000 sont reportés
        const cases: Array<[bigint, bigint, number]> = [
            [consom(0), consom(0), 0],
            [consom(799_999), consom(799_999), 0],
            [consom(2_000_000), consom(2_000_000), 2],
            [consom(2_000_000 + 11_599_999), consom(2_000_000), 2],
            [consom(2_000_000 + 11_600_000), consom(2_000_000), 3],    // 400 000 reportés + 11 600 000 = 12 M
            [consom(2_000_000 + 23_600_000), consom(2_000_000), 4],
            [consom(230_000_000), consom(230_000_000), 30],             // plafonné à 30 paliers
        ];
        for (const [burned, year1, expected] of cases) {
            const env = await setup({ testState: { burnedByConversion: burned, burnedInYear1: year1, totalSupply: 0n } });
            assert.equal((await env.minter.getState()).halvingSteps, expected, `B=${burned} B1=${year1}`);
        }
    });

    it('le brûlage à payer est arrondi au supérieur, en unités de base', async () => {
        const env = await setup({ testState: { burnedByConversion: consom(2_400_000), burnedInYear1: consom(2_400_000) } });
        assert.equal((await env.minter.getState()).halvingSteps, 3);
        assert.equal(await env.minter.getBurnForPoints(100n), 1_250_000_000n, 'V = 12,5 : 1,25 ConsoM pour 100 Points');
        assert.equal(await env.minter.getBurnForPoints(1n), 12_500_000n);
        assert.equal(await env.minter.getBurnForPoints(3n), 37_500_000n);
    });

    it('après la 1re année, les brûlages ne comptent plus dans B1', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        await bankBurn(env, 1_000_000n);   // 100 000 ConsoM
        env.blockchain.now = T0 + 365 * DAY;
        await bankBurn(env, 1_000_000n);
        const st = await env.minter.getState();
        assert.equal(st.burnedInYear1, consom(100_000));
        assert.equal(st.burnedByConversion, consom(200_000));
        assert.equal(st.halvingSteps, 0);
    });
});
