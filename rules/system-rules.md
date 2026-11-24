# mindmodel: system generation rules (draft)

**What this is:** the instructions for producing a **system mindmodel**: one page with what a developer must carry in their head to work in a system of many services. The single-app rules (`core.md` principles; per-section rules in `sections.md`) still apply inside each service; this page is about what happens **between** them.
**Status:** 0.2. Examples use an invented order platform ("Shopline"); they illustrate, they are not templates.

---

## Part 1. Principles

All single-app principles hold (essence not coverage, no filler, every claim cited, the code wins, plain names first, state behavior never exploits, words first, budgets are limits, rank don't list, exact numbers). Three more, specific to systems:

**S1. Between, not inside.** The page explains what crosses service boundaries: ownership, messages, calls, failures. What a service does internally belongs on its own map; link to it instead.

**S2. A map, not a catalog.** Name only the contracts everything depends on. Every topic, queue and endpoint is in `system.json`; the page carries the few a developer must know by heart.

**S3. Proven edges only.** A connection appears only if it is proven: by the system scan (a send matched to a listener, a call matched to a service) or by a cited line of code. The strip and the talks table show scan-proven edges only; an edge proven only by reading goes in contracts and flows, cited, and is reported as a scanner gap. Unresolved names are reported as unresolved, never guessed.

| Section | The one question it answers |
|---|---|
| Overview | What does the platform do, and how does business flow through it, in one breath? |
| Domains & services | What exists, where are the boundaries, and what matters most? |
| Who owns what | Which service is the truth for each core concept, and where are its copies? |
| How it talks | Who calls whom and who listens to what, and which few contracts carry the system? |
| Main flows | How do the key business flows run across services, hop by hop? |
| When a hop fails | What happens when the other side is down, slow, or a message comes twice? |
| System rules | What must every service do? |

---

## Part 2. Process

| Phase | What | Output |
|---|---|---|
| 1 | **System scan** (deterministic): find services and shared libraries, scan each, extract REST/Kafka/JMS edges, resolve names from config, join | `system.md` digest + `system.json` |
| 2 | **Rank services**: dependence (callers + consumers of what it produces), data ownership, position on flows, money, change activity | core / supporting / peripheral |
| 3 | Domains & services (3.2) | grouped, ranked services |
| 4 | Who owns what (3.3) | owners and copies |
| 5 | How it talks (3.4) | domain order + key contracts |
| 6 | Main flows (3.5), then When a hop fails (3.6) | flows, failure table |
| 7 | System rules (3.7) | ranked rules |
| 8 | Overview (3.1), written last | purpose + system sentence |
| 9 | Critique, verify citations, check budgets | final `system.json` map |

**Focus:** when the user names focus services, they get full detail whatever their rank; their direct neighbours get cards; the rest one line or nothing.

---

## Part 3. Section rules

### 3.1 Overview
- **Purpose (1 sentence):** what the platform does for whom, without listing services.
- **System sentence (1):** how business flows through the **domains**, in order, with the verbs of the real handoffs. *Example:* "An order is accepted by Ordering, paid through Payments, reserved by Inventory and shipped by Fulfilment; every step announces itself on Kafka." If you cannot write it, the domains are wrong.
- **Shape (1 line):** how many services, which brokers (Kafka, JMS broker), gateway, shared libraries.

### 3.2 Domains & services
- **Group services into ≤ 7 domains** (bounded contexts), named in business words. Infrastructure services (config, discovery, admin, tracing) form one "Platform" group. The **gateway** is the entry: if it only routes, it belongs in Platform; if it composes or decides (aggregates calls, applies business rules), it is a core service in its own "Edge" domain, first in order. In Edge, it is the first box of the strip.
- **Rank** within the page: core (≤ 8, full card) → supporting (one line each) → peripheral (grouped in one line).
- **Core card:** one-line responsibility (what it decides, not what it contains) · the concepts it owns · a one-line `importance` (why it is core: "9 services consume its events; on every checkout") · link to its own mindmodel if present.
- **Checks:** Does every service belong to exactly one domain? Is any responsibility line a list of features? Is the ranking backed by the scan's dependence numbers?

### 3.3 Who owns what (most important)
- **One row per core business concept:** owning service (the source of truth, where it is written) · every **copy** in another service and how it is fed (topic, call, batch) · how stale a copy can be (event lag, cache TTL, nightly job).
- Flag **shared write** when two services write the same concept, and **dual write** when a service writes its database and publishes a message (or calls another service) without an outbox: that is the classic consistency hole.
- **Checks:** Does each core concept have exactly one owner? Is every copy's feed cited on both sides?

### 3.4 How it talks
- **Both pictures are computed by the renderer from the scan, never drawn by the writer.** The writer only chooses each service's domain and tier and the order of the domains. It must read at a glance: **never a hairball.**
  - **The strip:** the non-platform domains as boxes, in the order business flows through them (the system sentence's order), with arrows only between neighbours, so it cannot tangle. More than 4 domains wrap onto a second row. Each box lists its core and supporting services; the hub (the service talking to the most other domains) is bold.
  - **The talks table:** one row per service, platform plumbing (config, discovery, admin, tracing) left out. REST: who calls it and whom it calls. Messages: what it publishes and who listens, what it listens to and who sends. A channel a service only sends to itself says "itself".
  - **Brokers are not boxes.** Kafka and the JMS broker are implied by the channel kind; drawing them as hubs hides who talks to whom.
- **Key contracts (≤ 8):** the few messages and APIs the whole system depends on (change one and several services break); shown when the system has more than 5 services, since smaller systems fit in the table. The events, queues and APIs each with producer → consumers and what the payload carries, in one line. *Example:* "`OrderPlaced` (Ordering → Payments, Inventory, Notifications): order id, customer, lines, total."
- **Unresolved:** the renderer lists the channel and host names the scan could not resolve under the table, so nobody trusts a missing edge.

### 3.5 Main flows
- **1–4 cross-service flows**, ranked by centrality × breadth, each ≤ 10 hops. Every hop: from → to, **sync or async**, what crosses, cited on both sides.
- **Replies and compensations are hops too:** a saga step's reply back to the coordinator is its own async hop, and so is every undo step when a later step fails. A flow without its replies reads like broadcasting.
- Start from the scan's channels and calls; open code only to explain a hop.

### 3.6 When a hop fails
- **One row per important hop** (≤ 8): what happens if the other side is down, slow, or a message arrives twice or out of order. Mechanisms: retries (count, backoff), timeouts, circuit breaker, idempotency key, dead-letter queue, outbox, reconciliation job, compensation, **or nothing** (say it plainly).
- Rank by damage: money and core data first.

### 3.7 System rules (≤ 5, ranked)

Not for this section: anything that behaves oddly but asks nothing of the reader. Those go to `findings.md` (owner-only) under *observations*, with a citation; they may mature into rules once their consequence is known.
- Conventions every service must follow (auth/tenant propagation, correlation IDs, event naming and versioning, idempotent consumers) and traps (a header JMS listeners never receive, a topic two teams use differently, a library version that changes serialization).
- Each with an importance line (reach × damage), as in single-app rules.

---

## Part 4. Size budgets

| Element | Budget (a ceiling) |
|---|---|
| Domains | ≤ 7 (+ Platform) |
| Core service cards | ≤ 8 |
| Owner rows | 1 per core concept, ≤ 8 |
| Key contracts | ≤ 8 |
| Flows | 1–4, ≤ 10 hops each |
| Failure rows | ≤ 8 |
| Rules | ≤ 5 |
| Diagrams | the domain strip (computed) + one sequence per flow |
| Words, whole page except flows | ≤ 3,000 |
