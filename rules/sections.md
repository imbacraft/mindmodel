# mindmodel: section rules

Part 3, plus Part 6 and the two notes that follow it. `rules/core.md` holds the principles (Part 1), the process (Part 2),
the critic's checklist (Part 4), the cut order (Part 5) and the size budgets (Part 7): read it every run. Here, read
**only** the section you are drafting.

---

## Part 3. Section rules

### Tenancy

- The digest's **Tenancy** section is the whole story of the tenant key: the key, its counts (entities carrying it,
  repository reads filtering by it), which entities lack it, reads that skip it, code without a request. Say "inferred"
  where it says inferred; a key the engine did not choose is `null` — a finding, not a gap to fill by guessing a field
  name.
- "Scoped by X" is true only when the fact says so. An entity listed under "without it" is unscoped in every read unless
  the code checks the tenant elsewhere: cite that check, or say it is missing and put it in `findings.md`.
- A job, listener, async method or worker reaching a keyed repository with the tenant context **not set** is a probable
  defect: neutral warning on the page, full evidence in the findings.

## 3.1 Overview

**Goal:** in one breath the reader knows who the system serves, what they get, and what it will never be.

**Where to look:** the first paragraph of README / CLAUDE.md / AGENTS.md; the landing or marketing text (often in a
frontend app or i18n file); plan/tier definitions; pricing enums.

**Write:**
- **Purpose sentence (1):** *who* + *what they get* + *how value or money moves*. No feature list, no tech stack; say so
  here if the project is a demo, exercise or simulation.
  *Example:* "Coursely lets schools sell online courses to students and run their classes, with tuition paid through a
  payment provider straight to each school."
