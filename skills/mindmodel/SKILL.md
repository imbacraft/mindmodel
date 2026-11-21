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
   It prints JSON with `ok` and a list of `warnings` (`block`, `confirm` or `info`). It never fetches.
   - Any **`block`** (e.g. Node too old): show it and stop.
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
   > Rules: `${CLAUDE_PLUGIN_ROOT}/rules/generation-rules.md` · JSON shape: `node ${CLAUDE_PLUGIN_ROOT}/engine/shape.mjs`
   > Facts digest: `<root>/mindmodel/.work/facts.md` (details in `facts.json`)
   > Validator: `${CLAUDE_PLUGIN_ROOT}/engine/validate.mjs`
   > Write `<root>/mindmodel/mindmodel.json` and make it pass the validator.

   Wait for it to finish. Don't do the analysis yourself, and don't read the project's code in this session; the subagent keeps that work out of the user's context.

5. **Render:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/render.mjs" "<root>/mindmodel/mindmodel.json"
   ```
   It refuses to render an invalid map. If it reports errors, send them to the same subagent once to fix, then render again.

6. **Report** to the user, briefly:
   - where the page is (`<root>/mindmodel/index.html`; it opens offline in any browser);
   - the map in brief (core sentence, regions, ranked rules and stories), from the subagent's message;
   - **the owner-only findings** (security weaknesses, serious bugs) from the subagent, clearly marked as *not in the map*;
   - that `mindmodel/.work/` holds scan data and is usually not worth committing.
