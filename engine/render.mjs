#!/usr/bin/env node
// Renders mindmodel.json into a single offline index.html using the fixed template. Refuses to render an invalid map.
// Usage: node render.mjs <mindmodel.json> [projectRoot] [--web <base URL> --out <file>]
// --web publishes a shareable page: citations link to the code on the web (e.g. a GitHub blob URL at a commit)
// and no local path is embedded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// The page for a map that has already passed validate(). `web` replaces the local root in citation links.
export function renderPage(map, root, web = null) {
  const template = fs.readFileSync(path.join(here, '../template/template.html'), 'utf8');
  // '<' is escaped so map text can never close the <script> tag it lives in.
  const data = JSON.stringify(map).replace(/</g, '\\u003c');
  return template
    .replace('/*__MINDMODEL_DATA__*/', () => data)
    .replace('__MINDMODEL_ROOT__', () => (web ?? root).replace(/\\/g, '/').replace(/"/g, '\\"'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args.splice(i, 2)[1] : null;
  };
  const web = opt('--web'),
    outArg = opt('--out');
  const file = path.resolve(args[0] ?? 'mindmodel/mindmodel.json');
  const root = path.resolve(args[1] ?? path.join(path.dirname(file), '..'));
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));

  const { errors, warnings } = validate(map, root);
  warnings.forEach((w) => console.log(`warn  ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.log(`ERROR ${e}`));
    process.exit(1);
  }

  const html = renderPage(map, root, web);
  const out = outArg ? path.resolve(outArg) : path.join(path.dirname(file), 'index.html');
  fs.writeFileSync(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}
