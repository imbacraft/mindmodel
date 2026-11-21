# mindmodel

**A codebase mind map for humans.** mindmodel generates a single offline page that installs the essential mental model of a codebase in a developer's head, so they can work on it without an AI at their side.

It is deliberately *not* complete. Graph tools show hundreds of nodes; mindmodel shows only what a developer must carry in their head, and every claim on the page is traced to a cited line of code.

## What the page contains
1. **Overview:** what the system is for, what it deliberately is not, where it starts, and the one way to run it locally.
2. **Context:** who uses it, and which outside systems it calls.
3. **Core concepts:** the ≤ 5 things everything else is about, one sentence linking them, and a card each (what it is, what not to confuse it with, its lifecycle, the fields that matter).
4. **Regions:** where the code lives, ordered along the user's journey, with how often each part changes.
5. **State & source of truth:** where the truth for each concept lives, which code may change it (shared writes flagged), copies that can go stale, and steps that can half-succeed.
6. **How a request travels:** the path every API call takes, as one sequence diagram.
7. **What runs on its own:** scheduled jobs, webhooks, queues and async work.
8. **Rules & surprises:** ranked by how much code they touch × how bad it is to get them wrong.
9. **Stories:** the main flows, walked end to end through real code.

Every citation opens the file at the line in VS Code or IntelliJ.

## Install (Claude Code)
```
/plugin marketplace add imbacraft/mindmodel
/plugin install mindmodel@mindmodel
```
Then, in any project:
```
/mindmodel                # the current directory
/mindmodel path/to/app    # or a specific project
```
The page is written to `<project>/mindmodel/index.html`; open it in any browser, offline.

### Requirements
- Claude Code (the analysis runs on your own Claude plan and model)
- Node.js 18+ (the scanner, validator and renderer have no npm dependencies)
- git (optional; used for the "changes often / rarely" badges)

### Best results
v1 is tuned for **Spring/Java backends** with **React, Vue, Svelte or Angular** SPAs or **server-rendered (JSP/Thymeleaf)** frontends. File-based routing (Next.js, Nuxt, SvelteKit) is not read yet. Other stacks work with generic signals and give weaker results.

## How it works
0. **Pre-flight** (`engine/preflight.mjs`): checks the code is a clean, current state. Uncommitted changes, being behind the remote, a detached HEAD or a non-default branch make it ask you to confirm before continuing.
1. **Scan** (`engine/scan.mjs`, no AI): collects the mechanical facts (entities and their relations, endpoints, the frontend↔backend API join, security configuration, interceptors, scheduled/async/socket work, external SDKs, docs, git history) into `mindmodel/.work/facts.json` plus a compact digest.
2. **Write** (one Claude subagent): follows [`rules/generation-rules.md`](rules/generation-rules.md) to choose what is essential, reading only the code that needs judgment.
3. **Validate** (`engine/validate.mjs`): schema, size budgets, and every citation (files, line ranges, and `#symbol` checks).
4. **Render** (`engine/render.mjs`): a fixed template turns `mindmodel.json` into one self-contained HTML file.

## Privacy and safety
- The scanner reads configuration **keys only, never values**, and the rules forbid secrets in the map.
- Security weaknesses or serious bugs found during analysis are reported **to you in the session**, never written into the map.
- The page describes your code in detail. Review it before committing it to a public repository.
- `mindmodel/.work/` holds scan data; add it to your project's `.gitignore`.

## License
MIT
