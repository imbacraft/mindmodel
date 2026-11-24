# mindmodel: generation rules — core

**What this is:** the instructions for producing a mindmodel for any single application: the essential mental model a developer must carry in their head to work on a codebase without an AI. The `/mindmodel` writer follows them exactly. **Status:** v1.3. Examples use an invented course platform ("Coursely"); they illustrate, they are not templates.

**How to read:** this file is read on every run. The numbered section rules (Part 3), the differently shaped repos (Part 6) and the two notes at the end of it are in `rules/sections.md`. Open **only** the section you are drafting.

---

## Part 1. Principles that govern every section

**P1. Essence, not coverage.** The map holds what a developer must *carry in their head* to work on the code without an LLM. Anything they can look up when needed (field lists, every endpoint, every class) stays off the map. When in doubt, leave it out.

**P1a. No filler.** Every item must earn its place by touching the core of the app. **Budgets are ceilings, never targets**: never add an item to reach a count. A weak, rare or peripheral item is worse than a missing one, because it spends the reader's attention and teaches them the map contains noise.

**P2. One idea per section.** Each section answers a different question. If two sections say the same thing, one of them is wrong.

| Section | The one question it answers |
|---|---|
| Overview | What is this system for, what is it deliberately not, and where does it start? |
| People & outside systems | Who does it serve, most important first, and what outside systems does it call? |
| Core concepts | What are the few things everything else is about, and how do they relate? |
| Regions | How is the code laid out, and where does each capability live? |
| State & source of truth | Where does the truth for each concept live, and who may change it? |
| How a request travels | What happens to *every* API call, whatever the feature? |
| What runs on its own | What happens with no request at all? |
| Rules | What must you never get wrong? |
| Stories | How do the main flows actually run, end to end? |

**P3. Every claim is traced to code, once per claim block.** Each block — a rule, a region part, a concept card, a story step — carries one or two citations (`path`, `path:line` or `path:start-end`, optionally `#symbol`, which the validator checks is in the cited lines) and the prose rides on them. A citation on every sentence is wrong: it costs the writer a lookup per sentence and the reader attention to lines the block already establishes. Where a block states several unrelated things, cite each part once, not each sentence of a part. The cited lines must contain what the text says. Where a file declares several methods of that name, a bare `#name` is ambiguous: the validator rejects it and lists the candidates (`path:start-end#name (N params)`), and you cite the one you meant by its own range or by adding its arity (`#save/2`). A claim you cannot trace is dropped, or, only in stories, marked *inferred*.

**P3a. The cite count is a signal, not a score.** A map needs roughly 2 cites per rule, 4 per region, 2 per concept, 1 per step (request path and stories), 1 per background row and per state owner — about 90–120 on a seven-region app. The validator warns above 1.4× that; far more cites than blocks means sentences are being cited one by one.

**P4. The code wins, silently.** Read the project's docs (README, CLAUDE.md, AGENTS.md, `docs/`, ADRs) for purpose, vocabulary and intent, then verify against the code. Where they disagree, write what the code does and say nothing about the doc. *Docs* means prose documentation. Configuration files are code: a config setting that the code ignores or overrides can be a rule (3.8).

**P4a. The coverage line is a boundary, not a footnote.** `facts.md` opens with what the engine resolved and what it did not, and every fact carries a confidence. Treat `parsed` and `resolved` as settled: cite them without re-reading the code. Check `inferred` ones against the code before they reach the page. Anything under "What the engine did not understand" — unknown annotations, base classes no catalog explains, uncatalogued dependencies, source files the model cannot read, degraded files — or in the unresolved endpoints is a place the facts are blind: read the code there before claiming anything about it, or leave it out.

**P5. Plain names first, code names second.** Use the words the users and the business use ("School"). Show the code name after it (`OrgUnit`). Once a plain name is chosen, use exactly that name everywhere on the page. Don't name a region with a word that is also a concept's name unless the region is about that concept.

