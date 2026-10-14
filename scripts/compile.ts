// Compile les contrats Tolk du projet avec le compilateur officiel (@ton/tolk-js).
// Utilisé par les tests (compilation à la volée) et en ligne de commande :
//   node scripts/compile.ts            -> écrit build/<Contrat>.json pour chaque contrat
import { Cell } from '@ton/core';
import { runTolkCompiler, getTolkCompilerVersion } from '@ton/tolk-js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Contrats de production. Les contrats de test (tests/stubs) sont compilés par les tests eux-mêmes.
export const CONTRACTS: Record<string, string> = {
    ConsoMMinter: 'contracts/consom/minter.tolk',
    JettonWallet: 'contracts/jetton/JettonWallet.tolk',
};

const cache = new Map<string, Cell>();

export async function compileTolk(relativePath: string): Promise<Cell> {
    const cached = cache.get(relativePath);
    if (cached) return cached;
    const result = await runTolkCompiler({
        entrypointFileName: path.join(ROOT, relativePath),
        fsReadCallback: (p: string) => fs.readFileSync(p, 'utf-8'),
        optimizationLevel: 2,
    });
    if (result.status === 'error') {
        throw new Error(`Compilation de ${relativePath} impossible :\n${result.message}`);
    }
    const code = Cell.fromBase64(result.codeBoc64);
    cache.set(relativePath, code);
    return code;
}

async function main() {
    console.log(`Tolk ${await getTolkCompilerVersion()}`);
    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    for (const [name, file] of Object.entries(CONTRACTS)) {
        const code = await compileTolk(file);
        const out = { hash: code.hash().toString('hex'), hex: code.toBoc().toString('hex') };
        fs.writeFileSync(path.join(ROOT, 'build', `${name}.json`), JSON.stringify(out, null, 2));
        console.log(`${name}: ${out.hash}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
