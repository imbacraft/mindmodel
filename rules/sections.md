# mindmodel: section rules

Part 3, Part 6 and the security note. `rules/core.md` holds the principles, process, checklist, cut order and budgets. Read it every run. Here, read **only** the section you draft.

---

## Part 3. Section rules

### Tenancy

- The digest's **Tenancy** section is the whole tenant-key story. Keep "inferred" where it says so. A key the engine did not choose is `null`: report it as a finding, never guess a field name.
- "Scoped by X" holds only when the fact says so. An entity listed as lacking the key is unscoped in every read unless the code checks the tenant elsewhere. Cite that check, or name the gap in `findings.md`.
- A job, listener, async method or worker that reaches a keyed repository with the tenant context **not set** is a probable defect: warn neutrally on the page, and put the evidence in the findings.

## 3.1 Overview

**Goal:** who the system serves, what they get, and what it will never be.
**Where to look:** README / CLAUDE.md / AGENTS.md first paragraph; landing or i18n text; plan tiers; pricing enums.

- **Purpose (1 sentence):** who, what they get, and how value or money moves. No feature list or tech stack. Say so if the project is a demo or simulation. *Example:* "Coursely lets schools sell online courses to students and run their classes, with tuition paid straight to each school."
- **Metaphor (optional, 1–2 sentences):** only if it compresses the structure truthfully, with no caveat.
- **Non-goals (1–2 sentences):** only what the project **states** it will never do. Never infer them from missing code.
- **Boot** (needed before anything else can be checked in an IDE):
  - **Entry points:** one per deployable: backend `main` (`facts.md` → Boot), frontend root (`index.html` → `main.tsx`), with the dev port and any API proxy.
  - **Run locally (≤ 3 steps):** the one way to start the **whole app**. One command if one does it. No dev servers. Nothing stated or derivable: omit. Sources: README, compose file, build file, `package.json` scripts, and env var **names** (never values) needed to start. Never guess a command.
  - **Copy `facts.md` → Boot, computed:** run command, profile, port, profile file in git, backend builds frontend, required settings. Open files only if a line looks wrong; derive it by hand if the section is missing or incomplete.
  - **Trace the run command to its profile** (`bootRun` args, Spring Boot plugin `profiles`, `-Dspring.profiles.active`, env). Take ports and settings from **its** config file, citing the line. A profile file not in git (check the ignore file): say the developer must create it. Surprising conditional beans or flags compete for a Rules slot (3.8).

**Checks:** Does the purpose name the user and the value? Is every non-goal sourced? Does every entry point cite its line, and every run step come from a repo file?

## 3.2 People & outside systems

**Goal:** the people the system serves, most important first, and every outside system the code calls at runtime.

**Find people by what they do.** A kind counts if it (cite it) **pays** (checkout, subscriptions, invoices); **signs in** (roles, `hasRole`, login flows, user-type entities); **gets a private link or token** (`{token}` endpoints); **receives emails** (template and send-call recipients); or **acts through its own frontend part or URL zone** (admin panel, public site, portal). Kinds differing only by permission level are one actor; say the difference in a few words. Distinct goals or identification make separate actors (≤ 7).

**Order:** (1) who pays, the primary customer; (2) the people they serve (visitors, clients, leads); (3) staff and operators last. Each gets a one-line `importance`: why it ranks there.

**Outside systems** (≤ 7, by importance): money and data first (payment, database), then core-flow dependencies (email, AI, storage, calendar), then helpers (CAPTCHA, geocoding). Libraries and build tools are not externals. Look in SDK dependencies, outbound HTTP clients and base URLs, config keys naming outside services, the database driver and compose services.

**Actor or concept?** An actor, unless the system manages that kind's own orders, bookings or account. Only then is it a **core concept**. Staff and admin accounts stay actors, even with their own tables.

**Write:** one line each, cited at the usage site. An external playing two roles says so.

**Checks:** Does every way of paying, signing in, getting a link or receiving an email lead to an actor? Primary customer first, staff last? Every external cited at a usage site, and none listed that the code never calls?

## 3.3 Core concepts (most important; take the most care)

**Goal:** the ≤ 6 things everything else is about, look-alikes told apart, and how they depend on each other.

**What a concept is:** something users or the business talk about, with an identity and a lifecycle. It may span entities (Organization account = `OrgAccount` + `OrgUser`). Never a technical artifact (log, token, settings row, DTO).