**P6. State behavior, never exploits.** The map describes how the code actually behaves, **including behavior that is flawed**, plainly and neutrally, because a developer can't work on a system they have been given a cleaned-up picture of (e.g. "the price is sent by the browser and charged as sent"). The map never explains how to abuse a weakness, never includes secrets, credentials or keys, and never labels anything a bug or vulnerability. **Separately**, report every security weakness and serious bug you find to the person who asked for the map: they go in `findings.md` (see the writer steps), never into the map's rules as a convention. Where a developer must know the behavior, the page says it neutrally and points at the findings — no exploit details, no "bug" label.

**P7. Words first.** About 80% words. The only diagram is the request-path sequence. Draw any other diagram only if the relations it shows branch, loop or are many-to-many (a chain is a sentence).

**P8. Budgets are size tiers, with flat caps where overflow lives.** The core map (everything except stories) is capped by the app's size, measured by its endpoint count, in four tiers; regions and state carry flat caps whatever the tier. Part 7 states the numbers once — use them, don't restate them. `facts.md` opens with this app's tier and section targets (`**budget: …**`); the validator prints the same numbers and marks every section over its share. Cut, merge or group; never cram.

**Draft to the section targets, once.** Each section has a share of the tier (Part 7); a draft written by feel overshoots by about a third and then costs more to cut than to write. Write the map once, to those numbers, and let the validator count: it prints `sections: purpose 150/144 · …` and marks every section over its share with `!`. Correct only the marked sections, with edits to those fields, and stop when no section is marked. Never re-read the draft to count words yourself, and never rewrite the map to fix one section's number.

**P9. Rank, don't list.** Where a section has several items of unequal weight (rules, stories), order them by importance and say in one line why each ranks where it does.

**P10. Exact numbers or none.** "42 entities", "every 30 s", "14 of 40 commits": exact and cited. Never "many", "several", "frequently".

**P10a. State the condition; absolutes only when the code guarantees them.** A claim is true under conditions — a tenant, a role, a configuration key, a transaction, a path prefix. Write them down: "when `sureness.excludedResource` lists it, `/api/webhooks/**` skips authentication", not "requests are authenticated". Words like *never*, *always*, *all requests*, *no one* are allowed only when the code guarantees them (a constant, an exhaustive switch, a single entry point); otherwise the rule carries a `condition` field saying when it holds, and the validator rejects an absolute without one. A probable defect does not become a rule either: rules describe how the system works, so the defect goes in the owner's findings and the map's text stays neutral (P6).

---

## Part 2. Process

Work in this order. Later sections depend on earlier ones: everything is written in the concepts' names, and rules come out of tracing.

