# mindmodel: generation rules — core

**What:** the rules for one application's mindmodel: what a developer must hold in their head to work on the code without an AI. The `/mindmodel` writer follows them exactly. Examples use an invented platform ("Coursely") and illustrate only.

**Read:** this file every run. Section rules (3.1–3.9, Tenancy, Part 6, security note) are in `rules/sections.md`: open only the section you draft.

---

## Part 1. Principles that govern every section

**P1. Essence, not coverage.** Carry only what a developer must hold in their head. Leave out what they can look up: fields, every endpoint, every class. In doubt, leave it out.

**P1a. No filler.** Every item touches the core. Budgets are ceilings, never targets. Never add an item to reach a count.

**P2. One idea per section,** stated by its `**Goal:**` line. Two sections saying the same thing means one is wrong.

**P3. Every claim is traced to code, once per claim block.** A block (rule, region part, concept card, story step) carries one or two cites: `path`, `path:line`, `path:start-end`, optionally `#symbol`, checked against the cited lines. Never one cite per sentence. A bare `#name` over same-named methods is ambiguous: cite by range or arity (`#save/2`). Untraceable claims are dropped, or marked *inferred* (stories only).

**P3a. The cite count is a signal.** About 2 per rule, 4 per region, 2 per concept, 1 per step (request path and stories), and 1 per background row and per state owner: about 90–120 on a seven-region app. The validator warns above 1.4× that.

**P4. The code wins, silently.** Read docs (README, CLAUDE.md, AGENTS.md, `docs/`, ADRs) for purpose and vocabulary, then check the code. Where they disagree, write what the code does and say nothing about the doc. Configuration files are code: an ignored setting can be a rule (3.8).

**P4a. The coverage line is a boundary.** `facts.md` opens with what the engine resolved and did not. Cite `parsed` and `resolved` facts as they are. Check `inferred` facts in the code first. The blind spots are "What the engine did not understand" (unknown annotations, unexplained base classes, uncatalogued dependencies, unreadable or degraded files, and the classpath line: with `mode: none`, every dependency type is a name without members) and unresolved endpoints. Read the code there, or leave it out.

**P5. Plain names first, code names second.** Use the users' words ("School"), then the code name (`OrgUnit`), and use that name everywhere. A region takes a concept's name only if it is about that concept.

**P6. State behavior, never exploits.** Describe how the code behaves, flaws included, neutrally: "the price is sent by the browser and charged as sent." Never explain abuse. Never include secrets, credentials or keys. Never label anything "bug" or "vulnerability". Weaknesses go to `findings.md`. Where a developer must know the behavior, state it and point there.

**P7. Words first.** About 80% words. The only diagram is the request-path sequence. Add another only when relations branch, loop or are many-to-many.

**P8. Budgets are size tiers.** The core map (everything except stories) scales with the endpoint count in four tiers. Regions and state carry flat caps. Part 7 states the numbers once: use them, do not restate them. `facts.md` opens with this app's tier and targets (`**budget: …**`). Cut, merge or group; never cram. A section far under its share is thin.

**Draft to the targets, once.** Write each section to its share. The validator prints `sections: purpose 150/144 · …`: `!` marks an over-share section (cut it), `_` a section under 60% of its share (fill it to the share, not the ceiling). Fix only marked sections. Never re-read to count words. Never rewrite the map to fix one number.

**P9. Rank, don't list.** Items of unequal weight (rules, stories) go in importance order, each with one line on why it ranks there.

**P10. Exact numbers or none.** "42 entities", "every 30 s", "14 of 40 commits": exact and cited. Never "many", "several" or "frequently".

**P10a. State the condition; absolutes only when guaranteed.** Example: "when `sureness.excludedResource` lists it, `/api/webhooks/**` skips authentication", not "requests are authenticated". Use *never*, *always*, *all requests* or *no one* only when the code guarantees it (a constant, an exhaustive switch, a single entry point). Otherwise the rule carries a `condition` field; the validator warns on absolute wording without one. A probable defect goes to the owner's findings, not the rules (P6).

---

## Part 2. Process

