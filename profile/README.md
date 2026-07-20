# Kontour AI

**Show the work behind AI.** Kontour makes AI-assisted work inspectable and
accountable: sources stay traceable, claims keep their evidence, required paths
advance through explicit gates, and people can recompute why work is ready.

→ [kontourai.io](https://kontourai.io) tells the product story. The repositories
below are the public implementation and documentation surfaces.

## Products and foundational primitives

| Repository | Responsibility |
| --- | --- |
| [`flow-agents`](https://github.com/kontourai/flow-agents) | Portable workflow engine, runtime adapters, hooks, and first-party kits for evidence-gated agent work |
| [`veritas`](https://github.com/kontourai/veritas) | Executable repository standards and evidence-backed merge readiness for AI-authored code |
| [`surface`](https://github.com/kontourai/surface) | Kontour's integration surface for portable claims, evidence, trust status, validation, and product-facing Hachure compatibility |
| [`flow`](https://github.com/kontourai/flow) | Process definitions, steps, gates, evidence expectations, transitions, and explicit exceptions |
| [`survey`](https://github.com/kontourai/survey) | Producer-side source, extraction, candidate, review, decision, and publication records |

The **Builder Kit** and **Knowledge Kit** are first-party solutions distributed
through Flow Agents rather than separate products. The open trust format itself
lives independently at [`hachure-org/spec`](https://github.com/hachure-org/spec);
Surface is Kontour's product-facing integration layer for it.

## Building-block tools

| Repository | Responsibility |
| --- | --- |
| [`forage`](https://github.com/kontourai/forage) | SSRF-pinned web acquisition, provenance-bearing snapshots, and deterministic replay |
| [`traverse`](https://github.com/kontourai/traverse) | Schema-directed, provenance-bearing extraction proposals |
| [`lookout`](https://github.com/kontourai/lookout) | Registered-source rechecks, source drift, and deterministic proposal diffs |
| [`bearing`](https://github.com/kontourai/bearing) | Evidence-backed model capability observations, deterministic catalogs, and request-relative ranking |
| [`datum`](https://github.com/kontourai/datum) | Provider, model, secret-reference, and role configuration resolution |
| [`plumb`](https://github.com/kontourai/plumb) | Guardrailed operational checks and isolated escalation into repair work |
| [`ui`](https://github.com/kontourai/ui) | Shared design tokens, React primitives, and web components for Kontour product interfaces |

[`ephemeris`](https://github.com/kontourai/ephemeris) preserves the frozen
freshness-scheduler prototype, and
[`kit-research`](https://github.com/kontourai/kit-research) is a third-party kit
authoring experiment. Their READMEs state their current lifecycle and limits.

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

- run Flow Agents on real development work and measure whether the required path
  improves delivery quality, cost, and continuity;
- use Veritas to turn repository standards into evidence an agent and reviewer
  can both inspect; or
- build a product integration through Surface while keeping the underlying
  Hachure records portable and independently recomputable.

Email **hello@kontourai.io** with the workflow you want to make inspectable.

---

*Evidence-backed confidence. Not certainty theater.*
