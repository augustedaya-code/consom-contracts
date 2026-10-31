// Tests des contributions du lancement anticipé (décision du 30 octobre 2026) : les contributeurs des 5 mois sur le réseau
// d'essai reçoivent leurs vrais ConsoM 1 pour 1, pris dans la réserve de prévente : 30 % créés sur leur adresse, 70 % créés
// dans la banque avec de NOUVELLES parts attribuées à leur adresse. Compte éligible, une seule fois par contribution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { setup, hasTx, describeTxs, rejectReason, T0, DAY } from './helpers.ts';
import type { Env } from './helpers.ts';
import { consom, Kind, Op, Err, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

const TOTAL = consom(1_000_000);        // total gravé des contributions (somme de la liste du serveur)
const GENESIS = consom(3_500_000);
const REJECT_SLOT_USED = 1;
const REJECT_WRONG_OWNER = 10;

// Réserves sans le compteur du jour : un bon refusé reste volontairement compté dans le plafond du jour (choix prudent)
const reserves = async (env: Env) => { const { dayMinted, ...r } = await env.minter.getCaps(); return r; };

const approved = (r: any) => hasTx(r, { op: Op.MintApproved, success: true });
const refusedWith = (r: any, minter: any, code: number) =>
    assert.ok(hasTx(r, { to: minter, success: false, exitCode: code }), `refus attendu (code ${code})\n${describeTxs(r)}`);

async function withGenesis(overrides = {}) {
    const env = await setup({ earlyContributionsTotal: TOTAL, ...overrides });
    await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return env;
}

// Bon « contribution du lancement anticipé » : `ref` = identifiant unique de la contribution (empreinte), `total` = T
const contribution = (env: Env, total: bigint, ref: bigint, o: { memberId?: bigint; recipient?: any } = {}) =>
    env.voucher({ kind: Kind.EARLY_CONTRIBUTION, amount: total, waveRef: ref, waveAmount: 0n, points: 0n, memberId: o.memberId ?? 1n, recipient: o.recipient ?? env.member.address });

describe('Contribution du lancement anticipé : 30 % sur l\'adresse, 70 % en parts de la banque', () => {
    it('T = 20 000 : 6 000 sur l\'adresse, 14 000 dans la banque, 14 000 parts nouvelles ; réserve de prévente -20 000 ; offre +20 000', async () => {
        const env = await withGenesis();
        const before = await env.bankState();
        const supplyBefore = (await env.minter.getJettonData()).totalSupply;
        const r = await env.claim(contribution(env, consom(20_000), 0xe001n));
        assert.ok(approved(r), describeTxs(r));

        assert.equal(await env.balanceOf(env.member.address), consom(6_000), '30 % sur l\'adresse');
        assert.equal(await env.balanceOf(env.bankAddress), consom(3_600_000 + 14_000), '70 % créés dans la banque');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000), 'parts nouvelles à cette adresse');

        const bank = await env.bankState();
        assert.equal(bank.depositorStock, before.depositorStock + consom(14_000), 'stock des déposants augmenté d\'autant');
        assert.equal(bank.totalShares, before.totalShares + consom(14_000), 'total des parts augmenté d\'autant');
        assert.equal(bank.unassignedShares, GENESIS, 'les parts de la genèse (à attribuer) ne bougent pas');

        const caps = await env.minter.getCaps();
        assert.equal(caps.presale, INITIAL_CAPS.presale - consom(20_000), 'réserve de prévente diminuée de T');
        assert.equal(caps.earlyHold, TOTAL - consom(20_000), 'retenue gravée diminuée de T');
        assert.equal(caps.founderShares, GENESIS, 'les parts des Anciens Contributeurs ne bougent pas');
        assert.equal((await env.minter.getJettonData()).totalSupply, supplyBefore + consom(20_000), 'offre augmentée de T');
        assert.equal(caps.dayMinted, consom(20_000), 'compte dans le plafond global du jour');
    });

    it('fonctionne aussi sans genèse (la banque reçoit de nouveaux ConsoM et de nouvelles parts, 1 pour 1)', async () => {
        const env = await setup({ earlyContributionsTotal: TOTAL });
        assert.ok(approved(await env.claim(contribution(env, consom(20_000), 0xe001n))));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000));
        assert.equal((await env.bankState()).totalShares, consom(14_000));
    });

    it('de nouvelles parts au prix du moment : les autres déposants ne sont pas dilués', async () => {
        const env = await withGenesis();
        // une conversion via la banque brûle 100 000 : une part vaut moins qu'un ConsoM
        await env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points: 1_000_000n, waveAmount: 0n, amount: 0n }));
        const a = await env.bankState();
        assert.equal(a.depositorStock, GENESIS - consom(100_000));
        await env.claim(contribution(env, consom(20_000), 0xe001n));
        const got = (await env.shareState(env.member.address))!.shares;
        assert.equal(got, (consom(14_000) * a.totalShares) / a.depositorStock, 'parts = montant × total des parts / stock');
        assert.ok(got > consom(14_000));
        const b = await env.bankState();
        // la valeur d'une part n'a pas changé pour les autres
        assert.ok(b.depositorStock * a.totalShares >= a.depositorStock * b.totalShares, 'une part ne vaut pas moins qu\'avant (arrondi en faveur des autres)');
    });

    it('le compte membre devient éligible (comme une prévente)', async () => {
        const env = await withGenesis();
        const bonus = env.voucher({ kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500) });
        assert.equal(rejectReason(await env.claim(bonus)), 11, 'avant : refusé, pas de prévente');
        await env.claim(contribution(env, consom(20_000), 0xe001n));
        const st = (await env.memberState(1n))!;
        assert.equal(st.referralEligible, true);
        assert.equal(st.hasPayment, true);
        assert.equal(st.dayReceived, 0n, 'pas compté dans le plafond de 50 000 par 24 h');
        assert.ok(approved(await env.claim({ ...bonus, validUntil: bonus.validUntil + 3600 })), 'après : accepté');
    });

    it('une seule fois par identifiant de contribution ; un autre identifiant est accepté', async () => {
        const env = await withGenesis();
        await env.claim(contribution(env, consom(20_000), 0xe001n));
        const caps = await reserves(env);
        const r = await env.claim(contribution(env, consom(20_000), 0xe001n));
        assert.equal(rejectReason(r), REJECT_SLOT_USED, describeTxs(r));
        assert.deepEqual(await reserves(env), caps, 'réservation (prévente et retenue) rendue');
        assert.equal(await env.balanceOf(env.member.address), consom(6_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000));
        assert.ok(approved(await env.claim(contribution(env, consom(10_000), 0xe002n))), 'une autre contribution du même membre');
        assert.equal((await env.shareState(env.member.address))!.shares, consom(21_000));
    });

    it('sans limite de temps : accepté à T0 + 5 ans, malgré la règle des invendus de T0 + 18 mois', async () => {
        const env = await withGenesis();
        env.blockchain.now = T0 + 19 * 30 * DAY;
        const caps = await env.minter.getCaps();
        assert.equal(caps.presaleSettled, true);
        assert.equal(caps.presale, TOTAL, 'la règle des invendus laisse la retenue des contributions');
        const spare = INITIAL_CAPS.presale - TOTAL;
        assert.equal(caps.purchase, INITIAL_CAPS.purchase + spare / 4n);
        assert.equal(caps.referral, INITIAL_CAPS.referral + spare / 4n);

        env.blockchain.now = T0 + 5 * 365 * DAY;
        const r = await env.claim(contribution(env, consom(20_000), 0xe001n));
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(6_000));
        assert.equal((await env.minter.getCaps()).presale, TOTAL - consom(20_000));
    });

    it('un pack de prévente normal ne change pas : 100 % sur l\'adresse, et il ne touche pas à la retenue', async () => {
        const env = await withGenesis({ testCaps: { presale: TOTAL + consom(8_000) } });
        assert.ok(approved(await env.claim(env.voucher())), 'pack de 5 000 : il reste 3 000 hors retenue');
        assert.equal(await env.balanceOf(env.member.address), consom(5_000), '100 % sur l\'adresse');
        assert.equal(await env.shareState(env.member.address), null, 'aucune part');
        refusedWith(await env.claim(env.voucher()), env.minter.address, Err.CATEGORY_CAP);      // 3 000 hors retenue : refusé
        assert.equal((await env.minter.getCaps()).earlyHold, TOTAL);
    });
});