| Phase | What | Output |
|---|---|---|
| 1 | **Collect facts** (deterministic, no judgment): file inventory; modules/packages; frontend apps and routes; entities and their relations; session/cache state the code keeps by name; controllers and their paths; security config; filters/interceptors; scheduled/async/listener/socket handlers; external SDKs and config keys; git activity per path (rename-aware); list of project docs. Exclude generated and tool folders (`target/`, `build/`, `node_modules/`, `.ua/`, `mindmodel/`). | `facts.json` (format defined by the engine's scanner) |
| 2 | **Read the project's docs.** All titles; fully read the intro docs (README, CLAUDE.md/AGENTS.md) and any doc about architecture, domain, tenancy, flows or security | Notes: vocabulary, intent, stated rules, stated non-goals |
| 3 | Core concepts (Part 3.3) | concepts + core sentence |
| 4 | Regions (Part 3.4) | regions + region sentence |
| 5 | State & source of truth (Part 3.5). Written after regions, because each writer is named by its region | owners |
| 6 | How a request travels (Part 3.6) | request path |
| 7 | What runs on its own (Part 3.7) | background table |
| 8 | Stories: choose, rank, trace (Part 3.9) | stories |
| 9 | Rules (Part 3.8). Written after tracing, because most rules show up while tracing | ranked rules |
| 10 | Overview, people & outside systems (Parts 3.1–3.2). Written last, when you understand the system | purpose, non-goals, boot, actors, externals |
| 11 | **Critique** against Part 4; fix; **verify** every citation; check budgets; trim (Part 5) | final `mindmodel.json` |

---

## Part 3. Section rules

They are in `rules/sections.md`, one heading per section (3.1 Overview … 3.9 Stories, plus the Tenancy note, Part 6 and two end notes). Read **only** the section you are drafting, when you start drafting it — never the whole file, and never all of it up front.

---

## Part 4. The critic's checklist

Run this on the whole draft before rendering. Every "no" must be fixed or explicitly justified.

**Distinctness**
- [ ] Each section answers only its own question (P2 table).
- [ ] The core sentence and the region sentence carry different ideas: how things relate vs. how code is laid out.
- [ ] No region card restates a concept card's lifecycle.
- [ ] The state section names who writes each concept; region cards don't repeat it.
- [ ] No story repeats another story's steps for more than two steps.

**Names**
- [ ] Each concept and region has one plain name, used identically everywhere.
- [ ] Stories use no concept names that aren't on the map.

**Truth**
- [ ] Every claim has a citation, and every cited range contains what the claim says (spot-check at least the core sentence, every lifecycle step, every rule and every story step).
- [ ] Every number is exact and cited.
- [ ] Security is described exactly as configured, and flawed behavior is stated plainly where a developer needs it.
- [ ] The map contains no secrets, no exploit instructions, and no "bug"/"vulnerability" labels; every weakness found was reported to the owner separately.
- [ ] Inferred story steps are marked, and there are as few as possible.

**Essence**
- [ ] No technical artifact is a core concept.
- [ ] No region is a technical layer.
- [ ] Rules are ranked, each with a reach × damage line.
- [ ] Stories are main flows, ranked, each with a reason; none is a change story.

**Size**
- [ ] The core map is within its tier and its flat caps (Part 7).
- [ ] Citations are per block, not per sentence (P3a): no section is cited line by line.

---

## Part 5. When over budget: what to cut first

Cut in the section the validator marks (`sections: … state 500/400!`), and only that section: the marks name the overflow, so the total follows.

1. Region "parts" beyond the 4 most important.
2. Region card text that describes behavior instead of layout.
3. Concept "fields that matter" beyond 3.
4. Background rows: merge rows with the same purpose.
5. Lines for outside systems the reader rarely meets.
6. Story steps that don't change any state.

Never cut citations, the core or region sentence, "Not to be confused with", the rule ranking, or the top story.

---

## Part 7. Size budgets

The core-word ceiling is set by the app's endpoint count; each section has a share of it. `facts.md` opens with this app's tier and numbers, and the validator prints them again and checks every section against its share.

| Element | Budget (a ceiling, never a target) |
|---|---|
| Overview | 1 purpose sentence (+ optional metaphor, + non-goals if stated); boot: 1 entry per deployable, ≤ 3 run steps |
| People & outside systems | ≤ 7 each, ranked |
| Core concepts | ≤ 6, one card each, plus 1 core sentence that mentions every concept |
| Regions | ≤ 7 + Shared infrastructure; ≤ 7 parts each |
| State & source of truth | 1 row per core concept; ≤ 400 words |
| How a request travels | ≤ 7 steps, ≤ 5 lanes |
| What runs on its own | ≤ 10 rows |
| Rules | ≤ 5 |
| Stories | 1–5, each ≤ 10 steps and about 250–500 words |
| Diagrams | 1: the request-path sequence |
| Words, core map (everything except stories) | the tier's ceiling in the table below |
| Words, regions and state | flat caps: regions ≤ 1,000, state ≤ 400 |

| Section | Tier 1 (≤ 50 endpoints) | Tier 2 (≤ 150) | Tier 3 (≤ 400) | Tier 4 (> 400) | Hard cap |
|---|---|---|---|---|---|
| core | 2200 | 2800 | 3600 | 4200 | — |
| purpose | 88 | 112 | 144 | 168 | — |
| context | 176 | 224 | 288 | 336 | — |
| concepts | 396 | 504 | 648 | 756 | — |
| regions | 396 | 504 | 648 | 756 | 1000 |
| state | 286 | 364 | 400 | 400 | 400 |
| runtime | 176 | 224 | 288 | 336 | — |
| background | 176 | 224 | 288 | 336 | — |
| rules | 286 | 364 | 468 | 546 | — |
| security | 154 | 196 | 252 | 294 | — |
| intros | 66 | 84 | 108 | 126 | — |
