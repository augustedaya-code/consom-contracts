// Tests de la part de l'équipe (livre blanc v5.0, règle A9) : 5 000 000 ConsoM, rien avant 12 mois,
// puis 1/24 par période de 30 jours, tout libéré à T0 + 36 mois. L'adresse de l'équipe est gravée au déploiement.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toNano } from '@ton/core';
import { setup, hasTx, describeTxs, T0, DAY } from './helpers.ts';
import { consom, Kind, Err, INITIAL_CAPS } from '../wrappers/ConsoMMinter.ts';

const TEAM_TOTAL = consom(5_000_000);
const PERIOD = 30 * DAY;
const CLIFF = 12 * PERIOD;                          // T0 + 12 mois
const END = CLIFF + 24 * PERIOD;                    // T0 + 36 mois
const PART = TEAM_TOTAL / 24n;                      // 1/24, arrondi vers le bas (la dernière part prend le reste)

const refusedWith = (r: any, minter: any, code: number) =>
    assert.ok(hasTx(r, { to: minter, success: false, exitCode: code }), `refus attendu (code ${code})\n${describeTxs(r)}`);

describe('Part de l\'équipe : calendrier', () => {
    it('l\'adresse de l\'équipe est celle gravée au déploiement', async () => {
        const env = await setup();
        assert.ok((await env.minter.getTeamAddress()).equals(env.team.address));
    });

    it('rien n\'est libéré avant T0 + 12 mois, même en le demandant', async () => {
        const env = await setup();
        for (const t of [0, 30 * DAY, 200 * DAY, CLIFF - 1, CLIFF]) {
            env.blockchain.now = T0 + t;
            const v = await env.minter.getTeamVesting();
            assert.equal(v.unlocked, 0n, `à T0 + ${t} s`);
            assert.equal(v.created, 0n);
            refusedWith(await env.minter.sendReleaseTeam(env.stranger.getSender()), env.minter.address, Err.NOTHING_TO_RELEASE);
        }
        assert.equal(await env.balanceOf(env.team.address), 0n);
        assert.equal((await env.minter.getJettonData()).totalSupply, 0n);
        assert.equal((await env.minter.getCaps()).team, TEAM_TOTAL);
    });

    it('la première part (1/24) est libérée une période de 30 jours après T0 + 12 mois', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + PERIOD - 1;
        assert.equal((await env.minter.getTeamVesting()).unlocked, 0n, 'une seconde avant la fin de la période');
        env.blockchain.now = T0 + CLIFF + PERIOD;
        const v = await env.minter.getTeamVesting();
        assert.equal(v.unlocked, PART);
        assert.equal(v.nextReleaseAt, T0 + CLIFF + 2 * PERIOD);
    });

    it('la prochaine date de libération avance de période en période, puis vaut 0 quand tout est libéré', async () => {
        const env = await setup();
        assert.equal((await env.minter.getTeamVesting()).nextReleaseAt, T0 + CLIFF + PERIOD, 'avant le blocage : la première part');
        env.blockchain.now = T0 + CLIFF + 5 * PERIOD + 10;
        assert.equal((await env.minter.getTeamVesting()).nextReleaseAt, T0 + CLIFF + 6 * PERIOD);
        env.blockchain.now = T0 + END - 1;
        assert.equal((await env.minter.getTeamVesting()).nextReleaseAt, T0 + END);
        env.blockchain.now = T0 + END;
        const v = await env.minter.getTeamVesting();
        assert.equal(v.unlocked, TEAM_TOTAL, 'tout est libéré à T0 + 36 mois');
        assert.equal(v.nextReleaseAt, 0);
    });

    it('24 libérations, une par période : le total est exactement 5 000 000 (la dernière prend le reste)', async () => {
        const env = await setup();
        let expected = 0n;
        for (let k = 1; k <= 24; k++) {
            env.blockchain.now = T0 + CLIFF + k * PERIOD;
            const r = await env.minter.sendReleaseTeam(env.stranger.getSender());
            assert.ok(hasTx(r, { to: env.minter.address, success: true }), describeTxs(r));
            expected = k < 24 ? BigInt(k) * PART : TEAM_TOTAL;
            assert.equal(await env.balanceOf(env.team.address), expected, `après la période ${k}`);
        }
        assert.equal(expected, TEAM_TOTAL);
        const caps = await env.minter.getCaps();
        assert.equal(caps.team, 0n, 'la réserve équipe est vide');
        assert.equal((await env.minter.getJettonData()).totalSupply, TEAM_TOTAL);
        env.blockchain.now = T0 + END + 10 * DAY;
        refusedWith(await env.minter.sendReleaseTeam(env.stranger.getSender()), env.minter.address, Err.NOTHING_TO_RELEASE);
        assert.equal(await env.balanceOf(env.team.address), TEAM_TOTAL, 'jamais plus que 5 000 000');
    });
});

