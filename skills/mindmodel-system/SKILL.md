---
name: mindmodel-system
description: Generate a system mindmodel for a folder of services (microservices): one offline page with what a developer must carry in their head about how the services fit together (domains, who owns what, how they talk, main cross-service flows, what happens when a hop fails). Use when the user asks for a system map, a microservices map, or a mindmodel of several services.
argument-hint: "[folder] [--focus service-a,service-b]"
---

# /mindmodel-system

Generate `<folder>/mindmodel-system/index.html` (and its source `system-map.json`) for the services under `$ARGUMENTS`, or the current working directory.

The plugin root is `${CLAUDE_PLUGIN_ROOT}`.

## Steps

1. **Resolve the folder** to an absolute path and check it exists. It should hold the service repos (or modules) side by side. Tuned for Spring and Jakarta EE services talking over REST, Kafka and JMS.

2. **Scan** (deterministic):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/system.mjs" "<folder>"
   ```
   It finds the services, skips shared libraries, scans each one, and joins REST calls and Kafka/JMS channels into `<folder>/mindmodel-system/.work/system.md`. If the summary shows few or no channels and the user's services wrap Kafka or JMS in a company library, tell them they can add patterns in `<folder>/mindmodel-system.json` (`{"messaging":[{"kind":"kafka","dir":"out","re":"eventBus\\.emit\\(\\s*EXPR"}]}`), then rescan.

3. **Write the map.** Dispatch one subagent of type `mindmodel:system-writer` with:
   > Folder: `<folder>` · Plugin root: `${CLAUDE_PLUGIN_ROOT}` · Focus services: `<from --focus, or none>`
   > The system scan has run; its output is in `<folder>/mindmodel-system/.work/`.

   Don't do the analysis yourself.

4. **Render** (the writer usually already did; run again if not):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/engine/system-render.mjs" "<folder>/mindmodel-system/system-map.json" "<folder>" --fix
   ```

5. **Report** briefly: where the page is; the system sentence; domains and core services; the top failure rows; **the owner-only findings**, clearly marked as not on the page; the fact corrections the subagent reported (also in `mindmodel-system/.work/corrections.md`), as engine feedback; and any unresolved names (connections the scan could not resolve, often set in deployment config).
