// Lot E4 — A16 : le serveur de TonMarché ne peut JAMAIS recevoir de ConsoM créés (il peut seulement payer les frais).
//          A3  : contrôles au déploiement (3 clés de témoins distinctes et non vides, gardien et équipe valables).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Address, beginCell, contractAddress, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { setup, hasTx, describeTxs, rejectReason } from './helpers.ts';
import type { Env } from './helpers.ts';
import { Blockchain } from '@ton/sandbox';
import {
    consom, Kind, Op, Err, Reject, minterConfigToCell, assertValidMinterConfig, decodeConversionResult, voucherToCell, claimBody, signVoucher, INITIAL_CAPS,
} from '../wrappers/ConsoMMinter.ts';
import type { MinterConfig } from '../wrappers/ConsoMMinter.ts';

const approved = (r: any) => hasTx(r, { op: Op.MintApproved, success: true });
const ZERO_ADDRESS = new Address(0, Buffer.alloc(32));
const REJECT_FORBIDDEN_RECIPIENT = Reject.FORBIDDEN_RECIPIENT;   // 17

// Réserves sans le compteur du jour : un bon refusé reste volontairement compté dans le plafond du jour (choix prudent)
const reserves = async (env: Env) => { const { dayMinted, dayStart, ...r } = await env.minter.getCaps(); return r; };

// Adresse d'un portefeuille de test nommé : elle ne dépend que du nom, donc elle est la même dans toutes les chaînes de test
// (il faut la connaître avant le déploiement, puisque la liste interdite est gravée au déploiement)
const addressOf = async (name: string) => (await (await Blockchain.create()).treasury(name)).address;

// Environnement où `relay` (le wallet relais du serveur) est une adresse interdite de réception
async function withRelay(overrides: Partial<MinterConfig> = {}, genesis = false) {
    const env = await setup({ forbiddenRecipients: [await addressOf('relay')], ...overrides });
    const relay = await env.blockchain.treasury('relay');
    if (genesis) await env.minter.sendGenesis(env.deployer.getSender(), toNano('0.3'));
    return { env, relay };
}

const refusedForbidden = (r: any) => assert.equal(rejectReason(r), REJECT_FORBIDDEN_RECIPIENT, `raison « destinataire interdit » attendue\n${describeTxs(r)}`);

