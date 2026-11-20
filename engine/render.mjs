#!/usr/bin/env node
// Renders mindmodel.json into a single offline index.html using the fixed template. Refuses to render an invalid map.
// Usage: node render.mjs <mindmodel.json> [projectRoot]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] ?? 'mindmodel/mindmodel.json');
const root = path.resolve(process.argv[3] ?? path.join(path.dirname(file), '..'));
const map = JSON.parse(fs.readFileSync(file, 'utf8'));

const { errors, warnings } = validate(map, root);
warnings.forEach((w) => console.log(`warn  ${w}`));
if (errors.length) { errors.forEach((e) => console.log(`ERROR ${e}`)); process.exit(1); }

const template = fs.readFileSync(path.join(here, '../template/template.html'), 'utf8');
// '<' is escaped so map text can never close the <script> tag it lives in.
const data = JSON.stringify(map).replace(/</g, '\\u003c');
const html = template.replace('/*__MINDMODEL_DATA__*/', () => data).replace('__MINDMODEL_ROOT__', () => root.replace(/\\/g, '/').replace(/"/g, '\\"'));
const out = path.join(path.dirname(file), 'index.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
