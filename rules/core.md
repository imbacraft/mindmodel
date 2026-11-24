# mindmodel: generation rules — core

**What this is:** how to write one application's mindmodel: the mental model a developer needs to work on the code without an AI. The `/mindmodel` writer follows these rules exactly. **Status:** v1.4. Examples use an invented course platform ("Coursely"); they illustrate, they are not templates.

**How to read:** read this file on every run. The section rules (3.1 Overview … 3.9 Stories, the Tenancy note, Part 6 and two end notes) are in `rules/sections.md`: open **only** the section you are drafting.

---

## Part 1. Principles that govern every section

**P1. Essence, not coverage.** The map carries what a developer must hold in their head. Anything they can look up stays off: field lists, every endpoint, every class. In doubt, leave it out.

**P1a. No filler.** Every item touches the core of the app. **Budgets are ceilings, never targets**: never add an item to reach a count. A weak or rare item is worse than a missing one: it teaches the reader the map holds noise.

**P2. One idea per section.** Each section answers one question, stated by its `**Goal:**` line in `rules/sections.md`. If two sections say the same thing, one is wrong.

**P3. Every claim is traced to code, once per claim block.** A block (rule, region part, concept card, story step) carries one or two citations: `path`, `path:line`, `path:start-end`, optionally `#symbol`, checked against the cited lines. Never one per sentence; a block stating unrelated things cites each part once. A bare `#name` over same-named methods is ambiguous (the validator lists the candidates): cite by range or arity (`#save/2`). An untraceable claim is dropped, or marked *inferred* in stories only.

**P3a. The cite count is a signal, not a score.** About 2 cites per rule, 4 per region, 2 per concept, 1 per step (request path and stories), 1 per background row and per state owner: about 90–120 on a seven-region app. The validator warns above 1.4× that: sentences cited one by one.

**P4. The code wins, silently.** Read the docs (README, CLAUDE.md, AGENTS.md, `docs/`, ADRs) for purpose, vocabulary and intent, then check the code. Where they disagree, write what the code does and say nothing about the doc. *Docs* means prose; configuration files are code, and a setting the code ignores can be a rule (3.8).

**P4a. The coverage line is a boundary, not a footnote.** `facts.md` opens with what the engine resolved and what it did not; every fact carries a confidence. `parsed` and `resolved` facts are settled: cite them without re-reading the code. `inferred` ones: check the code first. "What the engine did not understand" (unknown annotations, unexplained base classes, uncatalogued dependencies, unreadable or degraded files) and the unresolved endpoints are where the facts are blind: read the code there, or leave it out.

**P5. Plain names first, code names second.** Use the users' words ("School"), then the code name (`OrgUnit`), and use that name everywhere. A region never takes a concept's name unless it is about that concept.

**P6. State behavior, never exploits.** Say how the code behaves, **flaws included**, plainly and neutrally (e.g. "the price is sent by the browser and charged as sent"): a developer cannot work from a cleaned-up picture. Never explain how to abuse a weakness, include secrets, credentials or keys, or label anything a bug or vulnerability. **Separately**, report every security weakness and serious bug in `findings.md` (see the writer steps), never as a convention in the map's rules. Where a developer must know the behavior, say it neutrally and point at the findings: no exploit details, no "bug" label.

**P7. Words first.** About 80% words. The only diagram is the request-path sequence; another only if its relations branch, loop or are many-to-many (a chain is a sentence).

**P8. Budgets are size tiers, with flat caps where overflow lives.** The core map (everything except stories) is capped by the app's endpoint count, in four tiers; regions and state carry flat caps at every tier. Part 7 states the numbers once: use them, do not restate them. `facts.md` opens with this app's tier and section targets (`**budget: …**`). Cut, merge or group; never cram. A section far under its share is thin, not efficient: it stopped answering its question.

**Draft to the section targets, once.** Each section has a share of the tier (Part 7). Writing by feel overshoots and costs more to cut than to write. Write once, to those numbers, and let the validator count: it prints `sections: purpose 150/144 · …` and marks each over-share section with `!` and each section under 60% of its share with `_`. A `!` section is cut; a `_` section is filled, to the share, not to the ceiling. Fix only the marked sections, until none is marked. Never re-read the draft to count words; never rewrite the map to fix one number.