describe('Contribution du lancement anticipé : limites et refus', () => {
    it('refus si la réserve de prévente ne suffit pas', async () => {
        const env = await withGenesis({ testCaps: { presale: consom(10_000) } });
        refusedWith(await env.claim(contribution(env, consom(20_000), 0xe001n)), env.minter.address, Err.CATEGORY_CAP);
        assert.equal(await env.shareState(env.member.address), null);
        assert.equal(await env.balanceOf(env.member.address), 0n);
        assert.equal((await env.minter.getCaps()).presale, consom(10_000));
    });

    it('refus au-delà du total gravé au déploiement', async () => {
        const env = await withGenesis({ earlyContributionsTotal: consom(30_000) });
        assert.ok(approved(await env.claim(contribution(env, consom(20_000), 0xe001n))));
        refusedWith(await env.claim(contribution(env, consom(20_000), 0xe002n)), env.minter.address, Err.EARLY_TOTAL);
        assert.ok(approved(await env.claim(contribution(env, consom(10_000), 0xe002n))), 'le reste du total est réclamable');
    });

    it('sans total gravé (0), aucune contribution n\'est possible', async () => {
        const env = await setup();
        refusedWith(await env.claim(contribution(env, consom(20_000), 0xe001n)), env.minter.address, Err.EARLY_TOTAL);
    });

    it('refus temporaire si le plafond global du jour est atteint : le bon passe le lendemain', async () => {
        const env = await withGenesis();
        env.blockchain.now = T0 + 36 * 30 * DAY;
        await env.minter.sendReleaseTeam(env.stranger.getSender());                 // 2 000 000 : plafond du jour atteint
        const v = contribution(env, consom(20_000), 0xe001n);
        refusedWith(await env.claim(v), env.minter.address, Err.DAILY_CAP);
        assert.equal(await env.shareState(env.member.address), null, 'rien n\'est marqué');
        assert.equal((await env.minter.getCaps()).earlyHold, TOTAL, 'retenue intacte');
        env.blockchain.now = T0 + 36 * 30 * DAY + DAY;
        assert.ok(approved(await env.claim(contribution(env, consom(20_000), 0xe001n))), 'le lendemain, la même contribution passe');
    });

    it('pas soumis au plafond de 50 000 par membre', async () => {
        const env = await withGenesis();
        assert.ok(approved(await env.claim(contribution(env, consom(400_000), 0xe001n))));
        assert.equal(await env.balanceOf(env.member.address), consom(120_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(280_000));
    });

    it('T doit être un multiple de 10 unités de base, positif, et la contribution doit avoir un identifiant', async () => {
        const env = await withGenesis();
        for (const T of [0n, consom(20_000) + 5n, consom(20_000) + 1n]) {
            refusedWith(await env.claim(contribution(env, T, 0xe001n)), env.minter.address, Err.WRONG_AMOUNT);
        }
        refusedWith(await env.claim(contribution(env, consom(20_000), 0n)), env.minter.address, Err.WRONG_AMOUNT);
        assert.ok(approved(await env.claim(contribution(env, consom(20_000) + 10n, 0xe001n))));
    });

    it('tout va à l\'adresse du bon, même si quelqu\'un d\'autre le présente', async () => {
        const env = await withGenesis();
        assert.ok(approved(await env.claim(contribution(env, consom(20_000), 0xe001n), { from: env.stranger })));
        assert.equal(await env.balanceOf(env.member.address), consom(6_000));
        assert.equal(await env.balanceOf(env.stranger.address), 0n);
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000));
        assert.equal(await env.shareState(env.stranger.address), null);
    });

    it('compte déjà lié à une autre adresse : refusé, et l\'emplacement et les réserves sont rendus', async () => {
        const env = await withGenesis();
        await env.claim(env.voucher());                                             // lie le compte 1 à `member` (prévente)
        const other = await env.blockchain.treasury('other');
        const caps = await reserves(env);
        const v = contribution(env, consom(20_000), 0xe001n, { recipient: other.address });
        assert.equal(rejectReason(await env.claim(v)), REJECT_WRONG_OWNER);
        assert.deepEqual(await reserves(env), caps, 'réserve de prévente et retenue rendues');
        assert.equal((await env.budgetState(0xe001n))!.slots, 0, 'emplacement libéré : le bon pourra être corrigé');
    });

    it('bloqué par la pause du gardien', async () => {
        const env = await withGenesis();
        await env.minter.sendPause(env.guardian.getSender());
        refusedWith(await env.claim(contribution(env, consom(20_000), 0xe001n)), env.minter.address, Err.PAUSED);
    });

    it('refuse un envoi avec trop peu de TON', async () => {
        const env = await withGenesis();
        refusedWith(await env.claim(contribution(env, consom(20_000), 0xe001n), { value: toNano('0.4') }), env.minter.address, Err.NOT_ENOUGH_TON);
        assert.equal(await env.budgetState(0xe001n), null);
    });

    it('n\'épuise pas l\'émetteur : il ne perd que des frais de calcul', async () => {
        const env = await withGenesis();
        const before = (await env.blockchain.getContract(env.minter.address)).balance;
        await env.claim(contribution(env, consom(20_000), 0xe001n));
        const after = (await env.blockchain.getContract(env.minter.address)).balance;
        assert.ok(after >= before - toNano('0.002'), `l'émetteur a perdu ${before - after} nanoTON`);
    });
});