describe('A16 : création vers une adresse interdite de réception', () => {
    it('bon de récompense (1er achat, mission, parrainage) vers le relais : refusé, rien de créé, réservation rendue', async () => {
        const { env, relay } = await withRelay();
        const referral = { kind: Kind.REFERRAL, level: 1, points: 5000n, waveAmount: 10000n, amount: consom(125) };
        for (const o of [
            { kind: Kind.FIRST_PURCHASE, points: 0n, waveAmount: 1000n, amount: consom(500) },   // passe par le budget de paiement
            { kind: Kind.MISSION_TG, points: 0n, waveAmount: 0n, amount: consom(150) },          // directement au compte membre
            referral,                                                                           // passe par le budget de paiement
        ]) {
            const before = await reserves(env);
            const supply = (await env.minter.getJettonData()).totalSupply;
            const v = env.voucher({ ...o, recipient: relay.address });
            const r = await env.claim(v);
            refusedForbidden(r);
            assert.deepEqual(await reserves(env), before, `réservation rendue (type ${o.kind})`);
            assert.equal(await env.balanceOf(relay.address), 0n, 'rien n\'est créé pour le relais');
            assert.equal((await env.minter.getJettonData()).totalSupply, supply, 'offre inchangée');
            assert.equal(hasTx(r, { op: Op.MintApproved }), false);
        }
    });

    it('le refus du budget ne marque pas l\'emplacement : le même paiement pourra être présenté avec le bon destinataire', async () => {
        const { env, relay } = await withRelay();
        await env.becomeEligible();                                                              // le membre a fait une prévente
        const waveRef = 0x777n;
        const make = (recipient: Address) => env.voucher({ kind: Kind.FIRST_PURCHASE, waveRef, waveAmount: 1000n, amount: consom(500), recipient });
        refusedForbidden(await env.claim(make(relay.address)));
        assert.equal((await env.budgetState(waveRef))?.slots ?? 0, 0, 'emplacement non marqué');
        assert.ok(approved(await env.claim(make(env.member.address))), 'avec le bon destinataire, le même paiement passe');
        assert.equal(await env.balanceOf(env.member.address), consom(3_500));
    });

    it('pack de prévente vers le relais : refusé, réserve de prévente rendue', async () => {
        const { env, relay } = await withRelay();
        const before = await reserves(env);
        const r = await env.claim(env.voucher({ recipient: relay.address }));                   // pack Essentiel par défaut
        refusedForbidden(r);
        assert.deepEqual(await reserves(env), before);
        assert.equal(await env.balanceOf(relay.address), 0n);
        assert.equal((await env.minter.getCaps()).presale, INITIAL_CAPS.presale);
    });

    it('réclamation d\'un Ancien Contributeur vers le relais : refusée, réserve et parts à attribuer rendues', async () => {
        const { env, relay } = await withRelay({}, true);
        const before = await reserves(env);
        const bank = await env.bankState();
        const v = env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: consom(100_000), waveRef: 0n, waveAmount: 0n, points: 0n, memberId: 777n, recipient: relay.address });
        const r = await env.claim(v);
        refusedForbidden(r);
        assert.deepEqual(await reserves(env), before, 'réserve des 30 % et parts à attribuer rendues');
        assert.equal(await env.balanceOf(relay.address), 0n);
        assert.equal(await env.shareState(relay.address), null, 'aucune part attribuée');
        assert.deepEqual(await env.bankState(), bank, 'banque inchangée');
        assert.equal((await env.memberState(777n))?.initialized ?? false, false, 'le compte membre n\'est pas lié au relais');
    });

    it('contribution du lancement anticipé vers le relais : refusée, réserve de prévente et retenue rendues', async () => {
        const total = consom(1_000_000);
        const { env, relay } = await withRelay({ earlyContributionsTotal: total }, true);
        const before = await reserves(env);
        const bank = await env.bankState();
        const v = env.voucher({ kind: Kind.EARLY_CONTRIBUTION, amount: consom(20_000), waveRef: 0xe001n, waveAmount: 0n, points: 0n, memberId: 1n, recipient: relay.address });
        const r = await env.claim(v);
        refusedForbidden(r);
        assert.deepEqual(await reserves(env), before, 'réserve de prévente et retenue rendues');
        assert.equal((await env.minter.getCaps()).earlyHold, total);
        assert.equal(await env.balanceOf(relay.address), 0n);
        assert.equal(await env.shareState(relay.address), null);
        assert.deepEqual(await env.bankState(), bank);
        // la même contribution, avec la vraie adresse du contributeur, passe ensuite
        assert.ok(approved(await env.claim({ ...v, recipient: env.member.address })));
        assert.equal(await env.balanceOf(env.member.address), consom(6_000));
    });

    it('toutes les adresses de la liste sont refusées, pas seulement la première', async () => {
        const list: Address[] = [];
        for (let i = 0; i < 8; i++) list.push(await addressOf(`interdit-${i}`));
        const env = await setup({ forbiddenRecipients: list });
        for (let i = 0; i < 8; i++) {
            const holder = await env.blockchain.treasury(`interdit-${i}`);
            refusedForbidden(await env.claim(env.voucher({ recipient: holder.address })));
            assert.equal(await env.balanceOf(holder.address), 0n);
        }
        assert.ok(approved(await env.claim(env.voucher())), 'une adresse hors liste est acceptée');
    });

    it('un bon dont le destinataire est l\'émetteur ou la banque : refusé (même sans liste)', async () => {
        const env = await setup();
        for (const recipient of [env.minter.address, env.bankAddress]) {
            const before = await reserves(env);
            const r = await env.claim(env.voucher({ recipient }));
            refusedForbidden(r);
            assert.deepEqual(await reserves(env), before);
            assert.equal(hasTx(r, { op: Op.MintApproved }), false);
        }
        // direct au compte membre aussi
        refusedForbidden(await env.claim(env.voucher({ kind: Kind.MISSION_TG, amount: consom(150), recipient: env.bankAddress })));
        assert.equal(await env.balanceOf(env.bankAddress), 0n);
    });

    it('une adresse interdite ne bloque pas les autres : un membre normal reste servi', async () => {
        const { env } = await withRelay();
        assert.ok(approved(await env.claim(env.voucher())));
        assert.equal(await env.balanceOf(env.member.address), consom(3_000));
    });
});

