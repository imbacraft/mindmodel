# Vendored: tree-sitter (WASM)

Java source is parsed with the official tree-sitter Java grammar through web-tree-sitter's WASM runtime. The three
files are vendored so the plugin installs and runs with Node only: no `npm install`, no `node_modules`, no native
build, no Node ABI coupling.

| file | what | version | sha256 |
|---|---|---|---|
| `web-tree-sitter.mjs` | web-tree-sitter ESM build (renamed from `.js` so Node loads it as a module) | 0.27.2 | `44626cc32a7b6878a10be084b58b471d9c47c1e2082cd5a5e34c8a41431f0c2d` |
| `web-tree-sitter.wasm` | its runtime, resolved next to the `.mjs` | 0.27.2 | `488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec` |
| `tree-sitter-java.wasm` | the Java grammar | 0.23.5 | `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4` |

Sources:

- https://www.npmjs.com/package/web-tree-sitter/v/0.27.2 (project: https://github.com/tree-sitter/tree-sitter)
- https://www.npmjs.com/package/tree-sitter-java/v/0.23.5 (project: https://github.com/tree-sitter/tree-sitter-java)

## How it is loaded

`engine/java.mjs`, once per process, at import time:

1. checks that all three files are present; a missing file throws an error naming the path;
2. `await Parser.init()` — the runtime wasm is looked up next to `web-tree-sitter.mjs`;
3. `await Language.load(tree-sitter-java.wasm)`.

After that `index()` and every caller stay synchronous. `Parser.init()` and `Language.load()` are asynchronous, which
is why `engine/java.mjs` uses top-level `await`.

## Upgrading

1. In a scratch folder outside the repo: `npm install web-tree-sitter@<version> tree-sitter-java@<version>`.
2. Copy `node_modules/web-tree-sitter/web-tree-sitter.js` to `web-tree-sitter.mjs` (rename the extension only),
   plus `node_modules/web-tree-sitter/web-tree-sitter.wasm` and
   `node_modules/tree-sitter-java/tree-sitter-java.wasm`.
3. Update the versions and hashes above (`shasum -a 256 *`), and this README.
4. `node --test` (self-checks and snapshots), `npx -y node@18 --test`, then the corpus invariants.

Keep the runtime wasm in this folder: web-tree-sitter resolves it relative to its own module URL.

## Licences

Both projects are MIT. Their notices follow verbatim.

### web-tree-sitter

```
The MIT License (MIT)

Copyright (c) 2018 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tree-sitter-java

```
MIT License

Copyright (c) 2017 Ayman Nadeem

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