describe('Contribution du lancement anticipé : parts et banque', () => {
    it('retrait de ces parts refusé pendant les 12 premiers mois, possible ensuite (24 h après l\'attribution)', async () => {
        const env = await withGenesis();
        await env.claim(contribution(env, consom(20_000), 0xe001n));
        env.blockchain.now = T0 + 10 * DAY;
        const closed = await env.withdraw(env.member);
        assert.ok(hasTx(closed, { to: env.bankAddress, op: Op.WithdrawShares, success: false, exitCode: 463 }), describeTxs(closed));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(14_000), 'parts rétablies');
        env.blockchain.now = T0 + 366 * DAY;
        const r = await env.withdraw(env.member);
        assert.ok(hasTx(r, { to: env.bankAddress, op: Op.WithdrawShares, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(20_000), '6 000 + 14 000 retirés de la banque');
    });

    it('les 10 % de frais d\'une conversion se partagent au prorata des parts, contributeurs compris', async () => {
        const env = await withGenesis();
        const b = await env.blockchain.treasury('b');
        await env.claim(contribution(env, consom(20_000), 0xe001n));                                    // 14 000 parts
        await env.claim(contribution(env, consom(60_000), 0xe002n, { memberId: 2n, recipient: b.address }));   // 42 000 parts
        await env.claim(env.voucher({ kind: Kind.BANK_CONVERSION, points: 1_000_000n, waveAmount: 0n, amount: 0n }));   // 100 000 brûlés
        const sa = (await env.shareState(env.member.address))!.shares;
        const sb = (await env.shareState(b.address))!.shares;
        assert.equal(sb, 3n * sa, 'parts proportionnelles aux contributions');
        const bank = await env.bankState();
        // chaque part reçoit la même proportion : le serveur répartit sur la liste des parts publiées par la banque
        const [va, vb] = await Promise.all([sa, sb].map(async (s) => {
            const r = await (await env.blockchain.getContract(env.bankAddress)).get('get_shares_value', [{ type: 'int', value: s }]);
            return r.stackReader.readBigNumber();
        }));
        assert.ok(vb >= 3n * va - 3n && vb <= 3n * va + 3n, 'la valeur suit les parts');
        assert.equal(bank.totalShares, GENESIS + consom(56_000), 'les nouvelles parts s\'ajoutent à celles de la genèse');
    });
});