describe('A16 : le relais peut présenter des bons et payer les frais', () => {
    it('le relais PRÉSENTE un bon pour un membre : accepté, les ConsoM vont au membre, rien au relais', async () => {
        const { env, relay } = await withRelay();
        const r = await env.claim(env.voucher(), { from: relay });
        assert.ok(approved(r), describeTxs(r));
        assert.equal(await env.balanceOf(env.member.address), consom(3_000));
        assert.equal(await env.balanceOf(relay.address), 0n, 'le relais ne reçoit aucun ConsoM');
    });

    it('le relais présente aussi une récompense directe et une réclamation d\'Ancien Contributeur pour un membre', async () => {
        const { env, relay } = await withRelay({}, true);
        await env.claim(env.voucher(), { from: relay });                                        // prévente : éligibilité
        const mission = env.voucher({ kind: Kind.MISSION_TG, amount: consom(150) });
        assert.ok(approved(await env.claim(mission, { from: relay })));
        const founder = env.voucher({ kind: Kind.FOUNDER_CLAIM, amount: consom(100_000), waveRef: 0n, waveAmount: 0n, points: 0n, memberId: 9n });
        assert.ok(approved(await env.claim(founder, { from: relay })));
        assert.equal(await env.balanceOf(env.member.address), consom(3_000 + 150 + 30_000));
        assert.equal((await env.shareState(env.member.address))!.shares, consom(70_000));
        assert.equal(await env.balanceOf(relay.address), 0n);
        assert.equal(await env.shareState(relay.address), null);
    });

    it('une conversion via la banque présentée par le relais : inchangée (acceptée, résultat envoyé au relais)', async () => {
        const { env, relay } = await withRelay({}, true);
        const before = await env.bankState();
        const conversion = env.voucher({ kind: Kind.BANK_CONVERSION, points: 1_000_000n, waveAmount: 0n, amount: 0n });
        const r = await env.claim(conversion, { from: relay });
        const after = await env.bankState();
        assert.equal(after.depositorStock, before.depositorStock - consom(100_000), 'la banque a brûlé');
        const resultTx = r.transactions.find((t: any) => t.inMessage?.body.beginParse().remainingBits >= 32
            && t.inMessage.body.beginParse().loadUint(32) === Op.ConversionResult);
        const result = decodeConversionResult(resultTx!.inMessage!.body)!;
        assert.equal(result.accepted, true);
        assert.equal(result.burned, consom(100_000));
        assert.ok(resultTx!.inMessage!.info.type === 'internal' && resultTx!.inMessage!.info.dest.equals(relay.address), 'le résultat revient à celui qui a présenté le bon');
        assert.equal(await env.balanceOf(relay.address), 0n);
    });

    it('une conversion n\'est pas une création : la liste ne s\'y applique pas (bon dont le bénéficiaire est une adresse de la liste)', async () => {
        const { env, relay } = await withRelay({}, true);
        const before = await env.bankState();
        const conversion = env.voucher({ kind: Kind.BANK_CONVERSION, points: 1_000_000n, waveAmount: 0n, amount: 0n, recipient: relay.address });
        const r = await env.claim(conversion, { from: relay });
        assert.notEqual(rejectReason(r), REJECT_FORBIDDEN_RECIPIENT);
        assert.equal((await env.bankState()).depositorStock, before.depositorStock - consom(100_000));
    });
});

// ---------- Déploiement ----------

// Déploie à la main, SANS les contrôles du wrapper : le contrat doit refuser lui-même
async function rawDeploy(env: Env, bad: Partial<MinterConfig>) {
    const config = { ...env.config, ...bad } as MinterConfig;
    const init = { code: env.codes.minterCode, data: minterConfigToCell(config) };
    const address = contractAddress(0, init);
    const result = await env.deployer.send({ to: address, value: toNano('1'), init, body: beginCell().endCell() });
    return { address, result };
}

