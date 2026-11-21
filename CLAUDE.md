# mindmodel: working on this repo

A Claude Code plugin that writes a one-page mental model of a codebase (`/mindmodel`) or of a system of services
(`/mindmodel-system`). Deterministic engine (scan → digest → validate → render) plus one writer subagent per run.

## Layout
- `engine/`: Node scripts, no dependencies. Scanners (`scan.mjs`, `system.mjs`), validators (`validate.mjs`,
  `system-render.mjs`), renderers, and the code-model helpers they share.
- `rules/`: what the writers follow. `schema/`: the JSON the writers produce. `template/`: the pages.
- `agents/`, `skills/`: the writer prompts and the slash commands.
- `examples/`: published pages (GitHub Pages serves the repo root).
- `test/`: `node --test` suites.

## Ground rules
- **No dependencies; Node 18+.** No newer-than-18 APIs (e.g. iterator helpers like `matchAll(...).map`).
- **Stacks:** Java on Spring or Jakarta EE (JAX-RS, EJB, CDI, JMS, Jakarta Batch); Spring and EE spellings of the
  same idea must both work.
- **Rules, schema, validator and templates must agree.** Changing a budget or a field means changing all four.
- **Digest budget:** `facts.md` stays about the same size on any app (capped lists, "+N more in facts.json"); over
  70 KB it warns the writer.
- **Readable code:** lines under ~120 characters; a named, testable function per job; small self-checks (`assert`)
  next to the code they check, which run on import.

## Testing
- `node --test` runs every module's self-checks and the snapshot tests. Run it after every engine change.
- Snapshot tests scan the public test apps cloned under `~/Projects/test-apps` (list in `test/apps.json`) and compare
  facts, digests, validation results and rendered pages with `test/snapshots/` (local, gitignored).
- A refactor must leave every snapshot unchanged. An intended change: check the reported difference, then accept it
  with `UPDATE=1 node --test`.
- The test apps are read-only: never build, run or modify them (their `mindmodel/` output folders are ours).

## Commits
- Never commit or push without the user's go-ahead; the user pushes.
- Commit messages are one subject line, no body, no co-author trailer.
- Bump `version` in `.claude-plugin/plugin.json` when a release must reach installed copies.
