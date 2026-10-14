// Assemble la page de test autonome : node tools/testpage/build.mjs <tonlib.js> <codes.json> <witness-seeds.json> <sortie.html> [testnet.json]
import fs from 'node:fs';
const [tonlib, codes, seeds, out, dep] = process.argv.slice(2);
const here = new URL('.', import.meta.url);
const tpl = fs.readFileSync(new URL('template.html', here), 'utf-8');
const lib = fs.readFileSync(new URL('consom-test-lib.js', here), 'utf-8').replace(/^export /m, '');
const d = dep && fs.existsSync(dep) ? JSON.parse(fs.readFileSync(dep, 'utf-8')) : {};
const cfg = { ...JSON.parse(fs.readFileSync(codes, 'utf-8')), witnessSeedsHex: JSON.parse(fs.readFileSync(seeds, 'utf-8')), minter: d.minter ?? '', bank: d.bank ?? '' };
const html = tpl.replace('/*TONLIB*/', () => fs.readFileSync(tonlib, 'utf-8')).replace('/*LIB*/', () => lib).replace('/*CFG*/', () => JSON.stringify(cfg));
fs.writeFileSync(out, html);
console.log(out, html.length);
