// Le script de déploiement, exécuté dans le simulateur : mêmes étapes que sur le testnet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain } from '@ton/sandbox';
import { keyPairFromSeed } from '@ton/crypto';
import { deployConsoM, jettonContent } from '../scripts/deploy.ts';
import { consom } from '../wrappers/ConsoMMinter.ts';
import { ExchangeBank } from '../wrappers/ExchangeBank.ts';

describe('Script de déploiement', () => {
    it('déploie l\'émetteur et la banque, puis fait le dépôt de genèse', async () => {
        const blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000;
        const deployer = await blockchain.treasury('deployer');
        const guardian = await blockchain.treasury('guardian');
        const team = await blockchain.treasury('team');
        const relay = await blockchain.treasury('relay');
        const keys = [1, 2, 3].map((i) => keyPairFromSeed(Buffer.alloc(32, i)).publicKey) as [Buffer, Buffer, Buffer];
        const logs: string[] = [];
        const res = await deployConsoM({
            network: 'testnet', t0: 1_800_000_000, guardian: guardian.address, teamAddress: team.address, earlyContributionsTotal: 0n, forbiddenRecipients: [relay.address], witnessPublicKeys: keys,
            content: jettonContent('https://example.com/consom.json'),
        }, {
            open: (c) => blockchain.openContract(c) as any,
            sender: deployer.getSender(),
            waitFor: async () => {},
            log: (m) => logs.push(m),
        });
        const minter = blockchain.openContract(new (await import('../wrappers/ConsoMMinter.ts')).ConsoMMinter(res.minter));
        assert.equal((await minter.getState()).genesisDone, true);
        assert.equal((await minter.getJettonData()).totalSupply, consom(3_600_000));
        const bank = blockchain.openContract(new ExchangeBank(res.bank));
        assert.equal((await bank.getState()).depositorStock, consom(3_500_000));
        assert.ok((await minter.getTeamAddress()).equals(team.address), 'l\'adresse de l\'équipe est gravée au déploiement');
        assert.equal(res.teamAddress.toString(), team.address.toString());
        const engraved = await minter.getForbiddenRecipients();
        assert.equal(engraved.length, 1);
        assert.ok(engraved[0].equals(relay.address), 'la liste interdite est gravée au déploiement');
        assert.equal(logs.some((m) => m.includes('AVERTISSEMENT')), false, 'pas d\'avertissement quand la liste est renseignée');
    });

    it('liste interdite vide : le déploiement va au bout mais avertit clairement', async () => {
        const blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000;
        const deployer = await blockchain.treasury('deployer');
        const guardian = await blockchain.treasury('guardian');
        const team = await blockchain.treasury('team');
        const keys = [1, 2, 3].map((i) => keyPairFromSeed(Buffer.alloc(32, i)).publicKey) as [Buffer, Buffer, Buffer];
        const logs: string[] = [];
        const res = await deployConsoM({
            network: 'testnet', t0: 1_800_000_000, guardian: guardian.address, teamAddress: team.address, earlyContributionsTotal: 0n,
            forbiddenRecipients: [], witnessPublicKeys: keys, content: jettonContent('https://example.com/consom.json'),
        }, { open: (c) => blockchain.openContract(c) as any, sender: deployer.getSender(), waitFor: async () => {}, log: (m) => logs.push(m) });
        assert.ok(logs.some((m) => m.includes('AVERTISSEMENT') && m.includes('VIDE')), logs.join('\n'));
        const minter = blockchain.openContract(new (await import('../wrappers/ConsoMMinter.ts')).ConsoMMinter(res.minter));
        assert.deepEqual(await minter.getForbiddenRecipients(), []);
    });

    it('configuration interdite (équipe dans la liste) : le script s\'arrête avant d\'envoyer quoi que ce soit', async () => {
        const blockchain = await Blockchain.create();
        const deployer = await blockchain.treasury('deployer');
        const guardian = await blockchain.treasury('guardian');
        const team = await blockchain.treasury('team');
        const keys = [1, 2, 3].map((i) => keyPairFromSeed(Buffer.alloc(32, i)).publicKey) as [Buffer, Buffer, Buffer];
        let sent = 0;
        const sender = { address: deployer.address, send: async () => { sent++; } };
        await assert.rejects(deployConsoM({
            network: 'testnet', t0: 1_800_000_000, guardian: guardian.address, teamAddress: team.address, earlyContributionsTotal: 0n,
            forbiddenRecipients: [team.address], witnessPublicKeys: keys, content: jettonContent('https://example.com/consom.json'),
        }, { open: (c) => blockchain.openContract(c) as any, sender, waitFor: async () => {}, log: () => {} }), /adresse de l'équipe figure dans la liste/);
        assert.equal(sent, 0);
    });
});