const newKey = (seed: number) => keyPairFromSeed(Buffer.alloc(32, seed)).publicKey;

describe('A3 : contrôles au déploiement — le wrapper arrête le déploiement avec un message clair', () => {
    it('deux clés de témoins identiques', async () => {
        const base = await setup();
        const [a, b] = base.config.witnessKeys;
        for (const keys of [[a, a, b], [a, b, a], [a, b, b]] as [Buffer, Buffer, Buffer][]) {
            await assert.rejects(setup({ witnessKeys: keys }), /identiques/);
        }
    });

    it('une clé de témoin à zéro', async () => {
        const base = await setup();
        const [a, b] = base.config.witnessKeys;
        for (const keys of [[Buffer.alloc(32), a, b], [a, Buffer.alloc(32), b], [a, b, Buffer.alloc(32)]] as [Buffer, Buffer, Buffer][]) {
            await assert.rejects(setup({ witnessKeys: keys }), /vide \(zéro\)/);
        }
    });

    it('adresse de l\'équipe dans la liste interdite : le déploiement échoue avec une erreur claire', async () => {
        const base = await setup();
        const other = (await base.blockchain.treasury('autre')).address;
        for (const list of [[base.team.address], [other, base.team.address], [other, other, other, base.team.address]]) {
            await assert.rejects(setup({ forbiddenRecipients: list }), /adresse de l'équipe figure dans la liste/);
        }
    });

    it('gardien vide ; équipe vide', async () => {
        await assert.rejects(setup({ guardian: ZERO_ADDRESS }), /adresse du gardien est vide/);
        await assert.rejects(setup({ guardian: null as any }), /adresse du gardien est vide/);
        await assert.rejects(setup({ teamAddress: ZERO_ADDRESS }), /adresse de l'équipe est vide/);
        await assert.rejects(setup({ teamAddress: null as any }), /adresse de l'équipe est vide/);
    });

    it('gardien ou équipe égal à l\'émetteur ou à la banque', async () => {
        const env = await setup();
        const minter = env.minter.address;
        const bank = env.bankAddress;
        for (const [guardian, team, re] of [
            [bank, env.team.address, /gardien ne peut pas être l'émetteur ni la banque/],
            [minter, env.team.address, /gardien ne peut pas être l'émetteur ni la banque/],
            [env.guardian.address, bank, /l'équipe ne peut pas être l'émetteur ni la banque/],
            [env.guardian.address, minter, /l'équipe ne peut pas être l'émetteur ni la banque/],
        ] as [Address, Address, RegExp][]) {
            assert.throws(() => assertValidMinterConfig({ ...env.config, guardian, teamAddress: team }, minter, bank), re);
        }
        // une configuration normale passe
        assert.doesNotThrow(() => assertValidMinterConfig(env.config, minter, bank));
    });

    it('plus de 8 adresses interdites ; une adresse vide dans la liste', async () => {
        const base = await setup();
        const nine: Address[] = [];
        for (let i = 0; i < 9; i++) nine.push((await base.blockchain.treasury(`n${i}`)).address);
        await assert.rejects(setup({ forbiddenRecipients: nine }), /8 au plus/);
        await assert.rejects(setup({ forbiddenRecipients: [ZERO_ADDRESS] }), /adresse vide/);
    });
});

describe('A3 / A16 : un contrat gravé de travers refuse tout, même si on contourne le wrapper', () => {
    // Le contrat contrôle ses données gravées à CHAQUE message, y compris le tout premier (celui du déploiement) :
    // si elles sont interdites, tous les messages échouent, rien ne peut jamais être créé, et personne ne peut le corriger.
    const expectRefused = async (bad: Partial<MinterConfig>, code: number | null) => {
        const env = await setup();
        const { address, result } = await rawDeploy(env, bad);
        const failed = (r: { transactions: any[] }) => {
            const tx = r.transactions.find((t: any) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(address));
            assert.ok(tx, describeTxs(r));
            const d = tx.description as any;
            assert.ok(d.aborted || d.computePhase.type !== 'vm' || !d.computePhase.success, 'le message est refusé\n' + describeTxs(r));
            if (code !== null) assert.equal(d.computePhase.exitCode, code);
        };
        failed(result);                                                  // le message de déploiement échoue

        // et le contrat reste inutilisable : un message vide, puis un bon valable signé par les témoins, échouent aussi
        failed(await env.deployer.send({ to: address, value: toNano('0.5'), body: beginCell().endCell() }));
        const v = voucherToCell({ ...env.voucher(), minter: address });
        const body = claimBody(0n, v, signVoucher(v, 0, env.witnesses[0].secretKey), signVoucher(v, 1, env.witnesses[1].secretKey));
        const claim = await env.member.send({ to: address, value: toNano('0.5'), body });
        failed(claim);
        assert.equal(hasTx(claim, { op: Op.MintApproved }), false, 'rien n\'est créé');
    };

    it('deux clés identiques → code 480', async () => {
        const base = await setup();
        const [a, b] = base.config.witnessKeys;
        await expectRefused({ witnessKeys: [a, a, b] }, Err.DEPLOY_SAME_KEYS);
        await expectRefused({ witnessKeys: [a, b, b] }, Err.DEPLOY_SAME_KEYS);
        await expectRefused({ witnessKeys: [a, b, a] }, Err.DEPLOY_SAME_KEYS);
    });
    it('une clé à zéro → code 427', async () => {
        const base = await setup();
        const [a, b] = base.config.witnessKeys;
        await expectRefused({ witnessKeys: [a, Buffer.alloc(32), b] }, Err.ZERO_KEY);
        await expectRefused({ witnessKeys: [Buffer.alloc(32), a, b] }, Err.ZERO_KEY);
    });
    it('gardien vide → refusé (adresse nulle : code 481 ; adresse absente : données illisibles)', async () => {
        await expectRefused({ guardian: ZERO_ADDRESS }, Err.DEPLOY_NO_GUARDIAN);
        await expectRefused({ guardian: null as any }, null);
    });
    it('équipe vide → refusé (adresse nulle : code 482 ; adresse absente : données illisibles)', async () => {
        await expectRefused({ teamAddress: ZERO_ADDRESS }, Err.DEPLOY_NO_TEAM);
        await expectRefused({ teamAddress: null as any }, null);
    });
    it('équipe dans la liste interdite → code 485 (en 1re, 2e ou 4e position)', async () => {
        const base = await setup();
        const x = await addressOf('x');
        await expectRefused({ forbiddenRecipients: [base.team.address] }, Err.DEPLOY_TEAM_FORBIDDEN);
        await expectRefused({ forbiddenRecipients: [x, base.team.address] }, Err.DEPLOY_TEAM_FORBIDDEN);
        await expectRefused({ forbiddenRecipients: [x, x, x, base.team.address] }, Err.DEPLOY_TEAM_FORBIDDEN);
    });
    it('9 adresses, ou une adresse vide dans la liste → code 486', async () => {
        const base = await setup();
        const nine: Address[] = [];
        for (let i = 0; i < 9; i++) nine.push((await base.blockchain.treasury(`n${i}`)).address);
        await expectRefused({ forbiddenRecipients: nine }, Err.DEPLOY_FORBIDDEN_LIST);
        await expectRefused({ forbiddenRecipients: [ZERO_ADDRESS] }, Err.DEPLOY_FORBIDDEN_LIST);
    });
    it('une configuration valable, elle, est acceptée par le même chemin', async () => {
        const env = await setup();
        const { address, result } = await rawDeploy(env, {});
        assert.ok(hasTx(result, { to: address, success: true }), describeTxs(result));
    });
});

describe('A16 : liste gravée, lisible, jamais modifiable', () => {
    it('déploiement accepté avec une liste vide ; le getter renvoie une liste vide', async () => {
        const env = await setup({ forbiddenRecipients: [] });
        assert.deepEqual(await env.minter.getForbiddenRecipients(), []);
        assert.ok(approved(await env.claim(env.voucher())));
    });

    it('déploiement accepté avec 1, 2, 3, 4, 7 et 8 adresses ; le getter renvoie exactement la liste gravée, dans l\'ordre', async () => {
        const all: Address[] = [];
        for (let i = 0; i < 8; i++) all.push(await addressOf(`liste-${i}`));
        for (const n of [1, 2, 3, 4, 7, 8]) {
            const list = all.slice(0, n);
            const env = await setup({ forbiddenRecipients: list });
            const got = await env.minter.getForbiddenRecipients();
            assert.equal(got.length, n);
            got.forEach((a, i) => assert.ok(a.equals(list[i]), `adresse ${i} de la liste de ${n}`));
        }
    });

    it('l\'ordre gravé est conservé (liste renversée)', async () => {
        const all: Address[] = [];
        for (let i = 0; i < 8; i++) all.push(await addressOf(`liste-${i}`));
        const env = await setup({ forbiddenRecipients: [...all].reverse() });
        const got = await env.minter.getForbiddenRecipients();
        got.forEach((a, i) => assert.ok(a.equals(all[7 - i])));
    });

    it('aucun message ne peut modifier la liste : les messages d\'administration n\'existent pas', async () => {
        const { env, relay } = await withRelay();
        // un inconnu essaie des opérations hors catalogue : toutes refusées, la liste reste la même
        for (const op of [0xc0150070, 0xc0150071, 0xc0150072]) {
            const r = await env.stranger.send({ to: env.minter.address, value: toNano('0.2'), body: beginCell().storeUint(op, 32).storeUint(0, 64).storeAddress(env.stranger.address).endCell() });
            assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: 0xFFFF }), describeTxs(r));
        }
        const got = await env.minter.getForbiddenRecipients();
        assert.equal(got.length, 1);
        assert.ok(got[0].equals(relay.address));
        // le gardien lui-même ne peut pas la changer (il ne peut que mettre en pause et remplacer un témoin)
        const r = await env.guardian.send({ to: env.minter.address, value: toNano('0.2'), body: beginCell().storeUint(0xc0150070, 32).storeUint(0, 64).endCell() });
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: 0xFFFF }));
    });
});

