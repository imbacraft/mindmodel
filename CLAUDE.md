# mindmodel: working on this repo

A Claude Code plugin that writes a one-page mental model of a codebase (`/mindmodel`) or of a system of services
(`/mindmodel-system`). Deterministic engine (scan → digest → validate → render) plus one writer subagent per run.

## Layout
- `engine-java/`: the Java engine (Maven, Java 17+, Spoon 11.5.0), shaded into `engine-java/target/mindmodel-engine.jar`. Read
  `engine-java/SPOON.md` before changing it.
  It answers which project method each call reaches; `engine/io/dump-run.mjs` runs it; `engine/dump.mjs` reads its dump.
- `engine/`: Node scripts, no dependencies. `io/` (the only layer with side effects: git, processes, network, the
  engine cache, reading build files), `core/` (pure helpers, one owner per concept),
  `model/` (the symbol model: full names, resolved annotations and supertypes), `catalogs/` (framework meaning as
  JSON data), `extract/` (one fact family per module), `checks/`, `digest/`, `evidence/` (pure parsing of build text);
  `scan.mjs` and `system.mjs` orchestrate, `validate.mjs` / `render.mjs` / `system-render.mjs` / `shape.mjs` keep their roles.
- `rules/`: what the writers follow. `schema/`: the JSON the writers produce (`mindmodel.schema.json`, `facts.schema.json`, `catalog.schema.json`).
  `template/`: the pages.
- `agents/`, `skills/`: the writer prompts and the slash commands.
- `examples/`: published pages (GitHub Pages serves the repo root).
- `test/`: `node --test` suites.

## Ground rules
- **No installed Node dependencies; Node 18+.** No newer-than-18 APIs (e.g. iterator helpers like `matchAll(...).map`).
  Nothing third-party is vendored any more: the Spoon jar is the only outside code (pinned by `engine-java/engine.lock`),
  and no `npm install`, no `node_modules`, no native build is involved.
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
- **Run the full suite once, at the end of a piece of work, not after every edit.** While working, run only the file
  you touched (`node --test test/<name>.test.mjs`) or a module's self-checks (`node engine/<module>.mjs`).
- **Tiers.** The default `node --test` runs the self-checks, the unit tests, the fixtures (Java sources under
  `test-support/fixtures/`, dumped by the jar) and the corpus tests for every app in `test/apps.json` that is not marked
  `"slow": true`. `SLOW=1` adds the slow apps (fineract). The end-of-round run is `SLOW=1 node --test`. With `CI=1` too,
  a missing corpus checkout or snapshot fails the run instead of skipping.
- **Cache.** Corpus and fixture scans go through `test-support/scan-cache.mjs`: one scan per app, system and fixture per
  run, stored in `test/snapshots/.cache/` (gitignored). The key covers the engine sources, the jar, the pinned commit
  and `MINDMODEL_CLASSPATH`/`MINDMODEL_M2`. A checkout with changes outside its `mindmodel/` and `mindmodel-system/`
  output folders is scanned fresh and never cached. The `calls` truth checks need the in-memory model, which the cache
  cannot hold, so they scan directly.
- Each dump is memoized per process, keyed by a hash of its sources. The jar takes one root per run, so each distinct
  inline dump is still one JVM.
- Snapshot tests compare facts, digests, validation results and rendered pages with `test/snapshots/` (local,
  gitignored). The first run on a fresh clone records a snapshot and skips it. A refactor must leave every snapshot
  unchanged. Accept an intended change with `UPDATE=1 node --test` after checking the difference it reports.
- `node test/compare.mjs [--all] [app|system ...]` runs the committed engine (a throwaway worktree of `HEAD`) and the
  working tree on every corpus app and system, and prints per family what was added, removed or changed. Slice reports
  quote it; the snapshot diff alone cannot show what the old engine believed.
- `mvn -f engine-java/pom.xml package` builds the jar and runs the JUnit tests. Without the jar, `engine/jvm.mjs` keeps
  the Node guesses and the fixture tests skip, so check `runtime.engine` in facts.json.
- The test apps are read-only: never build, run or modify them (their `mindmodel/` output folders are ours).

## Commits
- Never commit or push without the user's go-ahead; the user pushes.
- Commit messages are one subject line, no body, no co-author trailer.
- Bump `version` in `.claude-plugin/plugin.json` when a release must reach installed copies.