describe('Part de l\'équipe : opération « libérer »', () => {
    it('n\'importe qui peut l\'appeler : les ConsoM vont à l\'équipe, jamais à l\'appelant', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + 3 * PERIOD;
        const r = await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.ok(hasTx(r, { to: env.minter.address, success: true }), describeTxs(r));
        assert.equal(await env.balanceOf(env.team.address), 3n * PART);
        assert.equal(await env.balanceOf(env.stranger.address), 0n);
        const v = await env.minter.getTeamVesting();
        assert.equal(v.created, 3n * PART);
        assert.equal(v.unlocked, 3n * PART);
    });

    it('crée seulement la différence entre ce qui est libéré et ce qui a déjà été créé', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + 2 * PERIOD;
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.equal(await env.balanceOf(env.team.address), 2n * PART);
        // un second appel au même instant ne crée rien
        refusedWith(await env.minter.sendReleaseTeam(env.member.getSender()), env.minter.address, Err.NOTHING_TO_RELEASE);
        assert.equal(await env.balanceOf(env.team.address), 2n * PART);
        // plusieurs périodes plus tard : seulement les périodes manquantes
        env.blockchain.now = T0 + CLIFF + 7 * PERIOD + 5 * DAY;
        await env.minter.sendReleaseTeam(env.member.getSender());
        assert.equal(await env.balanceOf(env.team.address), 7n * PART);
        assert.equal((await env.minter.getCaps()).team, TEAM_TOTAL - 7n * PART);
    });

    it('puise uniquement dans la réserve équipe (les autres réserves ne bougent pas)', async () => {
        const env = await setup();
        const before = await env.minter.getCaps();
        env.blockchain.now = T0 + CLIFF + PERIOD;
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        const after = await env.minter.getCaps();
        assert.equal(after.team, INITIAL_CAPS.team - PART);
        for (const k of ['presale', 'purchase', 'referral', 'missions', 'founders', 'chika', 'foundation'] as const) {
            assert.equal(after[k], before[k], `la réserve ${k} ne doit pas bouger`);
        }
    });

    it('n\'est pas soumise à la fenêtre de 24 mois des récompenses, ni au plafond de 50 000 par membre', async () => {
        const env = await setup();
        env.blockchain.now = T0 + END;     // 36 mois : toutes les réserves de récompenses sont fermées depuis longtemps
        assert.equal((await env.minter.getCaps()).purchase, 0n);
        const r = await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.ok(hasTx(r, { to: env.minter.address, success: true }), describeTxs(r));
        assert.ok(await env.balanceOf(env.team.address) > consom(50_000), 'bien au-delà de 50 000 en une fois');
    });

    it('compte dans le plafond global de 2 000 000 par 24 h : ce qui ne passe pas aujourd\'hui est libéré plus tard', async () => {
        const env = await setup();
        env.blockchain.now = T0 + END;     // 5 000 000 dus d'un coup
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.equal(await env.balanceOf(env.team.address), consom(2_000_000), 'le plafond du jour limite la création');
        assert.equal((await env.minter.getCaps()).dayMinted, consom(2_000_000), 'elle compte dans le compteur du jour');
        assert.equal((await env.minter.getTeamVesting()).unlocked, TEAM_TOTAL, 'le calendrier ne change pas');
        // le même jour : plus de place
        refusedWith(await env.minter.sendReleaseTeam(env.stranger.getSender()), env.minter.address, Err.DAILY_CAP);
        assert.equal(await env.balanceOf(env.team.address), consom(2_000_000));
        // les jours suivants : le reste, jusqu'à 5 000 000 exactement
        env.blockchain.now = T0 + END + DAY;
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.equal(await env.balanceOf(env.team.address), consom(4_000_000));
        env.blockchain.now = T0 + END + 2 * DAY;
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.equal(await env.balanceOf(env.team.address), TEAM_TOTAL);
        assert.equal((await env.minter.getCaps()).team, 0n);
    });

    it('est bloquée par la pause du gardien', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + 3 * PERIOD;
        await env.minter.sendPause(env.guardian.getSender());
        refusedWith(await env.minter.sendReleaseTeam(env.stranger.getSender()), env.minter.address, Err.PAUSED);
        assert.equal(await env.balanceOf(env.team.address), 0n);
        assert.equal((await env.minter.getCaps()).team, TEAM_TOTAL, 'rien n\'a bougé');
        env.blockchain.now = T0 + CLIFF + 3 * PERIOD + 15 * DAY;     // la pause finit toute seule après 14 jours
        await env.minter.sendReleaseTeam(env.stranger.getSender());
        assert.equal(await env.balanceOf(env.team.address), 3n * PART, 'la libération reprend après la pause (15 jours : pas de période de plus)');
    });

    it('refuse un envoi avec trop peu de TON', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + PERIOD;
        const r = await env.minter.sendReleaseTeam(env.stranger.getSender(), toNano('0.05'));
        refusedWith(r, env.minter.address, Err.NOT_ENOUGH_TON);
        assert.equal(await env.balanceOf(env.team.address), 0n);
    });

    it('l\'appelant ne perd que les frais : l\'excédent de TON lui revient', async () => {
        const env = await setup();
        env.blockchain.now = T0 + CLIFF + PERIOD;
        const before = (await env.blockchain.getContract(env.stranger.address)).balance;
        await env.minter.sendReleaseTeam(env.stranger.getSender(), toNano('1'));
        const after = (await env.blockchain.getContract(env.stranger.address)).balance;
        assert.ok(before - after < toNano('0.15'), `frais trop élevés : ${before - after}`);
    });
});