**Funnel:**
1. **Candidates:** persistent entities (`@Entity`, tables, ORM models) and their frontend types, plus **non-persistent state users name** (session attributes, cached objects, in-memory structures with a lifecycle, e.g. a cart in the HTTP session).
2. **Collapse families first:** entities sharing a pattern or role (`*Settings`, `*Log`, `*Event`, `*Token`, join and lookup tables, base classes) become one chunk or are demoted as infrastructure. Exception: a line-item or detail entity (order line, product edition) folds into its parent.
3. **Score:** fan-in; references from services and controllers; **frontend presence** (for server-rendered views, count views that render the entity's fields or take it as a model attribute, not views that merely name it); git change frequency; a status or lifecycle field. **Dead model:** an entity no code path creates, reads or changes stays off the map, however central its name. So do views no controller returns.
4. **Shortlist** 10–15 with evidence. **Choose ≤ 6**, merging entities that are one idea for the user. Prefer those in the frontend **and** with services **and** a lifecycle.
   - **Stages or variants of one idea share one card** (prospect → customer; guest vs. registered buyer). Name it after the idea or both sides ("Lead & Client") and spell out the difference under "Not to be confused with".
   - Only **independent** concepts (different identity and lifecycle, neither turning into the other) get separate cards. A sixth is a reason to revisit the limit, not to exceed it.
5. Use the docs as evidence: they often state the domain model outright.

**Always include:** the **tenant or owner concept** if the system is multi-tenant. Include **look-alike groups** when ≥ 2 entities overlap in plain meaning (customer / client / lead / user / account), separated under "Not to be confused with" (`OrgAccount` pays the platform, `Student` pays the school, `Prospect` might pay later). When a code name misleads (`Ticket` meaning *a paid seat in a class*), the plain name follows the meaning.

**Card fields:**

| Field | How to find it | Rule |
|---|---|---|
| Plain name · code names | Docs, UI labels, i18n | Plain name first |
| What it is | Docs and UI | One sentence, real-world meaning |
| Not to be confused with | Look-alikes, name mismatches | **Only where confusion is likely**, else omit. Test: would a developer reading the code plausibly use the wrong one, or misread the name? Merely related or self-explanatory differences do not qualify. ≤ 2 entries |
| Lifecycle | **First `facts.md` → Lifecycles, computed:** every method setting each status (conditional updates vs. plain sets); then creation sites (`new`, builders, `save`, `findOrCreate`), status enums, every `setStatus(X)`, jobs that expire, clean up or delete. A SQL dump, migration or seed file holding schema or valid values is the source, and is **not** demoted as data | Each state change cited at its line |
| Relations | Foreign keys and associations between **core** concepts, **plus runtime conversions** (a session cart saved as an order) | Each cited, short label, on one card only (the side holding the reference or doing the conversion). May be none |
| Fields that matter | Status, tenant key, links, money, external IDs | 2–4 |
| Its rule | An invariant the code enforces (scoping, locking, validation) | Optional; cited |
| Where it lives | Entity · table · API path · frontend type or page | One line |

**Core sentence:** one sentence linking **every** concept in dependency order (what must exist before what), in the verbs of the actual relations. Where one concept turns into another (cart → order), follow that conversion; it is still dependency, not a user's journey. Mark each concept `[[id|text]]`.

**Checks:** Is any concept a technical artifact or a collapsed-family member? If so, it is wrong. Does every look-alike group have a "Not to be confused with", each entry passing the test and absent elsewhere? Does every lifecycle step cite its line? Does the core sentence name every concept, and only them, in dependency order, about how the *things* relate?

## 3.4 Regions

**Goal:** every feature the reader asks about has a home in their head, and they know where the code for it lives.
**Where to look:** top-level packages and modules; frontend app folders and route groups; controller base paths; entities per package; git activity per path.

1. Start from the codebase's own feature boundaries (feature packages, apps, modules).
2. **Layer-organized code** (`controller/ service/ repository/ entity/` at the top): group controllers by URL prefix and by the entities they use, merging groups that serve one capability. A region's `codeName` lists the layer folders it spans. Entities and repositories no capability owns (lookup tables, base classes) go to Shared infrastructure. A controller mixing capabilities goes to its main purpose's region; its stray endpoints are named in that region's parts.
3. **Shared packages** (`common/`, `core/`, `shared/`): carve out a region for any part that is a *capability* with its own concepts or external system (accounts and tenancy, payments). The remaining plumbing (security, email, storage, translations, API client) becomes **one "Shared infrastructure" card, always last**.
4. **At most 7 regions + Shared infrastructure** (8 is a ceiling, not a target). Fewer, fuller regions beat thin ones: a region of a screen or two merges into the nearest region serving the same actor. In small apps, staff-only screens usually form **one** back-office region. Never split one capability across regions.
5. **Each region spans tiers:** frontend pages and backend code together. Never a "Frontend" or "Backend" region.

**Order:** along the main actor's journey.

**Region sentence:** one sentence on **how the code is organized**: the deployable pieces, which regions have their own packages or apps, which live in shared code. It must not repeat the core sentence. *Test:* swap each region name for its folder name; the sentence must still be true.

**Card fields:**
- **Name** (domain words), **codeName** (real backend and frontend folders), **Role** (one line).
- **Text:** 2–4 sentences on what is *in the code*. Never restate concept lifecycles.
- **Owns:** the core concepts the region is primarily about. Each concept has one owner: the region where users meet it most. Regions that create or change it say so in their parts.
- **Parts:** ≤ 7 real sub-areas, one line and one cite each.
- **Paths and activity:** list `paths`. With git history, the validator computes the badge from them: commits touching those paths out of all commits in the window, rename-aware (`git log -M --name-status`). *Changes often* (≥ 25%), *rarely* (< 10%), otherwise *sometimes*.
  - **Window:** the 6 months before the analyzed commit. With **fewer than 20 commits** in it, use the last 50 commits (or all, if fewer) and record that in `since`. Under 10 commits: omit activity.

**Checks:** Does every feature-level controller and frontend app belong to exactly one region? Is any region a technical layer? Does the region sentence describe folders, not a journey? Does any card repeat a concept card?

## 3.5 State & source of truth

**Goal:** for each core concept, which copy is the truth and which code may change it.
**Where to look:** `facts.md` → State (repository writes per entity, grouped by file; `@Modifying` queries); session state; frontend query cache and local storage (for region parts).

**One part: owners, one row per core concept.**
1. **Truth:** where the authoritative value lives, usually "the database". Say more only when it differs: an outside system wins on conflict (the payment provider for payment status); part is derived and never stored; or a value is copied and frozen (a price copied into an order), in which case add that editing the source later does not change the copy.
2. **Written by:** the region and file making the normal changes, and the method or rule every change passes (a state-transition method, a check, a version row). Cite it.
3. **Other writers:** every other region or job that changes it (from the scanner's write list), cited. With at least one, mark the row **shared write** and say whether they go through the same rule. A data import or seeding tool is named once, in the intro.

**Everything else goes elsewhere:**
- A **copy that can go stale** (cache, resolution table, client cache, mirrored value) is a **region part** (3.4) with its exact TTL or refresh trigger, cited.
- A **value copied and frozen** is a sentence in the **Truth** cell, and may go on the concept card (3.3) in an existing field (`what`, `keyFields`, `lifecycle`).
- A **step that can half-succeed** (an outside call in a transaction, a webhook or job finishing later) is a `careful` caution on the story step (3.9). Start from `facts.md` → Transaction boundaries, computed.
- A **design smell with a repair path but no obligation** (an `@Async` processor enqueued in a transaction) is an observation in `mindmodel/.work/findings.md`.

**Not here:** field lists, DTO mappings, every table. Traps in data shape across tiers (money as cents, times in UTC) are rules (3.8).

**Checks:** One owner row per core concept? Every other writer on its row, or deliberately left off as a seeding or import tool? Only the owners table in the section?

## 3.6 How a request travels

**Goal:** the machinery every request goes through: where it can be stopped, whose tenant or user it belongs to, and why queries look the way they do.
**Where to look (configuration, not a feature):** the frontend API client (fetch wrapper, auth header, base URL); security configuration (filter chains, path matchers, auth, method security); filters and interceptors in registration order; tenant or user resolution; controller and data-access conventions.

**Procedure:** follow **one real call** from the frontend call site to the database and back, reading the configuration at each hop. Check each step holds for **all** API calls. Where it holds for only some, name them ("`/api/admin/**` requires a JWT").

- ≤ 7 steps. Lanes are the systems involved (typically browser, backend, database); an external is a lane only if every request touches it.
- Each step: a diagram label (≤ 56 chars), its region, 1–2 sentences, citations.
- Security steps state **exactly** what the configuration does: which paths require what, and what is open (P6).
- A **framework default** (no config sets it, e.g. CSRF on by default) is marked "framework default", citing the configuration that leaves it in place.

**Checks:** Is any step feature-specific? Is the order the real runtime order? Does the security step match the configuration line for line?

## 3.7 What runs on its own

**Goal:** everything that happens with no request, and the one property they share.
**Where to look:** `facts.md` → Schedules and retries, computed (timing in plain words, time windows per job); `@Scheduled`, cron, timers; `@Async`; event listeners; message consumers (`@KafkaListener`, `@RabbitListener`, `@JmsListener`); webhooks whose work continues after the response; queue or outbox workers; startup runners; **real-time socket handlers** (`@MessageMapping`, connect and disconnect listeners). Socket handlers belong here although clients send their messages: they run off the request path and often push to *other* users.

- **Intro:** the shared rule, usually *no request, so no request-scoped context (tenant, user, transaction) unless the code sets it.* Cite where it is set manually. If nothing runs on its own, say so.
- **Table**, ≤ 10 rows, grouped by purpose: name · when (human terms: "every 20 s", "hourly", "nightly 03:00"; a socket handler's "on each message" or "on disconnect") · what it does, 1–2 sentences · region · citations to each scheduler or worker. Say in a row when an item causes a user-visible delay ("paid" arrives after the redirect).
- **A selection, not an inventory.** Never say a handler does not exist because it is missing from the table. The digest's count is the only total.

**Checks:** Does every row describe work that runs with no request? Is every schedule copied exactly from the code or config? When the digest's total exceeds your rows, does the intro or a row say what the rest is?

## 3.8 Rules

**Goal:** the reader never makes the mistakes that matter most.

**Candidates:** doc statements ("always", "never", "must"); conventions the code enforces (base classes, mandatory scoping, locks, idempotency checks); code that departs from framework defaults or from what its names suggest; async boundaries; money handling; "touch X, also change Y" couplings; **whatever you got wrong while tracing the stories**; paths the security layer excludes (`facts.authExclusions`, from `sureness.yml` or Spring Security), which an authentication rule must name.

**Qualify:** non-obvious **and** consequential **and** verifiable in code, stated with its condition (P10a). Not code smells or style guides (unless breaking them causes real damage), not doc mismatches (P4). Flawed behavior a developer must know (e.g. "the charged price comes from the browser") qualifies, stated as behavior, never as a vulnerability or exploit (P6).

**Not rules:** a surprise that changes nothing a developer must do goes to `findings.md` under *observations*, one line with a cite. A probable defect (the digest's *Security warnings, computed*: prefixes that allow anonymous access, or writes with no method-level check) is stated neutrally with its condition ("`/api/shop/**` is anonymous, so `ProductController#create` needs no token") and the gap goes to `findings.md`. Never write "always check the tenant": that describes missing code, not the code.

**Rank by reach × damage:**

| Reach | |
|---|---|
| High | every request, every query, or every change to the data model |
| Medium | one kind of work across the system (e.g. all money handling), or a whole region |
| Low | one feature or one flow |

| Damage | |
|---|---|
| Severe | data leak between tenants or users (including reading the tenant from the wrong place); money lost or wrongly charged |
| High | data corruption; a whole feature or flow broken for all users (e.g. onboarding, a form that always fails) |
| Medium | a user-visible bug in one feature |
| Low | confusion and wasted debugging time |

**Order:** by reach, then damage; if still tied, the rule a developer acts on more often comes first (daily query writing before request routing). ≤ 5 items.
*Example ranking:* filter every query by `tenant_id` (High, Severe) → every schema change needs a migration file (High, High) → refunds take a separate code path from payments (Medium, Severe) → search results are cached for 5 minutes (Low, Low).

**Write:** title (imperative or declarative) · **importance line** naming reach and damage · 2–4 sentences on the obligation and its consequence · citations.

**Checks:** Would a competent newcomer get this wrong reading the code naively? Does the importance line justify the rank against its neighbors?

## 3.9 Stories

**Goal:** the main flows, run end to end through real code, tying concepts, regions and the request path together.

**Start from `facts.md` → Flow skeletons, computed:** each state-changing entry point with its ordered effects, ranked by how much core it touches. Read the rank's parts: entry kind, entities written, frontend call sites, and whether it writes a lifecycle entity. Flows that write only supporting rows (a token, a queued email, a join row) rank below flows that move a core object. Open only the methods a step needs.

**A `(conditional)` effect may not happen.** It sits in an `if`/`else`/`switch` arm or a `catch`: a default signup calls Stripe only when the trial flag is off. Never write it as always running. Give its condition in the step ("when `startTrial` is false, …"), or leave it out. Never promote it to the main path.

**Choose.** For each **primary actor**, take the flows that deliver what they come for: value created, money moved, or the core entity created. Always consider **how the tenant or customer comes to exist** (signup or onboarding), and **the failure path of the top flow**: retries, idempotency, cleanup, or, if failures are swallowed, that the flow carries on as if it succeeded.

**Qualify.** A story runs through **the absolute core**. All must hold:
- it delivers what a primary actor comes for, or creates the core entity everything depends on;
- it creates or changes at least one core concept;
- it happens routinely (a once-per-staff setup, a niche feature or a side channel like chat does not qualify unless it is the product);
- a newcomer would be lost without it.
A failure path qualifies only if its outcome changes core state in a way the developer must know (a failed payment still saving the order as paid).

**Rank** by **centrality × breadth** (how central the flow is, times how many regions and concepts it runs through). **3–5 stories, most important first.** The first delivers the core value (what a customer comes for), never a queue consumer or scheduled job. The rest run from what most people do to what fewest do, with a failure path directly after its flow. Never pad: with fewer than three entry flows, say so in the first line.

**Trace:** (1) the frontend page or component the user acts on, citing the call site; (2) the backend endpoint, matched by method and path, citing both sides; (3) service calls, each core state change with its line; (4) external calls and their **asynchronous continuations** (webhooks, jobs, queues) into their handlers; (5) notifications (email, calendar); (6) a user-visible end state.

**Trace the real path, flaws included (P6).** If the code charges twice, ignores a failure or trusts a browser value, say so neutrally in that step. Describe what the code *does*. A suspected runtime failure you cannot confirm by reading goes to the owner, not into the story.

**Write:**
- One **persona**, reused across stories, with values **valid in the code** (a real price type, duration or status), cited.
- ≤ 10 steps, about 250–500 words. Each step: region, 1–3 sentences, citations.
- **`careful` (optional, ≤ 2 per story):** only on a step that leaves something a rollback cannot undo (an outside call made, a job or event enqueued, a message published). Say what stays done if a later step fails, and **name the repair path**: automatic (retry, reconciler, cleanup job), an endpoint a person can call, or plainly *nothing*. One sentence, about 200 characters (hard cap 220), shown under the step as "Note:". Never on a step that leaves nothing behind.
- **Importance line:** why it ranks here. **Takeaways:** 1–3 lines tying it to concepts, regions and rules.
- Only the map's plain names. Never introduce a new concept name inside a story.

**Never** write change stories ("you're asked to add a field…"): they teach a task, not the system. Never invent behavior: an untraceable step is marked `inferred: true` or removed. Never invent a flow to cover a region; regions no story runs through go to the critic.

**Checks:** Does every step cite code that does what it says? Do the values exist in the code? Does the top flow deliver the core value? Does each `careful` sit on a step that leaves something behind, and name its repair?

---

## Part 6. When the repo is shaped differently

| Situation | What changes |
|---|---|
| **Layer-organized code** (`controller/ service/ repo/ entity/`) | Regions come from grouping controllers by URL prefix and entities (3.4 step 2). The region sentence says the code is split by layer. |
| **Server-rendered views** (JSP, Thymeleaf) | Views are the frontend. Story steps start at the view's form or link. The request path starts at the browser's submit (filters run first) and ends with the view rendering HTML. |
| **No frontend** (API only) | Regions are backend-only. The request path starts at the API client or gateway. |
| **Single-tenant** | No tenant concept or rule. The context step becomes user or session resolution. |
| **No git history** | No activity badges. Regions stay in journey order. |
| **Dormant repo** (few recent commits) | Activity uses the last 50 commits. Under 10 commits in total: no badges (3.4). |
| **Uncommitted changes** | Map the working tree as it is on disk. `project.commit` = short HEAD hash + "+ local changes". |
| **No project docs** | Purpose and vocabulary come from UI text, i18n files and entity names. Non-goals are omitted (3.1). |
| **Nothing runs on its own** | The background intro says so (3.7). |
| **Concept relations branch or loop** | A concept map may replace the core sentence (P7). The cards stay. |

---

## How security works (S4)

Write a `security` section only from `facts.securityModel` and `facts.methodSecurity`. It states the model as knowledge: which path prefixes are public, which need a login, which need a role, where the user and tenant come from (quote `facts.tenancy`), and what a developer adding an endpoint in each prefix must do.

- Knowledge, not weakness: never name a vulnerability or how to exploit one. A gap goes to `findings.md`. Where the developer must know, state it flatly ("endpoints under `/api/shop/**` are public: each must protect itself"), with no detail.
- Every claim cites code: the prefix's rule or a handler's annotation. A claim without a citation is not written.
