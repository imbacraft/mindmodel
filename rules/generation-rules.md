# mindmodel: generation rules

**What this is:** the instructions for producing a mindmodel for any single application: a page with the essential mental model a developer must carry in their head to work on a codebase without an AI. The `/mindmodel` writer follows them exactly.
**Status:** v1.3. Examples use an invented course platform ("Coursely"); they illustrate, they are not templates.

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
| State & source of truth | Where does the truth for each concept live, who may change it, and where can copies disagree? |
| How a request travels | What happens to *every* API call, whatever the feature? |
| What runs on its own | What happens with no request at all? |
| Rules & surprises | What must you never get wrong, and what would surprise you? |
| Stories | How do the main flows actually run, end to end? |

**P3. Every claim is traced to code.** Each statement has a citation (`path`, `path:line` or `path:start-end`, optionally `#symbol`, which the validator checks is in the cited lines). The cited lines must contain what the text says. A claim you cannot trace is dropped, or, only in stories, marked *inferred*.

**P4. The code wins, silently.** Read the project's docs (README, CLAUDE.md, AGENTS.md, `docs/`, ADRs) for purpose, vocabulary and intent, then verify against the code. Where they disagree, write what the code does and say nothing about the doc. *Docs* means prose documentation. Configuration files are code: a config setting that the code ignores or overrides can be a surprise (3.8).

**P5. Plain names first, code names second.** Use the words the users and the business use ("School"). Show the code name after it (`OrgUnit`). Once a plain name is chosen, use exactly that name everywhere on the page. Don't name a region with a word that is also a concept's name unless the region is about that concept.

**P6. State behavior, never exploits.** The map describes how the code actually behaves, **including behavior that is flawed**, plainly and neutrally, because a developer can't work on a system they have been given a cleaned-up picture of (e.g. "the price is sent by the browser and charged as sent"). The map never explains how to abuse a weakness, never includes secrets, credentials or keys, and never labels anything a bug or vulnerability. **Separately**, report every security weakness and serious bug you find to the person who asked for the map.

**P7. Words first.** About 80% words. The only diagram is the request-path sequence. Draw any other diagram only if the relations it shows branch, loop or are many-to-many (a chain is a sentence).

**P8. Budgets are hard limits.** Core map (everything except stories) ≤ 3,000 words. Per-section limits are given below. Cut, merge or group; never cram.

**P9. Rank, don't list.** Where a section has several items of unequal weight (rules, stories), order them by importance and say in one line why each ranks where it does.

**P10. Exact numbers or none.** "42 entities", "every 30 s", "14 of 40 commits": exact and cited. Never "many", "several", "frequently".

---

## Part 2. Process

Work in this order. Later sections depend on earlier ones: everything is written in the concepts' names, and rules come out of tracing.

