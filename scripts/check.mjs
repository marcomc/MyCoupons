import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const files = fs.readdirSync(path.join(root, 'src'), {recursive: true}).filter(f => f.endsWith('.gs'));
for (const file of files) new vm.Script(fs.readFileSync(path.join(root, 'src', file), 'utf8'), {filename: file});
const vendor = {
  'He.gs': '76c554d5bbfd032fe620595076a50abea5124b9cbd4e9ffe6ac94a4f855aeceb',
  'LICENSE-he.txt': '483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a'
};
for (const [name, checksum] of Object.entries(vendor)) {
  const bytes = fs.readFileSync(path.join(root, 'src/vendor', name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw Error('Vendor integrity mismatch: ' + name);
}
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'src/vendor/He.gs'), 'utf8'), context);
if (context.he?.version !== '1.2.0' || context.he.decode('CAF&Eacute;20') !== 'CAFÉ20') {
  throw Error('HTML decoder must load without Node or browser globals');
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/appsscript.json')));
if (manifest.executionApi.access !== 'MYSELF' || manifest.webapp) throw Error('Owner-only execution required');
const payload = files.map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
if (/console\.(?:log|error)|Logger\.log/.test(payload)) throw Error('Runtime must not log message or credential payloads');
console.log(`Syntax and manifest checks passed (${files.length} Apps Script files).`);
