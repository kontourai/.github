# Kontour AI

**Make your agents show their work.** Kontour makes AI-assisted work inspectable
and accountable: sources stay traceable, claims keep their evidence, required paths
advance through explicit gates, and people can recompute why work is ready.

→ [kontourai.io](https://kontourai.io) tells the product story, and
[kontourai.github.io](https://kontourai.github.io/) indexes current documentation for
its listed products. The repositories below are the public implementation and
documentation surfaces.

## Applications

| Repository | Responsibility |
| --- | --- |
| [`station`](https://github.com/kontourai/station) | Open-source, local-first agent workspace: projects, agents, and devices in one place, with gates, evidence, and receipts beside the work ([station.kontourai.io](https://station.kontourai.io)) |
| [`fieldwork`](https://github.com/kontourai/fieldwork) | Turns documents into reviewed, source-grounded evidence you can recheck and export as a portable trust bundle |

## Products and foundational primitives

| Repository | Responsibility |
| --- | --- |
| [`flow-agents`](https://github.com/kontourai/flow-agents) | Portable workflow engine, runtime adapters, hooks, and first-party kits for evidence-gated agent work |
| [`veritas`](https://github.com/kontourai/veritas) | Executable repository standards and evidence-backed merge readiness for AI-authored code |
| [`surface`](https://github.com/kontourai/surface) | Kontour's integration surface for portable claims, evidence, trust status, validation, and product-facing Hachure compatibility |
| [`flow`](https://github.com/kontourai/flow) | Process definitions, steps, gates, evidence expectations, transitions, and explicit exceptions |
| [`survey`](https://github.com/kontourai/survey) | Producer-side source, extraction, candidate, review, decision, and publication records |
| [`console`](https://github.com/kontourai/console) | Suite operating plane: claim, process, proof, and queue state across the products, without owning their semantics |

The **Builder Kit** and **Knowledge Kit** are first-party solutions distributed
through Flow Agents rather than separate products.
[`aidlc-kit`](https://github.com/kontourai/aidlc-kit) runs the pinned AWS AI-DLC
methodology as an independently maintained Flow Agents kit. The open trust format
itself lives independently at [`hachure-org/spec`](https://github.com/hachure-org/spec);
Surface is Kontour's product-facing integration layer for it.

## Building-block tools

| Repository | Responsibility |
| --- | --- |
| [`forage`](https://github.com/kontourai/forage) | SSRF-pinned web acquisition, provenance-bearing snapshots, and deterministic replay |
| [`traverse`](https://github.com/kontourai/traverse) | Schema-directed, provenance-bearing extraction proposals |
| [`lookout`](https://github.com/kontourai/lookout) | Registered-source rechecks, source drift, and deterministic proposal diffs |
| [`bearing`](https://github.com/kontourai/bearing) | Evidence-backed model capability observations, deterministic catalogs, and runtime-aware ranking |
| [`datum`](https://github.com/kontourai/datum) | Provider, model, secret-reference, and role configuration resolution |
| [`relay`](https://github.com/kontourai/relay) | Provider-neutral model invocation contracts, adapters, and conformance tools |
| [`dispatch`](https://github.com/kontourai/dispatch) | Policy-aware model execution with routing, budgets, fallbacks, and receipts |
| [`conduit`](https://github.com/kontourai/conduit) | Portable agent-host contracts: lifecycle projection, asset installation, and conformance evidence |
| [`plumb`](https://github.com/kontourai/plumb) | Deployment health checks that hand failures to an agent in an isolated clone for a reviewable PR or issue |
| [`ephemeris`](https://github.com/kontourai/ephemeris) | Time actor: deadline wake-ups that nudge Flow, plus a timezone-aware recurring-schedule core |
| [`ui`](https://github.com/kontourai/ui) | Shared design tokens, React primitives, and web components for Kontour product interfaces |
| [`cli`](https://github.com/kontourai/cli) | The offline-first `kontour` command that routes to installed Kontour products |
| [`thread`](https://github.com/kontourai/thread) | Portable conversation schema and Ferry transcript conversion, with adapter-specific fidelity limits ([documentation](https://github.com/kontourai/thread/blob/main/docs/README.md)) |
| [`corpus`](https://github.com/kontourai/corpus) | Source-bound documentation checking, GitHub Pages publishing, and docs MCP retrieval |

[`kit-research`](https://github.com/kontourai/kit-research) is a third-party kit
authoring experiment. Its README states its current lifecycle and limits.

## Contribute

- File issues in the repository that owns the behavior or contract. Start at
  [kontourai.io/developers](https://kontourai.io/developers) if you are unsure
  which layer owns a concern.
- Read the target repository's `AGENTS.md`, `CONTEXT.md`, contribution guide,
  and architecture decisions before changing product language or contracts.
- Check each repository for its license, supported runtime, release status, and
  verification commands; those details intentionally live with the owning code.

## Work with us

We are looking for teams that want to:

- run Station or Flow Agents on real development work and measure whether the
  required path improves delivery quality, cost, and continuity;
- use Veritas to turn repository standards into evidence an agent and reviewer
  can both inspect; or
- build a product integration through Surface while keeping the underlying
  Hachure records portable and independently recomputable.

Email **hello@kontourai.io** with the workflow you want to make inspectable.

---

*Evidence-backed confidence. Not certainty theater.*
