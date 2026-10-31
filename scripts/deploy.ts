// Déploiement de ConsoM : émetteur, banque d'échange, puis dépôt de genèse des Anciens Contributeurs.
//
// Utilisation (testnet) :
//   TESTNET_DEPLOYER_MNEMONIC="24 mots"  GUARDIAN_ADDRESS="0Q..."  TEAM_ADDRESS="0Q..."  EARLY_CONTRIBUTIONS_TOTAL="0"  node scripts/deploy.ts testnet
// Variables facultatives : TONCENTER_API_KEY, T0 (secondes Unix ; par défaut : maintenant).
// Les clés publiques des témoins viennent de deployments/<réseau>.config.json.
// Le résultat (adresses, empreintes des codes) est écrit dans deployments/<réseau>.json et dans le résumé GitHub.
import { Address, beginCell, toNano } from '@ton/core';
import type { Cell, Contract, OpenedContract, Sender } from '@ton/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileTolk } from './compile.ts';
import { ConsoMMinter, NETWORK_MAINNET, NETWORK_TESTNET } from '../wrappers/ConsoMMinter.ts';
import type { MinterConfig } from '../wrappers/ConsoMMinter.ts';
import { ExchangeBank } from '../wrappers/ExchangeBank.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export type DeployConfig = {
    network: 'testnet' | 'mainnet';
    t0: number;
    guardian: Address;
    teamAddress: Address;    // portefeuille Multisig de l'équipe : gravé au déploiement
    earlyContributionsTotal: bigint;   // total (unités de base) des contributions du lancement anticipé : gravé, retenu dans la réserve de prévente
    witnessPublicKeys: [Buffer, Buffer, Buffer];
    content: Cell;
};

export type DeployTarget = {
    open<T extends Contract>(c: T): OpenedContract<T>;
    sender: Sender;
    // attend que l'opération précédente soit incluse dans la blockchain et que `address` soit actif si demandé
    waitFor(label: string, address?: Address): Promise<void>;
    log(message: string): void;
};

export async function compileAll() {
    const [minterCode, walletCode, budgetCode, memberCode, bankCode, shareCode] = await Promise.all([
        compileTolk('contracts/consom/minter.tolk'),
        compileTolk('contracts/jetton/JettonWallet.tolk'),
        compileTolk('contracts/consom/budget.tolk'),
        compileTolk('contracts/consom/member.tolk'),
        compileTolk('contracts/consom/bank.tolk'),
        compileTolk('contracts/consom/bank_share.tolk'),
    ]);
    return { minterCode, walletCode, budgetCode, memberCode, bankCode, shareCode };
}

export function jettonContent(uri: string): Cell {
    // métadonnées hors chaîne (TEP-64) : 0x01 + URI
    return beginCell().storeUint(0x01, 8).storeStringTail(uri).endCell();
}

export async function deployConsoM(cfg: DeployConfig, target: DeployTarget) {
    const codes = await compileAll();
    const minterConfig: MinterConfig = {
        t0: cfg.t0,
        networkId: cfg.network === 'mainnet' ? NETWORK_MAINNET : NETWORK_TESTNET,
        witnessKeys: cfg.witnessPublicKeys,
        guardian: cfg.guardian,
        teamAddress: cfg.teamAddress,
        earlyContributionsTotal: cfg.earlyContributionsTotal,
        walletCode: codes.walletCode,
        budgetCode: codes.budgetCode,
        memberCode: codes.memberCode,
        bankCode: codes.bankCode,
        shareCode: codes.shareCode,
        content: cfg.content,
    };
    const minter = target.open(ConsoMMinter.createFromConfig(minterConfig, codes.minterCode));
    const bank = target.open(ExchangeBank.createForMinter(minter.address, cfg.t0, codes.walletCode, codes.shareCode, codes.bankCode));

    target.log(`Émetteur : ${minter.address.toString({ testOnly: cfg.network === 'testnet' })}`);
    await minter.sendDeploy(target.sender, toNano('0.3'));
    await target.waitFor('déploiement de l\'émetteur', minter.address);

    const expectedBank = await minter.getBankAddress();
    if (!expectedBank.equals(bank.address)) {
        throw new Error('L\'adresse de la banque calculée ici diffère de celle de l\'émetteur : déploiement arrêté.');
    }
    target.log(`Banque d'échange : ${bank.address.toString({ testOnly: cfg.network === 'testnet' })}`);
    await bank.sendDeploy(target.sender, toNano('0.2'));
    await target.waitFor('déploiement de la banque', bank.address);

    await minter.sendGenesis(target.sender, toNano('0.3'));
    await target.waitFor('dépôt de genèse des Anciens Contributeurs');

    return {
        network: cfg.network,
        t0: cfg.t0,
        minter: minter.address,
        bank: bank.address,
        guardian: cfg.guardian,
        teamAddress: cfg.teamAddress,
        earlyContributionsTotal: cfg.earlyContributionsTotal,
        codeHashes: Object.fromEntries(Object.entries(codes).map(([k, c]) => [k, c.hash().toString('hex')])),
    };
}

// ---------- Ligne de commande (testnet / réseau principal) ----------

