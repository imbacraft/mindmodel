# Mindmodel: the codebase mental model for humans

**The few things every developer on a project must know by heart, on one page, generated from the code.** A [Claude Code](https://claude.com/claude-code) plugin: run `/mindmodel` in any project.

It is deliberately *not* complete. Graph tools show hundreds of nodes; mindmodel distills the essence.

## Example

[![mindmodel of Apache HertzBeat](examples/hertzbeat.png)](https://imbacraft.github.io/mindmodel/examples/hertzbeat.html)

**[Open the live example →](https://imbacraft.github.io/mindmodel/examples/hertzbeat.html)** The mindmodel of [Apache HertzBeat](https://github.com/apache/hertzbeat), a monitoring platform of about 316k lines of Java and 199k of TypeScript, generated in about 5 minutes. Every citation links to the code on GitHub at the mapped commit. *HertzBeat is an Apache Software Foundation project; this example is independent and not affiliated with it.*

## What the page contains
1. **Overview:** what the system is for, what it deliberately is not, where it starts, and the one way to run it locally.
2. **People & outside systems:** who it serves, most important first, and which outside systems it calls.
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
