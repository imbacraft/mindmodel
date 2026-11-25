# mindmodel: system generation rules

**What:** rules for a **system mindmodel**: one page on what a developer must carry in their head to work across a set of services. Inside each service, the single-app rules apply (`core.md` Part 1). **Status:** 0.2. Examples use an invented order platform ("Shopline"); they illustrate only.

---

## Part 1. Principles

All single-app principles apply (`core.md` Part 1). Three more:

**S1. Between, not inside.** Explain what crosses service boundaries: ownership, messages, calls, failures. A service's internals belong on its own map; link to it.

**S2. A map, not a catalog.** Name only the contracts everything depends on. Every topic, queue and endpoint lives in `system.json`.

**S3. Proven edges only.** Show a connection only when the system scan proves it (a send matched to a listener, a call matched to a service) or a cited line proves it. The strip and talks table show scan-proven edges only. An edge proven only by reading goes in contracts and flows, cited, and is reported as a scanner gap. Unresolved names stay unresolved.

**Sections answer:** Overview (what the platform does, and how business flows through it) · Domains & services (what exists, what matters most) · Who owns what (the truth for each core concept, and its copies) · How it talks (who calls whom, which contracts carry the system) · Main flows (key business flows, hop by hop) · When a hop fails (what happens when a side is down, slow, or a message repeats) · System rules (what every service must do).

---

## Part 2. Process

Scan first: find services and shared libraries, scan each, extract REST, Kafka and JMS edges, resolve names from config (`system.md` + `system.json`). Then rank services by dependence (callers and consumers of what they produce), data ownership, position on flows, money and change activity: core, supporting or peripheral. Then write 3.2 to 3.7. Write 3.1 last. Finish with a critique, verified citations and budgets.

**Focus:** named focus services get full detail whatever their rank. Their direct neighbours get cards. The rest get one line or nothing.

---

## Part 3. Section rules

### 3.1 Overview
- **Purpose (1 sentence):** what the platform does for whom, without listing services.
- **System sentence (1):** how business flows through the **domains**, in order, using the verbs of the real handoffs. *Example:* "An order is accepted by Ordering, paid through Payments, reserved by Inventory and shipped by Fulfilment; every step announces itself on Kafka." If it cannot be written, the domains are wrong.
- **Shape (1 line):** service count, brokers (Kafka, JMS broker), gateway, shared libraries.

### 3.2 Domains & services
- **≤ 7 domains** (bounded contexts) in business words. Infrastructure (config, discovery, admin, tracing) forms one "Platform" group. The **gateway** belongs in Platform if it only routes. If it composes or decides (aggregates calls, applies business rules), it is a core service in its own "Edge" domain, first in order and first box of the strip.
- **Rank:** core (≤ 8, full card) → supporting (one line each) → peripheral (one grouped line).
- **Core card:** one-line responsibility (what it decides, not what it holds) · owned concepts · one-line `importance` backed by the scan's numbers (e.g. "9 services consume its events") · link to its own mindmodel, if any.
- **Checks:** Each service in exactly one domain? No responsibility line a feature list? Ranking backed by the scan's dependence numbers?

### 3.3 Who owns what (most important)
- **One row per core business concept:** the owning service (where it is written, the truth) · each **copy** in another service and its feed (topic, call, batch) · how stale a copy can be (event lag, cache TTL, nightly job).
- Flag **shared write** when two services write one concept. Flag **dual write** when a service writes its database and publishes a message or calls a service without an outbox: the classic consistency hole.
- **Checks:** One owner per core concept? Every copy's feed cited on both sides?

### 3.4 How it talks
- **The renderer computes both pictures from the scan. The writer never draws them.** The writer picks each service's domain and tier, and the domain order. Never a hairball.
  - **Strip:** non-platform domains as boxes, in business-flow order, with arrows only between neighbours. More than 4 domains wrap onto a second row. Each box lists its core and supporting services. The hub (the service talking to the most other domains) is bold.
  - **Talks table:** one row per service, platform plumbing (config, discovery, admin, tracing) left out. REST: who it calls and who calls it. Messages: what it publishes and who listens, what it listens to and who sends. A channel only sent to itself says "itself".
  - **Brokers are not boxes.** Kafka and the JMS broker are implied by the channel kind; drawn as hubs they hide who talks to whom.
- **Key contracts (≤ 8):** the few messages and APIs the system depends on (change one and several services break). Shown above 5 services. One line each: producer → consumers, and what the payload carries. *Example:* "`OrderPlaced` (Ordering → Payments, Inventory, Notifications): order id, customer, lines, total."
- **Unresolved:** the renderer lists channel and host names the scan could not resolve, under the table, so no one trusts a missing edge.

### 3.5 Main flows
- **1–4 cross-service flows**, ranked by centrality × breadth, each ≤ 10 hops. Each hop: from → to, **sync or async**, what crosses, cited on both sides.
- **Replies and compensations are hops too:** a saga step's reply, and each undo step after a later failure. Without them a flow reads like broadcasting.
- Start from the scan's channels and calls. Open code only to explain a hop.

### 3.6 When a hop fails
- **One row per important hop** (≤ 8): what happens when the other side is down or slow, or a message arrives twice or out of order. Mechanisms: retries (count, backoff), timeouts, circuit breaker, idempotency key, dead-letter queue, outbox, reconciliation job, compensation, **or nothing** (say so plainly).
- Rank by damage: money and core data first.

### 3.7 System rules (≤ 5, ranked)
- Conventions every service must follow (auth and tenant propagation, correlation IDs, event naming and versioning, idempotent consumers), and traps (a header JMS listeners never receive, a topic two teams use differently, a library version that changes serialization).
- Each rule has an importance line (reach × damage), as in single-app rules.
- Odd behavior that asks nothing of the reader is not a rule. It goes to `findings.md` under *observations* (owner-only), and may become a rule once its consequence is known.

---

## Part 4. Size budgets

| Element | Budget (a ceiling) |
|---|---|
| Domains | ≤ 8 (7 domains + Platform) |
| Core service cards | ≤ 8 |
| Owner rows | 1 per core concept, ≤ 8 |
| Key contracts | ≤ 8 |
| Flows | 1–4, ≤ 10 hops each |
| Failure rows | ≤ 8 |
| Rules | ≤ 5 |
| Diagrams | the domain strip (computed) + one sequence per flow |
| Words, whole page except flows | ≤ 3,000 |
