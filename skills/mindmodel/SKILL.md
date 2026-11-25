---
name: mindmodel
description: Generate a mindmodel for an application, a single offline page with the essential mental model a developer needs to work on the codebase (core concepts, regions, how a request travels, what runs on its own, ranked rules and main flows). Use when the user asks for a mindmodel, a codebase map for onboarding, or to "map this codebase".
argument-hint: "[project-path]"
---

# /mindmodel

Generate `mindmodel/index.html` (and its source `mindmodel/mindmodel.json`) for the project at `$ARGUMENTS`, or the current working directory if no path is given.

The plugin root is `${CLAUDE_PLUGIN_ROOT}`.

## Steps

1. **Resolve the project root** (`$ARGUMENTS` or the working directory) to an absolute path, and check it exists. v1 is tuned for Java backends on Spring or Jakarta EE with React, Vue, Svelte or Angular SPAs, or server-rendered (JSP/Thymeleaf/JSF) frontends. For other stacks, say that results may be weaker, then continue.

2. **Pre-flight: check the code is a clean, current state.**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/preflight.mjs" "<root>"
   ```
   It prints JSON with `ok`, an `engine` object and a list of `warnings` (`block`, `confirm` or `info`). This is the only
   step that may use the network: when no engine jar is present it downloads the pinned release once (~15 MB, sha256
   verified) and reports it as an `info` line. If that fails, it is a `block` — show the message and stop; an offline
   machine can set `MINDMODEL_ENGINE_JAR` to a local jar instead.
   - Any **`block`** (e.g. Node too old, no Java 17+, engine jar unavailable): show it and stop.
   - **`ok: false`** (uncommitted changes, behind the remote, detached HEAD, not the default branch): show the `confirm` warnings to the user and **ask explicitly whether to continue** (e.g. with AskUserQuestion: *Continue anyway* / *Stop so I can commit, pull or switch branch*). Do not continue without an explicit yes; never decide for them.
   - **`ok: true`**: mention any `info` lines in one short sentence and continue.

3. **Scan** (deterministic, no tokens spent on searching):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/scan.mjs" "<root>"
   ```
   This writes `<root>/mindmodel/.work/facts.json` and the digest `facts.md`, and prints one summary line. If it fails, show the error and stop.

4. **Write the map.** Dispatch one subagent of type `mindmodel:writer` with this task (fill in the paths):
   > Project root: `<root>`
   > Plugin root: `${CLAUDE_PLUGIN_ROOT}`
   > Rules: `${CLAUDE_PLUGIN_ROOT}/rules/core.md` (read it all) · section rules: `${CLAUDE_PLUGIN_ROOT}/rules/sections.md` (open one section at a time) · JSON shape: `node ${CLAUDE_PLUGIN_ROOT}/engine/shape.mjs`
   > Facts digest: `<root>/mindmodel/.work/facts.md` (details in `facts.json`)
   > Validator: `${CLAUDE_PLUGIN_ROOT}/engine/validate.mjs`
   > Write `<root>/mindmodel/mindmodel.json` and make it pass the validator.

   Wait for it to finish. Don't do the analysis yourself, and don't read the project's code in this session; the subagent keeps that work out of the user's context. Its reply ends with two fenced blocks, `findings` and `observations`; step 5 saves them.

   **Record the run.** Append one entry to `<root>/mindmodel/.work/run-stats.json` (create it if absent; keep the last
   ten entries, oldest dropped). The subagent's completion notification carries `subagent_tokens`, `tool_uses` and
   `duration_ms`; the rest comes from its reply and the plugin:
   ```json
   [{ "at": "2026-11-25", "version": "0.6.2", "tokens": 201000, "toolUses": 36, "durationMs": 900000, "validatorWarnings": 3, "spotcheck": "9/10" }]
   ```
   `version` is `version` in `<plugin>/.claude-plugin/plugin.json`, `validatorWarnings` the warning count on the
   validator's last line (0 if it printed none), `spotcheck` the `n/10` from the writer's spot-check line. `tokens`
   excludes cache reads. `toolUses` counts calls, not turns — parallel calls share a turn — so compare runs by
   `durationMs` and the owner's transcript check, never by the call count. Every writer, rules or
   engine change is judged by this file, so keep the numbers exact and the file small.

5. **Save the findings.** Do this before rendering: the writer subagent is not reliably allowed to write this file (a harness refused it once), so the blocks in its reply are the source of truth. Write `<root>/mindmodel/.work/findings.md` in exactly this shape:
   ````text
   # Findings

   ## Weaknesses and serious bugs
   <the body of the reply's ```findings``` block, verbatim>

   ## Observations
   <the body of the reply's ```observations``` block, verbatim>
   ````
   Copy the block bodies line for line (one line per finding, fields separated by ` | `); a block whose only line is `none` becomes `none` under its heading. Overwrite anything the writer managed to write there: the reply wins. If the reply has neither block, write `none` and say so in the report. `validate.mjs` warns while this file is absent — that is expected until this step has run and is not a problem with the map.

6. **Render:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/render.mjs" "<root>/mindmodel/mindmodel.json"
   ```
   It refuses to render an invalid map. If it reports errors, send them to the same subagent once to fix, then render again.

7. **Report** to the user, briefly:
   - where the page is (`<root>/mindmodel/index.html`; it opens offline in any browser);
   - the map in brief (core sentence, regions, ranked rules and stories), from the subagent's message;
   - **the owner-only findings** (security weaknesses, serious bugs) from the blocks you saved, clearly marked as *not in the map*: severity, claim, evidence, why it matters, suggested fix. The digest's computed security warnings are where most of them start. Say in one line that they were saved to `mindmodel/.work/findings.md` (or that there were none);
   - the fact corrections the subagent reported, if any (also in `mindmodel/.work/corrections.md`), as engine feedback;
   - that `mindmodel/.work/` holds scan data and is usually not worth committing.
- Tenancy: the digest's **Tenancy** section names the tenant key with its counts, the entities that lack it, the repository reads that skip it, and any job/listener/worker that reaches a keyed entity without setting the tenant context. Use it; do not infer a key from a field name. Gaps go to `findings.md`, not to rules.