async function main() {
    const network = (process.argv[2] ?? 'testnet') as 'testnet' | 'mainnet';
    if (network !== 'testnet') throw new Error('Seul le testnet est autorisé pour l\'instant.');
    const { TonClient, WalletContractV5R1 } = await import('@ton/ton');
    const { mnemonicToPrivateKey } = await import('@ton/crypto');

    const mnemonic = (process.env.TESTNET_DEPLOYER_MNEMONIC ?? '').trim().split(/\s+/);
    if (mnemonic.length !== 24) throw new Error('TESTNET_DEPLOYER_MNEMONIC manquant (24 mots).');
    const guardianText = (process.env.GUARDIAN_ADDRESS ?? '').trim();
    if (!guardianText) throw new Error('GUARDIAN_ADDRESS manquant (adresse Tonkeeper du gardien de test).');
    const teamText = (process.env.TEAM_ADDRESS ?? '').trim();
    if (!teamText) throw new Error('TEAM_ADDRESS manquant (adresse du portefeuille Multisig de l\'équipe, gravée au déploiement).');
    // total des contributions du lancement anticipé, en ConsoM entiers : somme de la liste du serveur (0 = aucune)
    const earlyText = (process.env.EARLY_CONTRIBUTIONS_TOTAL ?? '').trim();
    if (!/^\d+$/.test(earlyText) || BigInt(earlyText) > 100_000_000n) throw new Error('EARLY_CONTRIBUTIONS_TOTAL manquant ou invalide (nombre entier de ConsoM, 0 à 100000000).');
    const fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${network}.config.json`), 'utf-8'));

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY || undefined,
    });
    // Le service public toncenter limite à ~1 requête/seconde sans clé : on espace les appels et on réessaie
    const gap = process.env.TONCENTER_API_KEY ? 150 : 1200;
    let lastCall = 0;
    const raw = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const name of ['getBalance', 'runMethod', 'runMethodWithError', 'callGetMethod', 'callGetMethodWithError', 'getContractState', 'sendMessage', 'sendFile', 'isContractDeployed', 'getMasterchainInfo']) {
        const orig = raw[name]?.bind(client);
        if (!orig) continue;
        raw[name] = async (...a: unknown[]) => {
            for (let attempt = 1; ; attempt++) {
                const wait = lastCall + gap - Date.now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                lastCall = Date.now();
                try {
                    return await orig(...a);
                } catch (e) {
                    if (attempt >= 8) throw e;
                    console.log(`  (${name} : nouvel essai ${attempt} après « ${e instanceof Error ? e.message : e} »)`);
                    await new Promise((r) => setTimeout(r, 1500 * attempt));
                }
            }
        };
    }
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet = client.open(WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: { networkGlobalId: -3 } }));
    const balance = await wallet.getBalance();
    console.log(`Wallet de déploiement : ${wallet.address.toString({ testOnly: true, bounceable: false })} (${Number(balance) / 1e9} TON)`);
    if (balance < toNano('1')) throw new Error('Il faut au moins 1 TON de test sur le wallet de déploiement.');

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let seqno = await wallet.getSeqno();
    const target: DeployTarget = {
        open: (c) => client.open(c),
        sender: wallet.sender(keyPair.secretKey),
        log: (m) => console.log(m),
        waitFor: async (label, address) => {
            for (let i = 0; i < 60; i++) {
                await sleep(3000);
                const now = await wallet.getSeqno().catch(() => seqno);
                if (now > seqno) {
                    seqno = now;
                    if (!address) break;
                    for (let j = 0; j < 40; j++) {
                        if (await client.isContractDeployed(address)) {
                            console.log(`✓ ${label}`);
                            return;
                        }
                        await sleep(3000);
                    }
                    throw new Error(`${label} : le contrat n'est pas actif.`);
                }
            }
            if (!address) {
                await sleep(15000);   // laisse le temps aux messages internes d'arriver
                console.log(`✓ ${label}`);
                return;
            }
            throw new Error(`${label} : le message n'a pas été inclus.`);
        },
    };

    const t0 = process.env.T0 ? Number(process.env.T0) : Math.floor(Date.now() / 1000);
    const res = await deployConsoM({
        network,
        t0,
        guardian: Address.parse(guardianText),
        teamAddress: Address.parse(teamText),
        earlyContributionsTotal: BigInt(earlyText) * 1_000_000_000n,
        witnessPublicKeys: fileCfg.witnessPublicKeys.map((h: string) => Buffer.from(h, 'hex')) as [Buffer, Buffer, Buffer],
        content: jettonContent(fileCfg.metadataUri ?? 'https://tonmarche.example/consom-testnet.json'),
    }, target);

    const out = {
        network,
        deployedAt: new Date().toISOString(),
        t0,
        minter: res.minter.toString({ testOnly: true }),
        bank: res.bank.toString({ testOnly: true }),
        guardian: res.guardian.toString({ testOnly: true, bounceable: false }),
        teamAddress: res.teamAddress.toString({ testOnly: true, bounceable: false }),
        earlyContributionsTotal: res.earlyContributionsTotal.toString(),
        witnessPublicKeys: fileCfg.witnessPublicKeys,
        codeHashes: res.codeHashes,
    };
    fs.writeFileSync(path.join(ROOT, 'deployments', `${network}.json`), JSON.stringify(out, null, 2) + '\n');
    const summary = [
        `## ConsoM déployé sur le ${network}`,
        '',
        `| Contrat | Adresse |`,
        `| --- | --- |`,
        `| Émetteur | [${out.minter}](https://testnet.tonviewer.com/${out.minter}) |`,
        `| Banque d'échange | [${out.bank}](https://testnet.tonviewer.com/${out.bank}) |`,
        `| Gardien | ${out.guardian} |`,
        `| Équipe (part gravée) | ${out.teamAddress} |`,
        '',
        `T0 : ${new Date(t0 * 1000).toISOString()}`,
        '',
        '```json',
        JSON.stringify(out, null, 2),
        '```',
    ].join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    main().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e instanceof Error ? e.stack : e);
        // visible dans le résumé du workflow et dans les annotations GitHub
        if (process.env.GITHUB_ACTIONS) console.log(`::error title=Déploiement arrêté::${msg.replace(/\r?\n/g, ' ')}`);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Déploiement arrêté\n\n${msg}\n`);
        process.exit(1);
    });
}