describe('A3 : remplacement d\'un témoin (délai de 7 jours)', () => {
    const propose = (env: Env, index: number, key: bigint) => env.guardian.send({
        to: env.minter.address, value: toNano('0.05'),
        body: beginCell().storeUint(Op.ProposeWitness, 32).storeUint(0, 64).storeUint(index, 8).storeUint(key, 256).endCell(),
    });
    const asBig = (k: Buffer) => BigInt('0x' + k.toString('hex'));

    it('refuse une clé déjà présente, quel que soit l\'emplacement visé', async () => {
        const env = await setup();
        for (let target = 0; target < 3; target++) {
            for (let present = 0; present < 3; present++) {
                const r = await propose(env, target, asBig(env.config.witnessKeys[present]));
                assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.DUPLICATE_KEY }), `emplacement ${target}, clé ${present}\n${describeTxs(r)}`);
            }
        }
        assert.equal((await env.minter.getWitnessKeys()).pending, null, 'rien en attente');
    });

    it('refuse une clé à zéro (sinon le contrat se bloquerait lui-même)', async () => {
        const env = await setup();
        const r = await propose(env, 2, 0n);
        assert.ok(hasTx(r, { to: env.minter.address, success: false, exitCode: Err.ZERO_KEY }), describeTxs(r));
        assert.equal((await env.minter.getWitnessKeys()).pending, null);
    });

    it('une clé nouvelle est acceptée, puis remplace le témoin après 7 jours ; le contrat reste valable', async () => {
        const env = await setup();
        const fresh = newKey(9);
        assert.ok(hasTx(await propose(env, 2, asBig(fresh)), { to: env.minter.address, success: true }));
        env.blockchain.now = (env.blockchain.now ?? 0) + 7 * 86_400;
        await env.minter.sendExecuteWitness(env.guardian.getSender());
        assert.equal((await env.minter.getWitnessKeys()).key2, asBig(fresh));
        assert.ok(approved(await env.claim(env.voucher({ validUntil: (env.blockchain.now ?? 0) + 3600 }))), 'le contrat fonctionne toujours');
    });
});