- **Metaphor (optional, 1–2 sentences):** only if it compresses the structure truthfully (tenancy as "a building that
  rents out classrooms"); drop it if it needs a caveat.
- **Non-goals (1–2 sentences):** only what the project **states** it will never do ("never build", "out of scope",
  "non-goals", an ADR). Never infer them from missing code; nothing stated, omit the field.

- **Boot (where it starts and how to run it):** needed before anything else can be checked in an IDE.
  - **Entry points:** one per deployable — backend `main` (`facts.md` → Boot), frontend root (`index.html` → `main.tsx`)
    — with the dev port and any API proxy from the bundler config.
  - **Run locally (≤ 3 steps):** the one way to start the **whole app**; if one command does it (the backend build also
    serves the frontend), give only that. More steps only when the app cannot run without them; frontend dev servers and
    conveniences stay out. Sources: README, compose file, build file, `package.json` scripts, and the names (never
    values) of env vars without which it will not start. Nothing stated or derivable: omit, and never guess a command.
  - **Copy `facts.md` → Boot, computed** (run command, profile, port, profile file in git, whether the backend builds the
    frontend, required settings); open files only if a line looks wrong, and derive it by hand if the section is missing
    or incomplete.
  - **Trace the run command to its profile** (build-file run config such as `bootRun` args or the Spring Boot plugin's
    `profiles`, `-Dspring.profiles.active`, the env). Name it in the run note; take ports and required settings from
    **its** config file, citing the line that sets them, not the main class. Not in git (check the ignore file): say the
    developer must create it. Conditional beans and flags are not listed here; one that would genuinely surprise a
    developer competes for a Rules slot (3.8).

**Checks:** Could someone outside software understand the purpose sentence — does it name the user and the value? Is
every non-goal backed by a stated source? Does every entry point cite the line that defines it, and every run step come
from a file in the repo?

### 3.2 People & outside systems

**Goal:** the reader knows the people the system serves, most important first, and every outside system it calls at
runtime.

**Find the people by what they do, not only by login.** A kind of person counts if any of these holds (cite it):
- they **pay** (checkout, subscriptions, invoices: who the money comes from);
- they **sign in** (security roles, `hasRole`, login flows, user-type entities);
- they **get a private link or token** (booking, order or reading links, client portals: endpoints with `{token}`);
- they **receive emails** (who the email templates and send calls address);
- they **act through their own part of the frontend** or URL zone (admin panel, public site, portal, `/api/admin`).

Kinds differing only by permission level (OWNER vs EDITOR) are one actor, the difference said in a few words; distinct
goals or a distinct way of being identified make separate actors (≤ 7).

**Order people by importance:** (1) who pays the business, the primary customer; (2) the people they serve through it
(visitors, clients, bookers, leads); (3) staff and operators last. Within a group, the one more of the code serves comes
first. Give each a one-line `importance`: why it ranks there.

**Outside systems:** the systems the code **calls at runtime** (≤ 7), by importance: money and data first (payment,
database), then what core flows depend on (email, AI, storage, calendar), helpers last (CAPTCHA, geocoding). Libraries
and build tools are not externals. Look in SDK dependencies, outbound HTTP clients and their base URLs, config keys
naming outside services, the database driver, compose services.

**Actor or concept?** A kind of person is an **actor**; they become a **core concept** only if the business is about them
(the customer whose orders, bookings or account the system manages). Staff and admin accounts stay actors, even with
their own tables and CRUD screens.

**Write:** one line each — what they do / what it is used for, cited where the code uses it. One external playing two
roles says so (a payment provider used both for the platform's own subscription billing and for customers paying the
tenants).

**Checks:** Did every way of paying, signing in, getting a link or receiving an email lead to an actor? Is the primary
customer first and staff last? Is every external cited at a usage site, not just the dependency file? Is anything listed
that the code never calls?

### 3.3 Core concepts (most important; take the most care)

**Goal:** the reader learns the ≤ 6 things everything else is about, can tell look-alikes apart, and knows how they depend
on each other. Every later section is told in these names.

**What a concept is:** something the users or the business talk about, with an identity and a lifecycle. It may span
several entities (Organization account = `OrgAccount` + `OrgUser`); never a technical artifact (log, token, settings row,
DTO).

**Funnel:**
1. **Candidates:** every persistent entity (`@Entity`, tables, ORM models) and the frontend types mirroring them; plus
   **non-persistent state that users name** (session attributes, cached objects, in-memory structures with a lifecycle — a
   shopping cart in the HTTP session), which the funnel would otherwise never find.
2. **Collapse families before ranking.** Entities sharing a naming pattern or role (`*Settings`, `*Log`, `*Event`,
   `*Token`, join and lookup tables, base classes) become one chunk or are demoted as infrastructure; a family of 20+
   `*Settings` entities would otherwise crowd the ranking. **Exception:** a line-item or detail entity inside another
   concept (order line, edition of a product) folds into that concept.
3. **Score** each remaining candidate on: links from other entities (fan-in); references from services and controllers;
   **presence in the frontend** (users' view vs. platform internals — for server-rendered views, count those rendering the
   entity's fields or taking it as a model attribute, not those merely naming it); git change frequency; a status or
   lifecycle field.

   **Dead model:** an entity no code path creates, reads or changes (no repository, controller or service reference)
   stays off the map, however central its name; likewise views no controller returns.
4. **Shortlist** 10–15 with their evidence.
5. **Choose ≤ 6**, merging entities that are one idea for the user; prefer those in the frontend **and** with services
   **and** a lifecycle.
   - **Stages or variants of one idea share one card** (a prospect who becomes a customer; a guest buyer vs. a registered
     one): name it after the idea or both sides ("Lead & Client") and spell out the difference in "Not to be confused
     with". Chunking, not compromise: the count stays at ≤ 6 without losing the distinction.
   - Only **independent** concepts (different identity, different lifecycle, neither turning into the other) need
     separate cards; a genuine need for a sixth is evidence to revisit the limit, not to exceed it.
6. **Use the docs as evidence:** they often state the domain model outright (e.g. the tenancy model).

**Always include:** **the tenant or owner concept** if the system is multi-tenant (everything hangs off it); and
**look-alike groups** — when ≥ 2 entities have overlapping plain meanings (customer / client / lead / user / account), the
cards separate them in "Not to be confused with" (`OrgAccount` pays the platform, `Student` pays the school, `Prospect`
might pay later).

**Name mismatches:** if the code name misleads (an entity `Ticket` that means *a paid seat in a class*), the plain name
follows the meaning and "Not to be confused with" explains the mismatch.

**Card fields:**

| Field | How to find it | Rule |
|---|---|---|
| Plain name · code names | Docs vocabulary, UI labels, i18n strings | Plain name first |
| What it is | Docs + how the UI presents it | One sentence, real-world meaning |
| Not to be confused with | Look-alike groups, name mismatches | **Only where confusion is likely**, else omit (most cards have none). Test: would a developer reading the code plausibly use the wrong one, or misread the name? A merely related concept, or a difference the card's text already makes clear, does not qualify. ≤ 2 entries |
| Lifecycle | **First `facts.md` → Lifecycles, computed:** every method that sets each status value (conditional updates vs plain sets), ready to cite; then creation sites (`new`, builders, `save`, `findOrCreate`), status enums, every `setStatus(X)`, jobs that expire, clean up or delete. Schema or valid values in a SQL dump, migration or seed file: that file is the source — cite it (it is **not** demoted as data) | Each state change cited at the line that makes it |
| Relations | Foreign keys / associations between **core** concepts only, **plus runtime conversions** (one concept becomes another, e.g. a session cart saved as an order) | Each cited; a short label; one card only (the side holding the reference or doing the conversion); a card may have none |
| Fields that matter | Status, tenant key, links to other concepts, money, external IDs | 2–4 |
| Its rule | An invariant the code enforces about this concept (scoping, locking, validation) | Optional; cited |
| Where it lives | Entity · table · API path · frontend type or page | One line |

**Core sentence:** one sentence linking **every** concept in dependency order (what must exist before what), using the
verbs of the actual relations; where one concept turns into another (cart → order), follow that conversion — still
dependency, not a user's journey. Mark each concept as `[[id|text]]`.
*Example:* "An organization runs one or more schools; each school offers courses; a student enrolls in a course; and every
paid enrollment produces an invoice."

**Checks:**
- Is any chosen concept a technical artifact, or a member of a collapsed family? → wrong.
- Does each look-alike group have a "Not to be confused with", every entry passing the likely-confusion test and absent
  everywhere else?
- Does every lifecycle step cite the line that performs it?
- Does the core sentence mention every concept, and only them, in dependency order, and speak of how the *things* relate
  (not a user's journey, not the code layout)?

### 3.4 Regions

**Goal:** every feature the reader is asked about has a home in their head, and they know how the code is laid out to find
it.

**Where to look:** top-level packages/modules; frontend app folders and route groups; controller base paths; which
entities each package uses; git activity per path; doc folder names.

**Derive the regions:**
1. **Start from the codebase's own feature boundaries** (feature packages, apps, modules).
2. **Layer-organized code** (`controller/ service/ repository/ entity/` at the top): group controllers by URL prefix and
   by the entities they use, merging groups that serve one capability; then give each region the services, repositories,
   entities and views it uses, and list the layer folders it spans in its codeName. Entities and repositories no single
   capability owns (lookup tables, base classes) go to Shared infrastructure.
   - **A controller that mixes capabilities** goes to the region of its main purpose; its stray endpoints are named in
     that region's parts.
3. **Shared packages** (`common/`, `core/`, `shared/`): carve out a region for any part that is a *capability* with its
   own concepts or external system (accounts & tenancy, payments). The remaining plumbing (security, email, storage,
   translations, API client layer) becomes **one "Shared infrastructure" card, always last**.
4. **At most 7 regions + Shared infrastructure** (8 in total is a ceiling, not a target). Fewer, fuller regions beat thin
   ones: a region that is only a screen or two (one controller and its forms) merges into the nearest region serving the
   same actor; in small apps, staff-only screens usually form **one** back-office region. Never split one capability
   across regions.
5. **Each region spans tiers**: its frontend pages and its backend code together. Never a "Frontend" or "Backend" region.

**Order:** along the main actor's journey through the product. *Example:* sign up → set up → sell → deliver → get paid →
support → shared infrastructure.

**Region sentence:** one sentence on **how the code is organized**: the deployable pieces, which regions have their own
packages/apps, which live in shared code. It must not repeat the core sentence. *Test:* swap each region name for its
folder name; the sentence must still be true about the folders.

**Card fields:**
- **Name** (domain words) and **codeName** (the real packages/folders, backend and frontend).
- **Role:** one line, what the region is responsible for.
- **Text:** 2–4 sentences on what is *in the code* here and how it is put together. Do **not** restate concept
  lifecycles; the concept cards own those.
- **Owns:** the core concepts this region is primarily about; each concept has exactly one owner region, the one where
  users meet it most. Other regions that create or change it say so in their parts.
- **Parts:** ≤ 7 real sub-areas, each one line with a citation.
- **Paths and activity:** list the region's `paths` (folders or files). The activity badge is **computed by the
  validator** from them (if git history exists): commits touching those paths out of all commits in the window, counted
  **rename-aware** (`git log -M --name-status`, mapping old paths to their current location). The page shows *changes
  often* (≥ 25%), *rarely* (< 10%), otherwise *sometimes*.
  - **Window:** the 6 months before the analyzed commit. **Fewer than 20 commits** in that window (a dormant repo): use
    the last 50 commits instead (or all, if fewer), recording the window in `since` (e.g. "last 50 commits"); under 10
    commits, omit activity, the badge would carry no signal.

**Checks:** Does every feature-level controller and frontend app belong to exactly one region? Is any region a technical
layer? Does the region sentence describe folders rather than a journey? Does any card's text repeat a concept card?

### 3.5 State & source of truth

**Goal:** the reader knows, for each core concept, which copy is the truth and which code may change it. Most real
mistakes happen here — changing a concept from the wrong place and skipping its rules. "What code can change this?" is one
of the hardest questions to answer by reading.

**Where to look:** `facts.md` → State (repository writes per entity grouped by file, `@Modifying` queries); session state;
the frontend's query cache and local storage, for the region parts below.

**Write one part: owners (one row per core concept):**

1. **Truth:** where the authoritative value lives. Usually "the database"; say more only when it differs: an outside
   system wins on conflict (the payment provider for payment status), part of it is derived and never stored, or it is
   copied into another row at a moment and then frozen (a price copied into an order) — then add the one clause that
   editing the source afterwards does not change the copy.
2. **Written by:** the region and file that make the normal changes, and the method or rule every change must pass (a
   state-transition method, a check, a version row). Cite it.
3. **Other writers:** every other region or job that changes it (from the scanner's write list), each cited. With at
   least one, mark the row **shared write** and say in a few words whether the other writers go through the same rule. A
   data import or seeding tool that writes everything is named once in the intro, not on every row.

**Where everything else goes.** The table is the whole section: truth and writers, nothing else. A copy or a half-done
step is stated where the reader meets it, never as a subsection here:

- **A copy that can go stale** — a cache, a resolution table, a client cache, a mirrored value — is a **region part**
  (3.4): inside the region that owns the cache, one line with the exact TTL or refresh trigger, cited.
- **A value copied once and then frozen** is a sentence in the **Truth** cell (step 1), and may also appear on the
  concept card (3.3) in an existing text field (`what`, `keyFields`, `lifecycle`) — no new field.
- **A step that can half-succeed** (an outside call in a transaction, a webhook or job finishing the change later) is a
  `careful` caution on the story step that crosses the boundary (3.9). Start from `facts.md` → Transaction boundaries,
  computed: every seam it proves is either that caution somewhere or deliberately dismissed.
- **A design smell with a repair path but no obligation** (an `@Async` processor enqueued inside a transaction) is an
  observation in `mindmodel/.work/findings.md`, not a map field.

**Not here:** field lists, DTO mappings, every table. A trap in how data changes shape across tiers (money as cents, times
in UTC) is a rule (3.8), not a row here.

**Checks:** Does every core concept have exactly one owner row? Is every other writer from the scanner's list either on
its row or deliberately left off as a seeding/import tool? Does the section hold nothing but the owners table — no cache,
no copied value as a row, no half-done step?

### 3.6 How a request travels

**Goal:** the reader has a working model of the machinery every request goes through: where any request can be stopped,
which tenant/user it belongs to, and why queries look the way they do.

**Where to look (framework configuration, not a feature):** the frontend API client (fetch wrapper, auth header, base
URL); security configuration (filter chains, path matchers, auth mechanism, method security); filters and interceptors
with their registration order; tenant/user context resolution and its scope; controller conventions (base class, response
wrapper, error handler); service base classes; data-access conventions (scoping, transactions).

**Procedure:** follow **one real call** from the frontend call site to the database and back, reading the configuration at
each hop, then check every step holds for **all** API calls; where it holds only for some, name them ("`/api/admin/**`
requires a JWT").

**Write:**
- ≤ 7 steps; lanes = the systems involved (typically browser, backend, database; an external only if every request touches
  it).
- Each step: a short label for the diagram (≤ 56 chars), its region, 1–2 sentences, citations.
- Security steps state **exactly** what the configuration does: which paths require what, and what is open (P6).
- Behavior from a **framework default** (not written in any config, e.g. CSRF protection on by default) is stated as
  such — "framework default" — citing the configuration that leaves it in place.

**Checks:** Is any step feature-specific? Is the order the real runtime order (verify registration order, filter chain
order)? Does the security step match the configuration line for line?

### 3.7 What runs on its own

**Goal:** the reader knows everything that happens with no request, and the one property it all shares.

**Where to look:** `facts.md` → Schedules and retries, computed (timing in plain words, with each job's time windows);
`@Scheduled` / cron / timers; `@Async`; event listeners; message consumers (`@KafkaListener`, `@RabbitListener`,
`@JmsListener`, …); webhooks whose work continues after the response; queue or outbox workers (tables polled by a worker);
startup runners; **real-time socket handlers** (WebSocket/STOMP `@MessageMapping`, connect/disconnect listeners) — sent by
clients, but off the page/API request path and often pushing to *other* users, so they belong here, with "when" = "on each
message" or "on disconnect".

**Write:**
- **Intro:** the shared rule. Usually: *no request, so no request-scoped context (tenant, user, transaction) unless the
  code sets it*. Cite where it is set manually.
- **Table**, ≤ 10 rows, grouped by purpose (not one row per class): name · when (human terms: "every 20 s", "hourly",
  "nightly 03:00") · what it does, in one or two sentences · region · citations to each scheduler or worker.
- Say it in the row when an item explains user-visible delay ("paid" arrives after the redirect).
- If nothing runs on its own, say so in the intro: that is useful knowledge.
- **The table is a selection, not an inventory.** Never pad it with every handler, and never say a handler does not exist
  because it is not in your table; the digest's count is the only place the total is stated, for you to judge coverage.

**Checks:** Does every row describe work that really runs with no request? Is every schedule copied exactly from the code
or config? When the digest's total is larger than your rows, does the intro or a row tell the reader what the rest is?

### 3.8 Rules

**Goal:** the reader never makes the mistakes that matter most.

**Candidates come from:**
- Statements in the project's docs ("always", "never", "must").
- Conventions the code enforces: base classes, mandatory scoping, locks, idempotency checks.
- Places where the code differs from framework defaults or from what its names suggest.
- Asynchronous boundaries, where effects arrive later than they appear to.
- Money handling.
- Cross-cutting "touch X, also change Y" couplings.
- **Whatever you got wrong yourself while tracing the stories.**
- Paths the security layer excludes (`facts.authExclusions`, from `sureness.yml` or Spring Security): an authentication
  rule must say which paths skip it, never assume every request is checked.

**Qualify:** non-obvious **and** consequential **and** verifiable in code, stated with its condition (P10a). Not code
smells, not style guides (unless breaking them causes real damage), not doc mismatches (P4). Flawed behavior a developer
must know to work safely (e.g. "the charged price comes from the browser") qualifies, stated as behavior, never as a
vulnerability or an exploit (P6).

**A surprise is not a rule either.** Something unexpected that changes nothing a developer must do earns no slot: writing
it down forces the section to say "this is odd" instead of "this is what to do". Keep it in `findings.md`, under
*observations*, one line each with a citation; it may become a rule later, when it turns out to have a consequence.

**A probable defect is not a rule.** The digest's *Security warnings, computed* names prefixes that allow anonymous access
and expose writes with no method-level check. The map states the condition neutrally ("`/api/shop/**` is anonymous, so
`ProductController#create` needs no token") and the gap goes to `findings.md`; it never becomes a rule like "always check
the tenant", because that is the missing code, not the code.

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

**Order:** by reach (High > Medium > Low); within the same reach, by damage; if still tied, the one a developer acts on
more often first (writing queries daily beats reasoning about request routing). ≤ 5 items.

*Example ranking:* filter every query by `tenant_id` (High, Severe; acted on in every query) → every schema change needs a
migration file (High, High) → refunds take a separate code path from payments (Medium, Severe) → search results are
cached for 5 minutes (Low, Low).

**Write:** title (the rule itself, imperative or declarative) · **importance line** naming the reach and the damage · 2–4
sentences on the obligation and its consequence (what the developer must do; the mechanism may be shown elsewhere, so
don't re-explain it) · citations.
*Example:* #1 "Filter every query by `tenant_id`: touches every query; one missed filter shows one school's data to
another."

**Checks:** Would a competent newcomer get this wrong by reading the code naively? Does the importance line justify the
rank against its neighbors?

### 3.9 Stories

**Goal:** the reader sees the main flows run end to end through real code, tying concepts, regions and the request path
together.

**Start from `facts.md` → Flow skeletons, computed:** each state-changing entry point with what happens in order (outside
effects, saves, status changes, async hand-offs, after-commit work), ranked by how much of the core it touches. Read the
rank's parts: the entry kind, the entities written, how many distinct frontend call sites reach the endpoint, and whether
the flow writes an entity with a lifecycle — one that only writes supporting rows (a token, a queued email, a join row)
ranks below one that moves a core object. Pick and trace stories from these; open only the methods a step needs.

**An effect marked `(conditional)` may not happen.** It sits inside an `if`/`else`/`switch` arm or a `catch` on the traced
path, so the default path never reaches it — the default signup that calls Stripe only when the trial flag is off. Never
write a conditional effect as if it always runs: give its condition in that step ("when `startTrial` is false, …"), or
leave it out. It counts for less in the rank too, so never promote it to the main path to make a story read better.

**Choose the candidates:**
- For each **primary actor** (from People & outside systems), find the flows that deliver what they come for: where value
  is created, money moves, or the core entity is created. Look at entry points that write core concepts, external-payment
  calls and webhook handlers, and the product's main screens.
- Always consider **how the tenant/customer comes to exist** (signup or onboarding), and **the failure path of the top
  flow**: what actually happens when it fails (retries, idempotency, cleanup, or, if failures are swallowed, that the flow
  continues as if it succeeded).

**Qualify.** A story is on the map only if it runs through **the absolute core** of the app. All of these must hold:
- it delivers what a primary actor comes for, or creates the core entity everything else depends on;
- it creates or changes at least one core concept;
- it happens routinely in normal use, not rarely (a once-per-staff-member setup, a niche feature, or a side channel like
  chat does not qualify unless it is the product);
- a newcomer would be lost without it.

A failure path qualifies only if what happens on failure changes core state in a way the developer must know (e.g. a
failed payment still saving the order as paid).

**Rank** the qualifying stories by **centrality × breadth**: how central the flow is to what the product does, times how
many regions and concepts it runs through. **3–5 stories, always ranked, most important first.** The first delivers the
product's core value — the thing a customer comes for — not a queue consumer or a scheduled job; order the rest from what
most people do to what fewest do, with a failure path directly after its flow. Never pad: an app with fewer than three
entry flows says so in the section's first line and gives the ones it has.

**Trace, step by step:**
1. Start at the frontend page or component the user acts on; cite the call site.
2. Match the call to the backend endpoint by method and path; cite both sides.
3. Follow the service calls; record each state change of a core concept (cite the line).
4. Follow external calls and their **asynchronous continuations** (webhooks, jobs, queues) into the code that handles
   them.
5. Record notifications (email, calendar).
6. Stop at a user-visible end state.

**Trace the real path, flaws included (P6).** If the code charges twice, ignores a failure, or trusts a value from the
browser, the story says so, neutrally, in the step where it happens: a story that skips the inconvenient call teaches a
wrong model. Describe what the code *does*. Where you suspect a runtime failure you cannot confirm by reading, describe
the code's behavior, leave the prediction out, and report it to the owner.

**Write:**
- One **persona** reused across stories, with concrete values **valid in the code** (a price type that exists, a real
  duration, a real status); valid values may come from a SQL dump or seed file, cited.
- ≤ 10 steps, about 250–500 words. Each step: the region it happens in, 1–3 sentences, citations.
- **`careful` on a step (optional, at most 1–2 per story):** only where the step leaves something a rollback cannot undo
  — an outside call made, a job or event enqueued, a message published. Say what stays done if the later step fails and
  **name the repair path**: automatic (a retry, a reconciler, a cleanup job), an endpoint a person can call, or plainly
  *nothing*. One sentence, about 200 characters (hard cap 220), covered by that step's citations; it renders inline under
  the step as "Note:". Never its own section, never on a step that leaves nothing behind.
- **Importance line:** why it ranks here.
- **Takeaways:** 2–3 lines tying it back to concepts, regions and rules.
- Only the map's plain names; never introduce a new concept name inside a story.

**Never:** change stories ("you're asked to add a field…"), which teach a task, not the system; invented behavior — a step
you could not trace is marked `inferred: true` or removed.

**Report, don't force:** regions no story runs through are listed for the critic. Do not invent a flow to cover a region.

**Checks:** Does every step cite code that does what the step says? Do the values used exist in the code (enum values,
durations)? Does the top-ranked flow deliver the product's core value? Does each `careful` sit on a step that really
leaves something behind, and name how it is repaired?

---

## Part 6. When the repo is shaped differently

| Situation | What changes |
|---|---|
| **Layer-organized code** (`controller/ service/ repo/ entity/` at the top) | Regions come from grouping controllers by URL prefix and the entities they use (3.4 step 2). The region sentence says the code is split by layer, and how capabilities map onto it. |
| **Server-rendered views** (JSP, Thymeleaf) instead of an SPA | Views count as the frontend; story steps start at the view and its form or link. The request path still starts at the browser (the submit), since security filters run before the controller, and ends with the view rendering HTML. |
| **No frontend** (API only) | Regions are backend-only; the request path starts at the API client or gateway. |
| **Single-tenant** | No tenant concept or tenant rule; the request-path step for context resolution becomes user/session resolution. |
| **No git history** | No activity badges; regions are still ordered by journey. |
| **Dormant repo** (few recent commits) | Activity uses the last 50 commits instead of 6 months; under 10 commits in total, no badges (3.4). |
| **Uncommitted changes in the working tree** | Map the working tree as it is on disk (the code the developer will open). `project.commit` = short HEAD hash + "+ local changes". |
| **No project docs** | Purpose and vocabulary come from UI text, i18n files and entity names; non-goals are omitted (3.1). |
| **Nothing runs on its own** | The background section says so in its intro (3.7). |
| **Concept relations branch or loop** | A concept map may replace the core sentence (P7); the cards stay. |

---

## How security works (S4)

Write a `security` section only from `facts.securityModel` and `facts.methodSecurity`. It states the model as knowledge:
which path prefixes are public, which need a login, which need a role; where the user and the tenant come from (quote
`facts.tenancy`); and what a developer adding an endpoint in each prefix has to do, derived from how the existing endpoints
there are protected.

- Knowledge, not weakness: never name a vulnerability or how to exploit one; a gap goes to `findings.md`. Where the
  developer must know, say it flatly ("endpoints under `/api/shop/**` are public: each must protect itself"), no detail.
- Every claim cites code: the prefix's rule or a handler's annotation. A claim without a citation is not written.

## Facts are where to start, not the answer

- Every story step must be confirmed by reading the method it cites: the fact proves the call exists, only the code proves
  what it does.
- A "not found" fact (no setter, no listener, no channel) is a fact about the engine. Check the code before stating
  anything is absent, and write "no setter found by the engine", never "never set" or "never called".