**P9. Rank, don't list.** Where a section holds items of unequal weight (rules, stories), order them by importance and give one line on why each ranks there.

**P10. Exact numbers or none.** "42 entities", "every 30 s", "14 of 40 commits": exact and cited. Never "many", "several", "frequently".

**P10a. State the condition; absolutes only when the code guarantees them.** A claim holds under conditions: a tenant, a role, a configuration key, a transaction, a path prefix. Write "when `sureness.excludedResource` lists it, `/api/webhooks/**` skips authentication", not "requests are authenticated". *Never*, *always*, *all requests*, *no one* only when the code guarantees them (a constant, an exhaustive switch, a single entry point); otherwise the rule carries a `condition` field and the validator rejects the absolute. A probable defect is not a rule: it goes in the owner's findings, and the map stays neutral (P6).

---

## Part 2. Process

Work in this order. Later sections depend on earlier ones: everything is written in the concepts' names, and rules come out of tracing.

1. **Collect facts** (deterministic, no judgment) → `facts.json`, in the engine's scanner format: file inventory; modules; frontend apps and routes; entities and relations; session/cache state kept by name; controllers and paths; security config; filters and interceptors; scheduled/async/listener/socket handlers; external SDKs and config keys; git activity per path (rename-aware); project docs. Exclude generated and tool folders (`target/`, `build/`, `node_modules/`, `.ua/`, `mindmodel/`).
2. **Read the docs** → vocabulary, intent, stated rules, non-goals. Read every title; README, CLAUDE.md/AGENTS.md and any doc on architecture, domain, tenancy, flows or security in full.
3. Core concepts (3.3) → concepts + core sentence.
4. Regions (3.4) → regions + region sentence.
5. State & source of truth (3.5) → owners. After regions: each writer is named by its region.
6. How a request travels (3.6) → request path.
7. What runs on its own (3.7) → background table.
8. Stories (3.9) → choose, rank, trace.
9. Rules (3.8) → ranked rules. Most appear while tracing.
10. Overview, people & outside systems (3.1–3.2) → purpose, non-goals, boot, actors, externals. Last, once you understand the system.
11. **Critique** against Part 4; fix; **verify** every citation; check budgets; trim (Part 5) → final `mindmodel.json`.

---

## Part 3. Section rules

One heading per section. Read **only** the section you are drafting, when you start it: never the whole file.

---

## Part 4. The critic's checklist

Run this on the whole draft before rendering. Every "no" is fixed or explicitly justified.

**Distinctness**
- [ ] Each section answers only its own question (P2; the Goal line of its rule).
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

Cut only in the section the validator marks (`sections: … state 500/400!`).

1. Region "parts" beyond the 4 most important.
2. Region card text that describes behavior instead of layout.
3. Concept "fields that matter" beyond 3.
4. Background rows: merge rows with the same purpose.
5. Lines for outside systems the reader rarely meets.
6. Story steps that don't change any state.

Never cut citations, the core or region sentence, "Not to be confused with", the rule ranking, or the top story.

---

## Part 7. Size budgets

The ceiling follows the app's endpoint count; `facts.md` carries this app's tier and each section's share, and the validator checks every section against it.

| Element | Budget (a ceiling, never a target) |
|---|---|
| Overview | 1 purpose sentence (+ optional metaphor, + non-goals if stated); boot: 1 entry per deployable, ≤ 3 run steps |
| People & outside systems | ≤ 7 each, ranked |
| Core concepts | ≤ 6 cards plus 1 core sentence naming every concept |
| Regions | ≤ 7 + Shared infrastructure; ≤ 7 parts each |
| State & source of truth | 1 row per core concept; ≤ 400 words |
| How a request travels | ≤ 7 steps, ≤ 5 lanes |
| What runs on its own | ≤ 10 rows |
| Rules | ≤ 5 |
| Stories | 1–5, each ≤ 10 steps and about 250–500 words |
| Diagrams | 1: the request-path sequence |
| Words, core map (everything except stories) | the tier's ceiling below |
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
