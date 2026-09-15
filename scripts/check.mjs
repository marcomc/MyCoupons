import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const sourceDirectory = new URL('../src/', import.meta.url);
const entries = await readdir(sourceDirectory, {withFileTypes: true});
const sourceFiles = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.gs'))
  .map(entry => join(sourceDirectory.pathname, entry.name));

if (sourceFiles.length === 0) {
  throw new Error('No Apps Script source files found.');
}

for (const sourceFile of sourceFiles) {
  const source = await readFile(sourceFile, 'utf8');
  if (source.includes('GEMINI') || source.includes('VERTEX') || source.includes('UrlFetchApp')) {
    throw new Error(`Baseline-only source contains an excluded dependency: ${sourceFile}`);
  }
}
