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
        assert.equal(caps.presale + caps.purchase + caps.referral + caps.missions + caps.founders + caps.team + caps.chika + caps.foundation, consom(250_000_000));
        const st = await env.minter.getState();
        assert.equal(st.t0, T0);
        assert.equal(st.halvingSteps, 0);
    });

    it('les 8 réserves sont celles du livre blanc v5.0 et font exactement 250 000 000', async () => {
        const env = await setup();
        const caps = await env.minter.getCaps();
        assert.equal(caps.presale, consom(100_000_000));
        assert.equal(caps.purchase, consom(55_000_000));
        assert.equal(caps.referral, consom(45_000_000));
        assert.equal(caps.chika, consom(20_000_000));
        assert.equal(caps.missions, consom(19_900_000), 'premier achat et missions');
        assert.equal(caps.founders, consom(5_000_000));
        assert.equal(caps.team, consom(5_000_000));
        assert.equal(caps.foundation, consom(100_000));
        const total = caps.presale + caps.purchase + caps.referral + caps.chika + caps.missions + caps.founders + caps.team + caps.foundation;
        assert.equal(total, consom(250_000_000));
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

    it('parrainage niveau 1 : 2,5 % des Points, versés en entier', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // la prévente rend le membre éligible au parrainage
        const amount = consom(25);   // 2,5 % de 1 000 Points
        await env.claim(env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount }));
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + amount);
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - amount);
    });

    it('les cinq niveaux de parrainage suivent 2,5 / 1,3 / 0,7 / 0,4 / 0,1 %', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité au parrainage
        const expected = [consom(25), consom(13), consom(7), consom(4), consom(1)];   // sur 1 000 Points
        for (let level = 1; level <= 5; level++) {
            const amount = expected[level - 1];
            const r = await env.claim(env.voucher({ kind: Kind.REFERRAL, level, points: 1000n, waveAmount: 2000n, amount }));
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `niveau ${level}\n${describeTxs(r)}`);
        }
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(50));  // 5 % de 1 000
    });

    it('conversion : 5 % des Points convertis ; 1er achat : 500 ; missions : 150 ; investissement : 0,04 par CHIKA', async () => {
        const env = await setup();
        await env.becomeEligible();
        // un achat attesté de 1 000 Points (enregistrement, sans ConsoM)
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const cases = [
            { kind: Kind.CONVERSION, points: 1000n, amount: consom(50) },   // 5 % de 1 000 Points
            { kind: Kind.FIRST_PURCHASE, points: 0n, amount: consom(500) },
            { kind: Kind.MISSION_TG, points: 0n, amount: consom(150) },
            { kind: Kind.MISSION_FB, points: 0n, amount: consom(150) },
            { kind: Kind.INVESTMENT, points: 1000n, amount: consom(40) },   // 1 000 CHIKA investis x 0,04
        ];
        for (const c of cases) {
            const r = await env.claim(env.voucher({ ...c, waveAmount: 0n }));
            assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), `type ${c.kind}\n${describeTxs(r)}`);
        }
        const caps = await env.minter.getCaps();
        assert.equal(caps.purchase, INITIAL_CAPS.purchase - consom(50 + 40), "l'investissement est payé par la réserve Achats");
        assert.equal(caps.missions, INITIAL_CAPS.missions - consom(500 + 150 + 150), 'premier achat et missions');
    });

    it('investissement : 0,04 ConsoM par CHIKA investi, payé par la réserve Achats et non par les missions', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        const before = await env.minter.getCaps();
        const r = await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 2500n, waveAmount: 0n, amount: consom(100) }));   // 2 500 x 0,04
        assert.ok(hasTx(r, { op: Op.MintApproved, success: true }), describeTxs(r));
        const after = await env.minter.getCaps();
        assert.equal(after.purchase, before.purchase - consom(100));
        assert.equal(after.missions, before.missions);
        expectRejected(await env.claim(env.voucher({ kind: Kind.INVESTMENT, points: 1000n, waveAmount: 0n, amount: consom(300) })), env.minter.address, Err.WRONG_AMOUNT);
    });

    it('conversion : un exemple chiffré à 5 % (2 000 Points -> 100 ConsoM, 33 Points -> 1,65 ConsoM)', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 2033n, waveAmount: 4066n, amount: 0n }));
        const a = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 2000n, waveAmount: 0n, amount: consom(100) }));
        assert.ok(hasTx(a, { op: Op.MintApproved, success: true }), describeTxs(a));
        const b = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 33n, waveAmount: 0n, amount: 1_650_000_000n }));
        assert.ok(hasTx(b, { op: Op.MintApproved, success: true }), describeTxs(b));
        assert.equal(await env.balanceOf(env.member.address), consom(3000) + consom(100) + 1_650_000_000n);
        const old = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 100n, waveAmount: 0n, amount: consom(35) }));
        expectRejected(old, env.minter.address, Err.WRONG_AMOUNT);   // l'ancien taux (35 %) n'est plus accepté
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
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 1000n, waveAmount: 2000n, amount: 0n }));
        await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(50) }));
        await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 0n, amount: consom(500) }));
        assert.equal(await env.balanceOf(env.member.address), consom(3000 + 550));
        assert.equal((await env.minter.getState()).totalSupply, consom(3000 + 550));
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

    it('refuse un montant différent de celui que le contrat recalcule', async () => {
        const env = await setup();
        const ref = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount: consom(25) + 1n });
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
        const v = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1001n, waveAmount: 2000n, amount: (1001n * consom(1) * 250n) / 10000n });
        expectRejected(await env.claim(v), env.minter.address, Err.POINTS_TOO_HIGH);
    });

    it('refuse un type de bon inconnu', async () => {
        const env = await setup();
        expectRejected(await env.claim(env.voucher({ kind: 12 })), env.minter.address, Err.UNKNOWN_KIND);
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
            .storeCoins(consom(1000)).storeUint(1n, 256).storeAddress(env.stranger.address).storeMaybeRef(null).storeAddress(env.stranger.address).endCell();
        expectRejected(await env.minter.sendRaw(env.stranger.getSender(), toNano('0.2'), fake), env.minter.address, Err.NOT_CHILD);
        assert.equal((await env.minter.getState()).totalSupply, 0n);
    });

    it('libère la réservation quand le budget de paiement refuse', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // éligibilité
        const v = env.voucher({ kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount: consom(25) });
        await env.claim(v);
        const again = await env.claim({ ...v, voucherId: v.voucherId + 1000n });   // même paiement, même niveau
        assert.ok(hasTx(again, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(again));
        assert.equal((await env.minter.getCaps()).referral, INITIAL_CAPS.referral - consom(25));
        assert.equal((await env.minter.getState()).totalSupply, consom(3000 + 25));
    });

    it('libère la réservation quand le compte membre refuse', async () => {
        const env = await setup();
        // conversion sans aucun achat attesté : le compte membre refuse
        const r = await env.claim(env.voucher({ kind: Kind.CONVERSION, points: 13n, waveAmount: 0n, amount: (13n * consom(1) * 500n) / 10000n }));
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.ClaimRejected, success: true }), describeTxs(r));
        assert.equal((await env.minter.getCaps()).purchase, INITIAL_CAPS.purchase);
    });
});

