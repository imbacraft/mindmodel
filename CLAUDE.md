# mindmodel: working on this repo

A Claude Code plugin that writes a one-page mental model of a codebase (`/mindmodel`) or of a system of services
(`/mindmodel-system`). Deterministic engine (scan → digest → validate → render) plus one writer subagent per run.

## Layout
- `engine-java/`: the Java engine (Maven, Java 17+, Spoon 11.2.1), shaded into `engine-java/target/mindmodel-engine.jar`.
  It answers which project method each call reaches; `engine/jvm.mjs` runs it and joins its answers onto the Node model.
- `engine/`: Node scripts, no dependencies. `syntax/` (tree-sitter adapter: declarations, calls, package, imports),
  `model/` (the symbol model: full names, resolved annotations and supertypes), `catalogs/` (framework meaning as
  JSON data), `extract/` (one fact family per module), `checks/`, `digest/`, `evidence/`; `scan.mjs` and `system.mjs`
  orchestrate, `validate.mjs` / `render.mjs` / `system-render.mjs` / `shape.mjs` keep their roles.
- `rules/`: what the writers follow. `schema/`: the JSON the writers produce (`mindmodel.schema.json`, `facts.schema.json`, `catalog.schema.json`).
  `template/`: the pages.
- `agents/`, `skills/`: the writer prompts and the slash commands.
- `examples/`: published pages (GitHub Pages serves the repo root).
- `test/`: `node --test` suites.

## Ground rules
- **No installed Node dependencies; Node 18+.** No newer-than-18 APIs (e.g. iterator helpers like `matchAll(...).map`).
  The only vendored third-party code is the pinned tree-sitter WASM in `engine/vendor/tree-sitter/` (hashes in its
  README); no `npm install`, no `node_modules`, no native build.
- **The Java engine needs JDK 17+ and Maven to build** (`mvn -f engine-java/pom.xml package`). It replaces the Node
  resolver's guesses with Spoon's answers wherever it can; a scan without the jar still runs on the guesses, so
  preflight blocks only when no JDK 17+ is on PATH. Nothing downloads the analyzed project's dependencies or runs its
  build.
- **Stacks:** Java on Spring or Jakarta EE (JAX-RS, EJB, CDI, JMS, Jakarta Batch); Spring and EE spellings of the
  same idea must both work.
- **Rules, schema, validator and templates must agree.** Changing a budget or a field means changing all four.
- **Digest budget:** `facts.md` stays about the same size on any app (capped lists, "+N more in facts.json"); over
  70 KB it warns the writer.
- **Readable code:** lines under ~120 characters; a named, testable function per job; small self-checks (`assert`)
  next to the code they check, which run on import.

## Testing
- `node --test` runs every module's self-checks and the snapshot tests. Run it after every engine change.
- `mvn -f engine-java/pom.xml package` builds the jar and runs the JUnit tests. `engine/jvm.mjs` self-checks only run
  when the jar exists; without it a scan silently keeps the Node guesses, so check `runtime.engine` in facts.json.
- Snapshot tests scan the public test apps cloned under `~/Projects/test-apps` (list in `test/apps.json`) and compare
  facts, digests, validation results and rendered pages with `test/snapshots/` (local, gitignored).
- `node test/compare.mjs [--all] [app|system ...]` runs the committed engine (a throwaway worktree of `HEAD`) and the
  working tree on every corpus app and system, and prints per family what was added, removed or changed. Slice
  reports quote it; the snapshot diff alone cannot show what the old engine believed.
- A refactor must leave every snapshot unchanged. An intended change: check the reported difference, then accept it
  with `UPDATE=1 node --test`.
- The test apps are read-only: never build, run or modify them (their `mindmodel/` output folders are ours).

## Commits
- Never commit or push without the user's go-ahead; the user pushes.
- Commit messages are one subject line, no body, no co-author trailer.
- Bump `version` in `.claude-plugin/plugin.json` when a release must reach installed copies.