| Phase | What | Output |
|---|---|---|
| 1 | **Collect facts** (deterministic, no judgment): file inventory; modules/packages; frontend apps and routes; entities and their relations; session/cache state the code keeps by name; controllers and their paths; security config; filters/interceptors; scheduled/async/listener/socket handlers; external SDKs and config keys; git activity per path (rename-aware); list of project docs. Exclude generated and tool folders (`target/`, `build/`, `node_modules/`, `.ua/`, `mindmodel/`). | `facts.json` (format defined by the engine's scanner) |
| 2 | **Read the project's docs.** All titles; fully read the intro docs (README, CLAUDE.md/AGENTS.md) and any doc about architecture, domain, tenancy, flows or security | Notes: vocabulary, intent, stated rules, stated non-goals |
| 3 | Core concepts (Part 3.3) | concepts + core sentence |
| 4 | Regions (Part 3.4) | regions + region sentence |
| 5 | State & source of truth (Part 3.5). Written after regions, because each writer is named by its region | owners, copies, seams |
| 6 | How a request travels (Part 3.6) | request path |
| 7 | What runs on its own (Part 3.7) | background table |
| 8 | Stories: choose, rank, trace (Part 3.9) | stories |
| 9 | Rules & surprises (Part 3.8). Written after tracing, because most surprises show up while tracing | ranked rules |
| 10 | Overview, people & outside systems (Parts 3.1–3.2). Written last, when you understand the system | purpose, non-goals, boot, actors, externals |
| 11 | **Critique** against Part 4; fix; **verify** every citation; check budgets; trim (Part 5) | final `mindmodel.json` |

---

## Part 3. Section rules

### 3.1 Overview

**Goal:** in one breath, the reader knows who the system serves and what they get from it, plus what it will never be.

**Where to look:** the first paragraph of README / CLAUDE.md / AGENTS.md; the product's own marketing or landing page text (often in a frontend app or i18n file); plan/tier definitions; pricing enums.

**Write:**
- **Purpose sentence (1):** *who* + *what they get* + *how value or money moves*. No feature list, no tech stack. If the project is a demo, exercise or simulation, say so in the sentence.
  *Example:* "Coursely lets schools sell online courses to students and run their classes, with tuition paid through a payment provider straight to each school."
- **Metaphor (optional, 1–2 sentences):** only if it compresses the structure truthfully (e.g. tenancy as "a building that rents out classrooms"). Drop it if it needs a caveat.
- **Non-goals (1–2 sentences):** only what the project **states** it will never do (a "never build", "out of scope" or "non-goals" section, an ADR). Never infer non-goals from missing code. If nothing is stated, omit the field.

- **Boot (where it starts and how to run it):** the developer needs this before anything else can be checked in an IDE.
  - **Entry points:** one per deployable unit: the backend `main` (from `facts.md` → Boot) and the frontend root (`index.html` script → `main.tsx`), with the dev port and any API proxy from the bundler config. One line each.
  - **Run locally (≤ 3 steps):** the one way to start the **whole app** (dependencies + backend + frontend). If one command does it (e.g. the backend build also builds and serves the frontend), give only that command. List more steps only when the app can't run without them; frontend dev servers and other conveniences are left out. Take them from README, compose file, build file and `package.json` scripts, plus the names (never values) of env vars without which it will not start. If no step is stated or derivable, omit this part; never guess a command.
  - **Copy `facts.md` → Boot, computed** (run command, profile, port, whether the profile file is in git, whether the backend builds the frontend, required settings). Open files only if a line looks wrong. If the section is missing or incomplete, derive it by hand:
  - **Trace the run command to its profile.** Check which profile the run command activates (build-file run config such as `bootRun` args or the Spring Boot plugin's `profiles`, a `-Dspring.profiles.active` flag, or the env). Name that profile in the run note, and take ports and required settings from **its** config file, citing the line that sets them, not the main class. If its config file is not in git (check the ignore file), say the developer must create it. A conditional bean or flag that changes behavior is not listed here; if it would genuinely surprise a developer (a default that is not what the code claims), it competes for a slot in Rules & surprises (3.8).

**Checks:** Could someone outside software understand the purpose sentence? Does it name the user and the value? Is every non-goal backed by a stated source? Does every entry point cite the line that defines it? Does every run step come from a file in the repo?

### 3.2 People & outside systems

**Goal:** the reader knows the people the system serves, most important first, and every outside system it depends on at runtime.

**Find the people by what they do, not only by login.** A kind of person counts if any of these holds (cite it):
- they **pay** (checkout, subscriptions, invoices: who the money comes from);
- they **sign in** (security roles, `hasRole`, login flows, user-type entities);
- they **get a private link or token** (booking, order or reading links, client portals: endpoints with `{token}`);
- they **receive emails** (who the email templates and send calls address);
- they **act through their own part of the frontend** or URL zone (admin panel, public site, portal, `/api/admin`).

Kinds that differ only by permission level (OWNER vs EDITOR) are one actor; say the difference in a few words. Distinct goals or a distinct way of being identified make separate actors (≤ 7).

**Order people by importance:** (1) who pays the business, the primary customer; (2) the people they serve through it (their visitors, clients, bookers, leads); (3) staff and operators last. Within a group, the one more of the code serves comes first. Give each a one-line `importance`: why it ranks there.

**Outside systems:** systems the code **calls at runtime** (≤ 7), ordered by importance: money and data first (payment, database), then what core flows depend on (email, AI, storage, calendar), helpers last (CAPTCHA, geocoding). Libraries and build tools are not externals. Look in SDK dependencies, outbound HTTP clients and their base URLs, config keys naming outside services, the database driver, compose services.

**Actor or concept?** A kind of person is an **actor** here. They also become a **core concept** only if the business is about them (the customer whose orders, bookings or account the system manages). Staff and admin accounts stay actors, even when they have their own tables and CRUD screens.

**Write:** one line each: what they do / what it is used for, with a citation to where the code uses it. If one external plays two roles, say so (a payment provider used both for the platform's own subscription billing and for customers paying the tenants).

**Checks:** Did every way of paying, signing in, getting a link or receiving an email lead to an actor? Is the primary customer first and staff last? Is every external cited at a usage site, not just the dependency file? Is anything listed that the code never calls?

### 3.3 Core concepts (most important; take the most care)

**Goal:** the reader learns the ≤ 5 things everything else is about, can tell look-alikes apart, and knows how the concepts depend on each other. Every later section is told in these names.

**What a concept is:** something the users or the business talk about that has an identity and a lifecycle. It may span several entities (Organization account = `OrgAccount` + `OrgUser`). It is never a technical artifact (log, token, settings row, DTO).

**Funnel:**
1. **Candidates:**
   - every persistent entity (`@Entity`, tables, ORM models) and the frontend types that mirror them;
   - **non-persistent state that users name**: session attributes, cached objects, in-memory structures with a lifecycle (e.g. a shopping cart held in the HTTP session). The funnel would otherwise never find them.
2. **Collapse families before ranking.** Entities sharing a naming pattern or role (`*Settings`, `*Log`, `*Event`, `*Token`, join and lookup tables, base classes) become one chunk or are demoted as infrastructure. *Example:* without this, a family of 20+ `*Settings` entities can crowd the ranking because they change often. **Exception:** a line-item or detail entity that is part of another concept (order line, edition/format of a product) is folded into that concept, not demoted.
3. **Score** each remaining candidate on:
   - links from other entities (fan-in in the data model)
   - references from services and controllers
   - **presence in the frontend** (separates what users see from platform internals). For server-rendered views (JSP, Thymeleaf), count the views that render the entity's fields or receive it as a model attribute, not the views that merely contain its name as a word.
   - git change frequency
   - a status or lifecycle field

   **Dead model:** an entity no code path creates, reads or changes (no repository use, no controller or service reference) is left off the map, however central its name sounds. The same holds for views no controller returns.
4. **Shortlist** 10–15 with their evidence.
5. **Choose ≤ 5**, merging entities that are one idea for the user. Prefer candidates that appear in the frontend **and** have services **and** a lifecycle.
   - **Stages or variants of one idea share one card** (a prospect who becomes a customer; a guest buyer vs. a registered one). Name the card after the idea or both sides ("Lead & Client"), and spell out the difference in "Not to be confused with". This is chunking, not compromise: it keeps the count at ≤ 5 without losing the distinction.
   - Only **independent** concepts (different identity, different lifecycle, not one turning into the other) need separate cards. If a map genuinely needs a sixth independent concept, that is evidence to revisit the limit, not a reason to exceed it.
6. **Use the docs as evidence.** They often state the domain model outright (e.g. the tenancy model).

**Always include:**
- **The tenant or owner concept**, if the system is multi-tenant. Everything hangs off it.
- **Look-alike groups.** When ≥ 2 entities have overlapping plain meanings (customer / client / lead / user / account), the concept cards must separate them in "Not to be confused with". *Example:* `OrgAccount` pays the platform, `Student` pays the school, `Prospect` might pay later.

**Name mismatches:** if the code name misleads (an entity `Ticket` that actually represents *a paid seat in a class*), the plain name follows the meaning, and "Not to be confused with" explains the mismatch.

**Card fields:**

| Field | How to find it | Rule |
|---|---|---|
| Plain name · code names | Docs vocabulary, UI labels, i18n strings | Plain name first |
| What it is | Docs + how the UI presents it | One sentence, real-world meaning |
| Not to be confused with | Look-alike groups, name mismatches | **Only where confusion is likely**, else omit the field (most cards have none). Test: would a developer reading the code plausibly use the wrong one, or misread the name? A merely related concept, or a difference the card's own text already makes clear, does not qualify. ≤ 2 entries |
| Lifecycle | **First `facts.md` → Lifecycles, computed:** every method that sets each status value (conditional updates vs plain sets), ready to cite. Then: Creation sites (`new`, builders, `save`, `findOrCreate`); status enums; every `setStatus(X)`; jobs that expire, clean up or delete. If the schema or the valid values live in a SQL dump, migration or seed file, that file is the source: cite it (it is **not** demoted as data) | Each state change cited at the line that makes it |
| Relations | Foreign keys / associations between **core** concepts only, **plus runtime conversions** (one concept becomes another, e.g. a session cart is saved as an order) | Each cited; a short label; list each relation on one card only (the side that holds the reference or does the conversion); a card may have none |
| Fields that matter | Status, tenant key, links to other concepts, money, external IDs | 2–4 |
| Its rule | An invariant the code enforces about this concept (scoping, locking, validation) | Optional; cited |
| Where it lives | Entity · table · API path · frontend type or page | One line |

**Core sentence:** one sentence linking **every** concept in dependency order (what must exist before what), using the verbs of the actual relations. When one concept turns into another (cart → order), follow that conversion; that is still dependency, not a user's journey. Mark each concept as `[[id|text]]`.
*Example:* "An organization runs one or more schools; each school offers courses; a student enrolls in a course; and every paid enrollment produces an invoice."

**Checks:**
- Is any chosen concept a technical artifact, or a member of a collapsed family? → wrong.
- Does each look-alike group have a "Not to be confused with"? Does every entry pass the likely-confusion test, and is it absent everywhere else?
- Does every lifecycle step cite the line that performs it?
- Does the core sentence mention every concept, and only them, in dependency order?
- Is the core sentence about how the *things* relate (not a user's journey, and not the code layout)?

### 3.4 Regions

**Goal:** every feature the reader is asked about has a home in their head, and they know how the code is laid out to find it.

**Where to look:** top-level packages/modules; frontend app folders and route groups; controller base paths; which entities each package uses; git activity per path; doc folder names.

**Derive the regions:**
1. **Start from the codebase's own feature boundaries** (feature packages, apps, modules).
2. **Layer-organized code** (`controller/ service/ repository/ entity/` at the top): derive capabilities by grouping controllers by URL prefix and by the entities they use; merge groups that serve one capability. Then give each region the services, repositories, entities and views it uses; the region's codeName lists the layer folders it spans. Entities and repositories no single capability owns (lookup tables, base classes) go to Shared infrastructure.
   - **A controller that mixes capabilities** goes to the region of its main purpose; its stray endpoints are named in that region's parts.
3. **Shared packages** (`common/`, `core/`, `shared/`): carve out a separate region for any part that is a *capability* with its own concepts or its own external system (accounts & tenancy, payments). The remaining plumbing (security, email, storage, translations, API client layer) becomes **one "Shared infrastructure" card, always last**.
4. **At most 6 regions + Shared infrastructure** (7 in total is a ceiling, not a target). Fewer, fuller regions beat thin ones: a region that is only a screen or two (one controller and its forms) is merged into the nearest region serving the same actor. In small apps, staff-only screens usually form **one** back-office region. Never split one capability across regions.
5. **Each region spans tiers**: its frontend pages and its backend code together. Never a "Frontend" or "Backend" region.

**Order:** along the main actor's journey through the product. *Example:* sign up → set up → sell → deliver → get paid → support → shared infrastructure.

**Region sentence:** one sentence on **how the code is organized**: what the deployable pieces are, which regions have their own packages/apps, and which live in shared code. It must not repeat the core sentence. *Test:* swap each region name for its folder name; the sentence must still be true about the folders.

**Card fields:**
- **Name** (domain words) and **codeName** (the real packages/folders, backend and frontend).
- **Role:** one line, what the region is responsible for.
- **Text:** 2–4 sentences on what is *in the code* here and how it is put together. Do **not** restate concept lifecycles; the concept cards own those.
- **Owns:** the core concepts this region is primarily about. Each concept is owned by exactly one region: the one where users meet it most. Other regions that create or change it say so in their parts.
- **Parts:** ≤ 7 real sub-areas, each one line with a citation.
- **Paths and activity:** list the region's `paths` (folders or files). The activity badge is **computed by the validator** from them (if git history exists): commits touching the region's paths, out of all commits in the window, counted **rename-aware** (follow moved files: `git log -M --name-status`, mapping old paths to their current location). The page shows *changes often* (≥ 25%), *rarely* (< 10%), otherwise *sometimes*.
  - **Window:** the 6 months before the analyzed commit. **If that window holds fewer than 20 commits** (a dormant repo), use the last 50 commits instead (or all, if fewer), and record the window used in `since` (e.g. "last 50 commits"). If even that is fewer than 10 commits, omit activity: the badge would carry no signal.

**Checks:** Does every feature-level controller and frontend app belong to exactly one region? Is any region a technical layer? Does the region sentence describe folders rather than a journey? Does any card's text repeat a concept card?

### 3.5 State & source of truth

**Goal:** the reader knows, for each core concept, which copy is the truth, which code is allowed to change it, and where a second copy or a second step can disagree with it. Most real mistakes happen here: changing a concept from the wrong place and skipping its rules, trusting a stale copy, or assuming "saved" means "done" when the rest happens later. ("What code can change this?" is one of the questions developers find hardest to answer by reading.)

**Where to look:** `facts.md` → State (repository writes per entity grouped by file, `@Modifying` queries, caches and client storage, transaction/event lines in files that call outside systems); session state; webhook and scheduled handlers; the frontend's query cache and local storage.

**Write three parts, in this order** (copies are short sentences: what it holds, who wins, when it goes stale):

1. **Owners (one row per core concept):**
   - **Truth:** where the authoritative value lives. Usually "the database"; say more only when it differs: an outside system wins on conflict (the payment provider for payment status), part of it is derived and never stored, or it is copied into another row at a moment and then frozen (a price copied into an order).
   - **Written by:** the region and the file that make the normal changes, and the method or rule every change must pass (a state-transition method, a check, a version row). Cite it.
   - **Other writers:** every other region or job that changes it (from the scanner's write list), each cited. If there is at least one, the row is marked **shared write**: say in a few words whether the other writers go through the same rule. A data import or seeding tool that writes everything is named once in the intro, not on every row.
2. **Copies that can disagree (≤ 5):** every second place that holds a version of a concept and can be out of date: session state, server cache, browser storage, frontend query cache, a copied column, an outside system's mirror. For each: what it holds, which side wins, and when it is refreshed or goes stale (exact TTL or trigger, cited). Leave out copies that cannot be stale in practice. If there are none, say so in one line.
3. **Steps that can half-succeed (seams, ≤ 4):** places where one change is split into steps that do not commit together: a transaction commits and then an outside system is called; a webhook or job finishes the change later; an event is published before or after commit. Each seam: the span (*first step → second step*), both sides cited, and **what happens when the second step fails or never arrives** (a retry, a cleanup job, a reconciler, or nothing; nothing must be said plainly).
   **Start from `facts.md` → Seams, computed.** Each line is a seam the scanner proved (an outside call inside a transaction, directly or via another bean; an after-commit hook; a new transaction; a job deleting rows). Each must be listed or dismissed on purpose; for an outside call inside a transaction, the usual failure is that the outside side happened and the local row rolled back. A cleanup job that deletes rows matters when an outside callback (a webhook) can still arrive for a deleted row.

**Not here:** field lists, DTO mappings, every table. A trap in how data changes shape across tiers (money as cents, times in UTC) is a surprise (3.8), not a row here.

**Checks:** Does every core concept have exactly one owner row? Is every other writer from the scanner's list either on its row or deliberately left off as a seeding/import tool? Does each seam cite both sides and say what happens on failure? Is any copy listed that cannot actually be stale?

### 3.6 How a request travels

**Goal:** the reader has a working model of the machinery every request goes through, so they know where any request can be stopped, which tenant/user it belongs to, and why queries look the way they do.

**Where to look (framework configuration, not a feature):** the frontend API client (fetch wrapper, auth header, base URL); security configuration (filter chains, path matchers, auth mechanism, method security); filters and interceptors with their registration order; tenant/user context resolution and its scope; controller conventions (base class, response wrapper, error handler); service base classes; data-access conventions (scoping, transactions).

**Procedure:** follow **one real call** from the frontend call site to the database and back, reading the configuration at each hop. Then check each step holds for **all** API calls. If it holds only for some, name them ("`/api/admin/**` requires a JWT").

**Write:**
- ≤ 7 steps; lanes = the systems involved (typically browser, backend, database; add an external only if every request touches it).
- Each step: a short label for the diagram (≤ 56 chars), the region it belongs to, 1–2 sentences, citations.
- Security steps state **exactly** what the configuration does: which paths require what, and what is open (P6).
- Behavior that comes from a **framework default** (not written in any config, e.g. CSRF protection on by default) is stated as such: "framework default", citing the configuration that leaves it in place.

**Checks:** Is any step feature-specific? Is the order the real runtime order (verify registration order, filter chain order)? Does the security step match the configuration line for line?

### 3.7 What runs on its own

**Goal:** the reader knows everything that happens with no request, and the one property it all shares.

**Where to look:** `facts.md` → Schedules and retries, computed (timing already in plain words, with each job's time windows), then `@Scheduled` / cron / timers; `@Async`; event listeners; message consumers (`@KafkaListener`, `@RabbitListener`, `@JmsListener`, …); webhook endpoints whose work continues after the response; queue or outbox workers (tables polled by a worker); startup runners; **real-time socket handlers** (WebSocket/STOMP `@MessageMapping`, connect/disconnect listeners). Socket messages are sent by clients, but they don't go through the page/API request path and often push to *other* users, so they belong here, with "when" = "on each message" or "on disconnect".

**Write:**
- **Intro:** the shared rule. Usually: *no request, so no request-scoped context (tenant, user, transaction) unless the code sets it*. Cite where it is set manually.
- **Table**, ≤ 10 rows, grouped by purpose (not one row per class): name · when (human terms: "every 20 s", "hourly", "nightly 03:00") · what it does, in one or two sentences · region · citations to each scheduler or worker.
- If an item explains user-visible delay ("paid" arrives after the redirect), say it in that row.
- If the app truly has nothing that runs on its own, say so in the intro: that is itself useful knowledge.

**Checks:** Did every `@Scheduled`, `@Async`, listener and worker found in phase 1 land in some row? Is every schedule copied exactly from the code or config?

### 3.8 Rules & surprises

**Goal:** the reader never makes the mistakes that matter most, and isn't blindsided by behavior that contradicts a reasonable assumption.

**Candidates come from:**
- Statements in the project's docs ("always", "never", "must").
- Conventions the code enforces: base classes, mandatory scoping, locks, idempotency checks.
- Places where the code differs from framework defaults or from what its names suggest.
- Asynchronous boundaries, where effects arrive later than they appear to.
- Money handling.
- Cross-cutting "touch X, also change Y" couplings.
- **Whatever surprised you while tracing the stories.**

**Qualify:** non-obvious **and** consequential **and** verifiable in code. Not code smells, not style guides (unless breaking them causes real damage), not doc mismatches (P4). Flawed behavior a developer must know to work safely (e.g. "the charged price comes from the browser") qualifies, stated as behavior, never as a vulnerability or an exploit (P6).

**Kind:** *rule* = something you must do or never do. *Surprise* = something that behaves unexpectedly.

**Rank** by **reach × damage**:

| | Reach: how much of the code or traffic it applies to |
|---|---|
| High | every request, every query, or every change to the data model |
| Medium | one kind of work across the system (e.g. everything involving money), or a whole region |
| Low | one feature or one flow |

| | Damage: the worst realistic result of breaking or misunderstanding it |
|---|---|
| Severe | data leak between tenants/users (incl. reading the tenant from the wrong place); money lost or wrongly charged |
| High | data corruption; a whole feature or flow broken for all users (e.g. onboarding, a form that always fails) |
| Medium | a user-visible bug in one feature |
| Low | confusion and wasted debugging time |

**Order:** by reach (High > Medium > Low); within the same reach, by damage; if still tied, the one a developer acts on more often comes first (writing queries daily beats reasoning about request routing). ≤ 5 items.

*Example ranking:* filter every query by `tenant_id` (High, Severe; acted on in every query) → every schema change needs a migration file (High, High) → refunds take a separate code path from payments (Medium, Severe) → search results are cached for 5 minutes (Low, Low).

**Write:** title (the rule itself, imperative or declarative) · **importance line** naming the reach and the damage · 2–4 sentences on the obligation and its consequence (focus on what the developer must do; the mechanism may be shown elsewhere, so don't re-explain it at length) · citations.
*Example:* #1 "Filter every query by `tenant_id`: touches every query; one missed filter shows one school's data to another."

**Checks:** Would a competent newcomer get this wrong by reading the code naively? Does the importance line justify the rank against its neighbors?

### 3.9 Stories

**Goal:** the reader sees the main flows run end to end through real code, which ties concepts, regions and the request path together.

**Start from `facts.md` → Flow skeletons, computed:** each state-changing entry point with what happens in order (outside effects, saves, status changes, async hand-offs, after-commit work), ranked by how much of the core it touches. Pick and trace stories from these; open only the methods a step needs explained.

**Choose the candidates:**
- For each **primary actor** (from People & outside systems), find the flows that deliver what they come for: where value is created, money moves, or the core entity is created. Look at entry points that write core concepts, external-payment calls and webhook handlers, and the product's main screens.
- Always consider: **how the tenant/customer comes to exist** (signup or onboarding), and **the failure path of the top flow**: what actually happens when it fails (retries, idempotency, cleanup, or, if failures are swallowed, that the flow continues as if it succeeded).

**Qualify.** A story is on the map only if it runs through **the absolute core** of the app. All of these must hold:
- it delivers what a primary actor comes for, or creates the core entity everything else depends on;
- it creates or changes at least one core concept;
- it happens routinely in normal use, not rarely (a once-per-staff-member setup, a niche feature, or a side channel like chat does not qualify unless it is the product);
- a newcomer would be lost without it.

A failure path qualifies only if what happens on failure changes core state in a way the developer must know (e.g. a failed payment still saving the order as paid).

**Rank** the qualifying stories by **centrality × breadth**: how central the flow is to what the product does, times how many regions and concepts it runs through. **1–5 stories; never pad.** Two strong stories beat four where two are weak. A failure path ranks directly after the flow it belongs to.

**Trace, step by step:**
1. Start at the frontend page or component the user acts on; cite the call site.
2. Match the call to the backend endpoint by method and path; cite both sides.
3. Follow the service calls; record each state change of a core concept (cite the line).
4. Follow external calls and their **asynchronous continuations** (webhooks, jobs, queues) into the code that handles them.
5. Record notifications (email, calendar).
6. Stop at a user-visible end state.

**Trace the real path, flaws included (P6).** If the code charges twice, ignores a failure, or trusts a value from the browser, the story says so, neutrally, in the step where it happens. A story that skips the inconvenient call teaches a wrong model. Describe what the code *does*. Where you suspect it fails at runtime but can't confirm it by reading, describe the code's behavior and leave the predicted failure out (report it to the owner instead).

**Write:**
- One **persona** reused across stories, with concrete values that are **valid in the code** (a price type that exists, a real duration, a real status). Valid values may come from a SQL dump or seed file; cite it.
- ≤ 10 steps, about 250–500 words. Each step: the region it happens in, 1–3 sentences, citations.
- **Importance line:** why it ranks here.
- **Takeaways:** 2–3 lines tying it back to concepts, regions and rules.
- Only the map's plain names. Never introduce a new concept name inside a story.

**Never:** change stories ("you're asked to add a field…"); these teach a task, not the system. Never invented behavior: a step you could not trace is marked `inferred: true` or removed.

**Report, don't force:** regions no story runs through are listed for the critic. Do not invent a flow just to cover a region.

**Checks:** Does every step cite code that does what the step says? Do the values used actually exist in the code (enum values, durations)? Does the top-ranked flow deliver the product's core value?

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
- [ ] All budgets are met (Part 7); core map ≤ 3,000 words.

---

## Part 5. When over budget: what to cut first

1. Region "parts" beyond the 4 most important.
2. Region card text that describes behavior instead of layout.
3. Concept "fields that matter" beyond 3.
4. Background rows: merge rows with the same purpose.
5. Lines for outside systems the reader rarely meets.
6. Story steps that don't change any state.

Never cut citations, the core or region sentence, "Not to be confused with", the rule ranking, or the top story.

---

## Part 6. When the repo is shaped differently

| Situation | What changes |
|---|---|
| **Layer-organized code** (`controller/ service/ repo/ entity/` at the top) | Regions come from grouping controllers by URL prefix and the entities they use (3.4 step 2). The region sentence says the code is split by layer, and names how capabilities map onto it. |
| **Server-rendered views** (JSP, Thymeleaf) instead of an SPA | Views count as the frontend. Story steps start at the view and its form or link. The request path still starts at the browser (the link or form submit), because the security filters run before the controller; it ends with the view rendering HTML. |
| **No frontend** (API only) | Regions are backend-only; the request path starts at the API client or gateway. |
| **Single-tenant** | No tenant concept or tenant rule. The request-path step for context resolution becomes user/session resolution. |
| **No git history** | No activity badges; regions are still ordered by journey. |
| **Dormant repo** (few recent commits) | Activity uses the last 50 commits instead of 6 months; under 10 commits in total, no badges (3.4). |
| **Uncommitted changes in the working tree** | Map the working tree as it is on disk (that is the code the developer will open). `project.commit` = the short HEAD hash followed by "+ local changes". |
| **No project docs** | Purpose and vocabulary come from UI text, i18n files and entity names; non-goals are omitted (3.1). |
| **Nothing runs on its own** | The background section says so in its intro (3.7). |
| **Concept relations branch or loop** | A concept map may replace the core sentence (P7); the cards stay. |

---

## Part 7. Size budgets

| Element | Budget (a ceiling, never a target) |
|---|---|
| Overview | 1 purpose sentence (+ optional metaphor, + non-goals if stated); boot: 1 entry per deployable, ≤ 3 run steps; ≤ 150 words |
| People & outside systems | ≤ 7 each, ranked |
| Core concepts | ≤ 5, one card each, plus 1 core sentence that mentions every concept |
| Regions | ≤ 6 + Shared infrastructure; ≤ 7 parts each |
| State & source of truth | 1 row per core concept; ≤ 5 copies; ≤ 4 seams; ≤ 400 words |
| How a request travels | ≤ 7 steps, ≤ 5 lanes |
| What runs on its own | ≤ 10 rows |
| Rules & surprises | ≤ 5 |
| Stories | 1–5, each ≤ 10 steps and about 250–500 words |
| Diagrams | 1: the request-path sequence |
| Words, core map (everything except stories) | ≤ 3,000 |