describe('Fenêtres et plafonds (sections 3 et 10)', () => {
    it('refuse tout bon avant T0', async () => {
        const env = await setup({ t0: T0 + 1000 });   // le réseau n'ouvre que dans 1 000 secondes
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.WINDOW_CLOSED);
    });

    // Fenêtres du livre blanc v5.0 : prévente 18 mois, récompenses 24 mois (mois de 30 jours)
    const PRESALE_END = 18 * 30 * DAY;
    const REWARDS_END = 24 * 30 * DAY;

    it('prévente : acceptée une seconde avant T0 + 18 mois, refusée à la limite', async () => {
        const env = await setup();
        env.blockchain.now = T0 + PRESALE_END - 1;
        const before = await env.claim(env.voucher());
        assert.ok(hasTx(before, { op: Op.MintApproved, success: true }), describeTxs(before));
        env.blockchain.now = T0 + PRESALE_END;
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.WINDOW_CLOSED);
    });

    it('récompenses : acceptées une seconde avant T0 + 24 mois, refusées à la limite', async () => {
        const env = await setup();
        await env.becomeEligible();
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 10n, waveAmount: 20n, amount: 0n }));
        env.blockchain.now = T0 + PRESALE_END;   // la prévente est déjà fermée, les récompenses continuent
        const mid = await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));
        assert.ok(hasTx(mid, { op: Op.MintApproved, success: true }), describeTxs(mid));
        env.blockchain.now = T0 + REWARDS_END - 1;
        const before = await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) }));
        assert.ok(hasTx(before, { op: Op.MintApproved, success: true }), describeTxs(before));
        env.blockchain.now = T0 + REWARDS_END;
        expectRejected(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n })), env.minter.address, Err.WINDOW_CLOSED);
    });

    it('après 24 mois, plus aucune création de récompense, quel que soit le type de bon', async () => {
        const env = await setup();
        env.blockchain.now = T0 + REWARDS_END;
        const cases = [
            { kind: Kind.PURCHASE_RECORD, points: 100n, waveAmount: 200n, amount: 0n },
            { kind: Kind.REFERRAL, level: 1, points: 1000n, waveAmount: 2000n, amount: consom(25) },
            { kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500) },
            { kind: Kind.CONVERSION, points: 1000n, waveAmount: 0n, amount: consom(50) },
            { kind: Kind.MISSION_TG, points: 0n, waveAmount: 0n, amount: consom(150) },
            { kind: Kind.INVESTMENT, points: 1000n, waveAmount: 0n, amount: consom(40) },
            { kind: Kind.CHIKA_BONUS, points: 0n, waveAmount: 1000n, amount: consom(3) },
            { kind: Kind.PRESALE },
        ];
        for (const c of cases) {
            expectRejected(await env.claim(env.voucher(c)), env.minter.address, Err.WINDOW_CLOSED);
        }
        assert.equal((await env.minter.getState()).totalSupply, 0n);
    });

    it('get_caps : réserves de récompenses à 0 à partir de T0 + 24 mois, les autres réserves ne bougent pas', async () => {
        const env = await setup();
        env.blockchain.now = T0 + REWARDS_END - 1;
        const before = await env.minter.getCaps();
        assert.equal(before.purchase > 0n && before.referral > 0n && before.missions > 0n && before.chika > 0n, true, 'encore ouvertes une seconde avant');
        env.blockchain.now = T0 + REWARDS_END;
        const after = await env.minter.getCaps();
        assert.equal(after.purchase, 0n);
        assert.equal(after.referral, 0n);
        assert.equal(after.chika, 0n);
        assert.equal(after.missions, 0n, 'premier achat et missions');
        assert.equal(after.presale, 0n);
        assert.equal(after.founders, INITIAL_CAPS.founders);
        assert.equal(after.team, INITIAL_CAPS.team);
        assert.equal(after.foundation, INITIAL_CAPS.foundation);
    });

    it('applique une seule fois la règle des invendus de prévente à T0 + 18 mois (50 % retirés, 25 % / 25 %)', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // 3 000 vendus
        env.blockchain.now = T0 + PRESALE_END - 1;
        await env.claim(env.voucher({ kind: Kind.PURCHASE_RECORD, points: 10n, waveAmount: 20n, amount: 0n }));
        const rest = INITIAL_CAPS.presale - consom(3000);
        const early = await env.minter.getCaps();
        assert.equal(early.presale, rest, 'pas encore appliquée une seconde avant 18 mois');
        assert.equal(early.presaleSettled, false);
        env.blockchain.now = T0 + PRESALE_END;
        assert.equal((await env.minter.getCaps()).presale, 0n, 'visible dans get_caps dès la limite');
        await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) }));   // déclenche la règle dans le stockage
        const caps = await env.minter.getCaps();
        assert.equal(caps.presale, 0n);
        assert.equal(caps.presaleSettled, true);
        assert.equal(caps.purchase, INITIAL_CAPS.purchase + rest / 4n);
        assert.equal(caps.referral, INITIAL_CAPS.referral + rest / 4n);
        env.blockchain.now = T0 + 600 * DAY;
        await env.claim(env.voucher({ kind: Kind.MISSION_FB, amount: consom(150) }));
        assert.equal((await env.minter.getCaps()).purchase, INITIAL_CAPS.purchase + rest / 4n, 'règle appliquée une seule fois');
    });

    it('refuse un bon qui dépasse le plafond restant de sa catégorie', async () => {
        const env = await setup({ testCaps: { missions: consom(200) } });
        await env.becomeEligible();
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

    it('ne crée jamais plus de 250 M (jetons en circulation + brûlés par conversion)', async () => {
        const env = await setup({ testState: { totalSupply: consom(249_999_000), burnedByConversion: 0n } });
        const r = await env.claim(env.voucher());   // 3 000 de plus dépasseraient 250 M
        assert.ok(hasTx(r, { to: env.minter.address, op: Op.MintApproved, success: false, exitCode: Err.SUPPLY_CAP }), describeTxs(r));
        assert.equal((await env.minter.getState()).totalSupply, consom(249_999_000));
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

    it('la pause bloque les nouveaux bons ; un brûlage direct reste refusé, solde intact', async () => {
        const env = await setup();
        await env.claim(env.voucher());
        await env.minter.sendPause(env.guardian.getSender());
        expectRejected(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 0n, amount: consom(500) })), env.minter.address, Err.PAUSED);
        assert.equal(await env.balanceOf(env.member.address), consom(3000));
        const burn = await burnFrom(env, env.member, consom(100), toNano('0.2'));
        assert.ok(hasTx(burn, { to: env.minter.address, op: 0x7bdd97de, success: false, exitCode: Err.BURN_NOT_ALLOWED }), describeTxs(burn));
        assert.equal(await env.balanceOf(env.member.address), consom(3000), 'solde rétabli');
        assert.equal((await env.minter.getState()).totalSupply, consom(3000));
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);
    });

    it('pendant une pause : création refusée, conversion via la banque refusée, conversion avec ses propres ConsoM acceptée, transfert accepté', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        await env.claim(env.voucher());   // le membre a 3 000 ConsoM
        await env.minter.sendPause(env.guardian.getSender());

        // création (prévente, récompense) : refusée
        expectRejected(await env.claim(env.voucher()), env.minter.address, Err.PAUSED);
        expectRejected(await env.claim(env.voucher({ kind: Kind.FIRST_PURCHASE, amount: consom(500), waveAmount: 1000n })), env.minter.address, Err.PAUSED);
        // conversion via la banque d'échange : refusée
        expectRejected(await bankBurn(env, 100n), env.minter.address, Err.PAUSED);
        assert.equal((await env.minter.getState()).burnedByConversion, 0n);

        // conversion avec ses propres ConsoM : acceptée (10 ConsoM brûlés pour 100 Points, l'excédent est rendu)
        const own = await env.ownConversion(env.voucher({ kind: Kind.OWN_CONVERSION, points: 100n, waveAmount: 0n, amount: 0n }), consom(20));
        assert.ok(hasTx(own, { to: env.minter.address, op: Op.VerifyOwnConversion, success: true }), describeTxs(own));
        assert.ok(hasTx(own, { to: env.minter.address, op: 0x7bdd97de, success: true }), describeTxs(own));
        assert.equal((await env.minter.getState()).burnedByConversion, consom(10));
        assert.equal(await env.balanceOf(env.member.address), consom(2990));

        // transfert de ConsoM : accepté
        const { jettonTransferBody } = await import('../wrappers/ConsoMMinter.ts');
        const wallet = await env.minter.getWalletAddress(env.member.address);
        await env.member.send({ to: wallet, value: toNano('0.2'), body: jettonTransferBody({ amount: consom(100), to: env.stranger.address, responseTo: env.member.address, forwardTon: 0n }) });
        assert.equal(await env.balanceOf(env.stranger.address), consom(100));
        assert.equal(await env.balanceOf(env.member.address), consom(2890));
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

    it('un brûlage de conversion (par la banque) est définitif et fait monter le compteur', async () => {
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
        assert.equal(st.halvingSteps, 0, 'le premier palier n\'est qu\'à 15 000 000');
        assert.equal(await env.minter.getBurnForPoints(100n), consom(10), 'V = 100 : 100 Points demandent 10 ConsoM');
    });

    it('un brûlage demandé par un membre est refusé : solde, offre et paliers intacts, rien dans la banque', async () => {
        const env = await setup();
        await env.claim(env.voucher());   // le membre a 3 000 ConsoM
        const bank = await env.minter.getBankAddress();
        for (const value of [toNano('0.2'), toNano('1')]) {
            const r = await burnFrom(env, env.member, consom(1000), value);
            assert.ok(hasTx(r, { to: env.minter.address, op: 0x7bdd97de, success: false, exitCode: Err.BURN_NOT_ALLOWED }), describeTxs(r));
            assert.equal(await env.balanceOf(env.member.address), consom(3000), 'solde rétabli par le rebond');
            assert.equal(await env.balanceOf(bank), 0n, 'rien n\'est recréé dans la banque');
            const st = await env.minter.getState();
            assert.equal(st.totalSupply, consom(3000), 'l\'offre ne bouge pas');
            assert.equal(st.burnedByConversion, 0n);
            assert.equal(st.halvingSteps, 0);
        }
        assert.equal((await env.bankState()).depositorStock, 0n);
    });

    it('refuse une notification de brûlage qui ne vient pas d\'un wallet ConsoM', async () => {
        const env = await setup();
        const fake = beginCell().storeUint(0x7bdd97de, 32).storeUint(0, 64).storeCoins(consom(1))
            .storeAddress(env.stranger.address).storeAddress(null).endCell();
        expectRejected(await env.minter.sendRaw(env.stranger.getSender(), toNano('0.2'), fake), env.minter.address, Err.NOT_WALLET);
    });

    it('paliers : un palier tous les 15 000 000 brûlés, 16 divisions au plus', async () => {
        const cases: Array<[bigint, number]> = [
            [consom(0), 0],
            [consom(14_999_999), 0],
            [consom(15_000_000) - 1n, 0],      // une unité de base avant le palier
            [consom(15_000_000), 1],
            [consom(29_999_999), 1],
            [consom(30_000_000), 2],
            [consom(239_999_999), 15],
            [consom(240_000_000), 16],         // 16e et dernière division
            [consom(250_000_000), 16],         // le compteur monte, le taux ne bouge plus
            [consom(1_000_000_000), 16],
        ];
        for (const [burned, expected] of cases) {
            const env = await setup({ testState: { burnedByConversion: burned, totalSupply: 0n } });
            assert.equal((await env.minter.getState()).halvingSteps, expected, `B=${burned}`);
        }
    });

    it('paliers : le taux est divisé par 2 à chaque palier (17 paliers), puis ne bouge plus', async () => {
        for (let n = 0; n <= 18; n++) {
            const env = await setup({ testState: { burnedByConversion: consom(15_000_000) * BigInt(n), totalSupply: 0n } });
            const steps = Math.min(n, 16);
            // ConsoM à brûler pour 100 Points = 10 / 2^steps, arrondi au supérieur en unités de base
            const expected = (10_000_000_000n + (1n << BigInt(steps)) - 1n) >> BigInt(steps);
            assert.equal(await env.minter.getBurnForPoints(100n), expected, `palier ${n}`);
        }
        const env = await setup({ testState: { burnedByConversion: consom(15_000_000) * 16n, totalSupply: 0n } });
        assert.equal(await env.minter.getBurnForPoints(100n), 152_588n, 'palier 16 : 10 / 65 536 ConsoM, arrondi au supérieur');
    });

    it('le brûlage à payer est arrondi au supérieur, en unités de base', async () => {
        const env = await setup({ testState: { burnedByConversion: consom(45_000_000) } });
        assert.equal((await env.minter.getState()).halvingSteps, 3);
        assert.equal(await env.minter.getBurnForPoints(100n), 1_250_000_000n, 'V = 12,5 : 1,25 ConsoM pour 100 Points');
        assert.equal(await env.minter.getBurnForPoints(1n), 12_500_000n);
        assert.equal(await env.minter.getBurnForPoints(3n), 37_500_000n);
    });

    it('le compteur compte tous les brûlages de conversion, quelle que soit la date', async () => {
        const env = await setup();
        await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
        await bankBurn(env, 1_000_000n);   // 100 000 ConsoM
        env.blockchain.now = T0 + 800 * DAY;
        await bankBurn(env, 1_000_000n);
        const st = await env.minter.getState();
        assert.equal(st.burnedByConversion, consom(200_000));
        assert.equal(st.halvingSteps, 0);
    });
});
