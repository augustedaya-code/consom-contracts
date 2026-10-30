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
        const keys = [1, 2, 3].map((i) => keyPairFromSeed(Buffer.alloc(32, i)).publicKey) as [Buffer, Buffer, Buffer];
        const res = await deployConsoM({
            network: 'testnet', t0: 1_800_000_000, guardian: guardian.address, teamAddress: team.address, witnessPublicKeys: keys,
            content: jettonContent('https://example.com/consom.json'),
        }, {
            open: (c) => blockchain.openContract(c) as any,
            sender: deployer.getSender(),
            waitFor: async () => {},
            log: () => {},
        });
        const minter = blockchain.openContract(new (await import('../wrappers/ConsoMMinter.ts')).ConsoMMinter(res.minter));
        assert.equal((await minter.getState()).genesisDone, true);
        assert.equal((await minter.getJettonData()).totalSupply, consom(3_600_000));
        const bank = blockchain.openContract(new ExchangeBank(res.bank));
        assert.equal((await bank.getState()).depositorStock, consom(3_500_000));
        assert.ok((await minter.getTeamAddress()).equals(team.address), 'l\'adresse de l\'équipe est gravée au déploiement');
        assert.equal(res.teamAddress.toString(), team.address.toString());
    });
});
