# ADR 0002: Compiler (instruction + outcomes + reference run → checks)

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 2

## Context

ADR 0001 fixed the snapshot format and the check DSL. Milestone 2 produces check sets automatically from a task instruction, its expected outcomes ("Then" clauses) and a reference run. The compiler must avoid the main way LLM-written verifiers fail, which is adding conditions the task never stated (VerifierBench). The output must stay plain data that runs without a model.

## Decision

### Pipeline

1. **Rubric.** `parseOutcomes` splits the outcomes into clauses, keeping their exact positions; it accepts Gherkin `Then/And/But`, Markdown lists or plain lines. A model then proposes requirements by calling `submit_rubric`. The submission is rejected (with reasons sent back to the model) when:
   - a quote is not verbatim in the instruction or the outcomes,
   - an outcome clause has no requirement quoting it,
   - two requirements share an ID, or there is no hard requirement.

   `rubric: 'deterministic'` skips the model and makes one hard requirement per clause.

2. **Evidence discovery.** An agent explores the reference snapshots with read-only tools: `page_outline`, `find_nodes`, `network_log`, `network_entry`, `storage`, `probes`, plus `try_assertion`, which evaluates a draft assertion against every reference. The system prompt carries the rules from ADR 0001:
   - anchors vs. assertions,
   - the trust order (prefer structured evidence),
   - no unstated conditions,
   - permissive matching (contains, normalizers, schemas with only the required properties),
   - a witness on absence checks,
   - a request check paired with every value read from a network body.
3. **Compile and repair.** `submit_checks` is both the output and the repair loop. A submission is accepted only when:
   - it passes the JSON Schema and the semantic validator, which also enforces traceability,
   - every requirement has at least one check,
   - every check passes on every correct reference,
   - no incorrect reference, if any are given, is judged a success.

   Otherwise the errors go back to the agent. Warnings, such as free-text-only coverage, an incorrect run that abstains instead of failing, or anchor drift, are reported but don't block acceptance.

The report lists, per requirement, the checks covering it, the evidence channels they use and the strongest trust level. Requirements covered only by free text are flagged.

### Models

- `ModelClient` is a small provider-neutral interface: one request in, one assistant turn out. Provider-native content (e.g. thinking blocks) is carried opaquely and sent back unchanged.
- `runAgent` is a provider-neutral tool loop. It validates every tool input against its schema before running the tool, returns all of a turn's tool results in one message, and checks for refusal and `max_tokens` before running anything.
- The bundled adapter, `anthropicModel`, uses the official Anthropic SDK (an optional peer dependency) with these defaults:
  - model `claude-opus-5-5`,
  - adaptive thinking (the model's default),
  - explicit effort `high`,
  - streamed requests,
  - server-side refusal fallback `fallbacks: "default"`.

  Other providers implement the same interface.

- **Cassettes** make model steps reproducible. A live run records each turn under a digest of the full request, and later runs replay it without a key. Tools are deterministic (fixed snapshots, pure evaluation), so a replayed run issues exactly the recorded requests. If the prompt, tools or inputs change, the replay fails loudly instead of drifting.

### Trajectories

An agent trajectory may be passed as context. The prompt marks it as context only. It is never evidence, and no check can refer to it, because the DSL has no such source.

## Consequences

- A compiled check set has, by construction, passed on a correct run. With negative references it has also been shown to reject at least those. Stress testing (milestone 3) checks robustness beyond the references.
- Evaluating on held-out runs is straightforward. The Tiny Shop acceptance run compiles from one correct run per task and judges all the other labelled runs.
- Compilation depends on the model's exploration quality. The repair loop, the validator and the reference checks bound the damage: an over-constrained check that still passes on the single reference is caught by held-out correct runs and by milestone 3's valid variants, not by the compiler.