Work in this order. Later steps depend on earlier ones.

**Facts are where to start, not the answer.** A fact proves that a call exists; the cited method proves what it does. A "not found" fact is a fact about the engine: write "no setter found by the engine", never "never set" or "never called".

1. **Collect facts** → `facts.json`, in the engine's scanner format, with no judgment. Exclude `target/`, `build/`, `node_modules/`, `.ua/`, `mindmodel/`.
2. **Read the docs:** every title, and README, CLAUDE.md/AGENTS.md and any architecture, domain, tenancy, flow or security doc in full. This gives vocabulary, intent, stated rules and non-goals.
3. Core concepts (3.3) → concepts and core sentence.
4. Regions (3.4) → regions and region sentence.
5. State (3.5) → owners, after regions, so each writer is named by its region.
6. Request path (3.6). 7. What runs on its own (3.7). 8. Stories (3.9). 9. Rules (3.8).
10. Overview, people and outside systems (3.1–3.2), last.
11. **Critique** against Part 4; fix; **verify** every cite; check budgets; trim (Part 5) → final `mindmodel.json`.

---

## Part 3. Section rules

One heading per section. Read only the section you draft.

---

## Part 4. The critic's checklist

Run on the whole draft before rendering. Every "no" is fixed or explicitly justified.

**Distinctness**
- [ ] Each section answers only its own question (P2; its Goal line).
- [ ] The core sentence and the region sentence carry different ideas: how things relate vs. how code is laid out.
- [ ] No region card restates a concept card's lifecycle.
- [ ] The state section names who writes each concept; region cards don't repeat it.
- [ ] No story repeats another story's steps for more than two steps.

**Names**
- [ ] Each concept and region has one plain name, used identically everywhere.
- [ ] Stories use no concept names missing from the map.

**Truth**
- [ ] Every claim has a cite, and every cited range contains what the claim says. Spot-check at least the core sentence, every lifecycle step, every rule and every story step.
- [ ] Every number is exact and cited.
- [ ] Security is described exactly as configured; flawed behavior is stated plainly where a developer needs it.
- [ ] No secrets, exploit instructions, or "bug"/"vulnerability" labels. Each weakness went to the owner separately.
- [ ] Inferred story steps are marked, and as few as possible.

**Essence**
- [ ] No technical artifact is a core concept.
- [ ] No region is a technical layer.
- [ ] Rules are ranked, each with a reach × damage line.
- [ ] Stories are main flows, ranked, each with a reason. None is a change story.

**Size**
- [ ] The core map is within its tier and its flat caps (Part 7).
- [ ] Cites are per block, not per sentence (P3a).

---

## Part 5. When over budget: what to cut first

Cut only in the section the validator marks (`sections: … state 500/400!`).

1. Region parts beyond the 4 most important.
2. Region card text that describes behavior instead of layout.
3. Concept "fields that matter" beyond 3.
4. Background rows with the same purpose: merge them.
5. Lines for outside systems the reader rarely meets.
6. Story steps that change no state.

Never cut citations, the core or region sentence, "Not to be confused with", the rule ranking, or the top story.

---

## Part 7. Size budgets

The ceiling follows the endpoint count. `facts.md` carries this app's tier and each section's share; the validator checks every section against it.

| Element | Budget (a ceiling, never a target) |
|---|---|
| Overview | 1 purpose sentence, plus optional metaphor and non-goals (only if stated). Boot: 1 entry per deployable (≤ 4), ≤ 3 run steps |
| People & outside systems | ≤ 7 actors and ≤ 7 externals, each ranked |
| Core concepts | ≤ 6 cards, plus 1 core sentence naming every concept |
| Regions | ≤ 8 cards: 7 domain regions + Shared infrastructure (last); ≤ 7 parts each |
| State & source of truth | 1 owner row per core concept; ≤ 400 words |
| How a request travels | ≤ 7 steps, ≤ 5 lanes |
| What runs on its own | ≤ 10 rows |
| Rules | ≤ 5 |
| Stories | 3–5, each ≤ 10 steps and about 250–500 words |
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
