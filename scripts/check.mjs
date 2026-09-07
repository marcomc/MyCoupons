import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const files = fs.readdirSync(path.join(root, 'src'), {recursive: true}).filter(f => f.endsWith('.gs'));
for (const file of files) new vm.Script(fs.readFileSync(path.join(root, 'src', file), 'utf8'), {filename: file});
const vendor = {
  'Html.gs': 'c634773c81bd808e3177557a274ab5ea71ed8d6b043fbf34cea8b31cac4d4dc7',
  'LICENSE-parse5.txt': '8c535800331e1e4439835555b3f9edc7fe9dee2fab0d8bbbd5a982e8b8343d4d',
  'LICENSE-entities.txt': 'cb992345949ccd6e8394b2cd6c465f7b897c864f845937dbf64e8997f389e164'
};
for (const [name, checksum] of Object.entries(vendor)) {
  const bytes = fs.readFileSync(path.join(root, 'src/vendor', name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw Error('Vendor integrity mismatch: ' + name);
}
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'src/vendor/Html.gs'), 'utf8'), context);
const parsed = context.MC_HTML?.parse('<body hidden>CAF&Eacute;20<img alt="hidden"', {scriptingEnabled: false});
const html = parsed?.childNodes.find(node => node.tagName === 'html');
const body = html?.childNodes.find(node => node.tagName === 'body');
if (body?.childNodes.length !== 1 || body.childNodes[0].value !== 'CAFÉ20' ||
  !body.attrs.some(attr => attr.name === 'hidden')) {
  throw Error('HTML parser must load and parse without Node or browser globals');
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/appsscript.json')));
if (manifest.executionApi.access !== 'MYSELF' || manifest.webapp) throw Error('Owner-only execution required');
const payload = files.map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
if (/console\.(?:log|error)|Logger\.log/.test(payload)) throw Error('Runtime must not log message or credential payloads');
console.log(`Syntax and manifest checks passed (${files.length} Apps Script files).`);
