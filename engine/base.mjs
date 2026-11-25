// The CSS and JS both page templates share (template/base.css, template/base.js) are inlined at render time, where
// each template keeps its marker line, so every page stays one offline file.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../template');
const read = (name) => fs.readFileSync(path.join(templateDir, name), 'utf8');

// A function replacer: the shared JS contains `$` text that a string replacement would read as a pattern.
export function inlineBase(template) {
  return template
    .replace('/*__BASE_CSS__*/\n', () => read('base.css'))
    .replace('/*__BASE_JS__*/\n', () => read('base.js'));
}

// Self-check: both markers are replaced by their file, byte for byte, and no marker survives.
{
  const html = inlineBase('<style>\n/*__BASE_CSS__*/\n</style>\n/*__BASE_JS__*/\n');
  assert.ok(html.startsWith(`<style>\n${read('base.css')}</style>\n${read('base.js')}`));
  assert.ok(!html.includes('/*__BASE_'));
}
