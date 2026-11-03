# ADR 0002: Compiler (instruction + outcomes + reference run → checks)

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 2

## Context

ADR 0001 fixed the snapshot format and the check DSL. Milestone 2 produces check sets automatically from a task instruction, its expected outcomes ("Then" clauses) and a reference run. The compiler must avoid the main way LLM-written verifiers fail, which is adding conditions the task never stated (VerifierBench). The output must stay plain data that runs without a model.

## Decision

### Pipeline

1. **Rubric.** `parseOutcomes` splits the outcomes into clauses, keeping their exact positions. It accepts:
   - Gherkin `Then`/`And`/`But`/`*` steps. The text counts as Gherkin only if it has Given/When/Scenario lines or every line is a step. Sections reset the Then context, and indented lines continue a step.
   - Markdown lists, including checkboxes and bold `Then`.
   - Plain lines.

   Lines that aren't read as outcomes are returned as `ignored` and reported as compile warnings. They are never dropped silently.

   A model then proposes requirements by calling `submit_rubric`. The submission is rejected (with reasons sent back to the model) when:
   - a quote or text is empty or blank, or a quote is not verbatim in the instruction or the outcomes,
   - a quote spans several outcome clauses (one requirement per outcome),
   - an expected outcome is marked soft although the clause doesn't say it is optional,
   - an outcome clause has no requirement covering it. A quote covers a clause if it contains the clause, or if it is a substantial part of it: at least 60% of its words and at least two words. A stray word such as "the" covers nothing.
   - two requirements share an ID, or there is no hard requirement.

   The discovery agent sees each requirement as its quote. The requirement's `text` is only a label, so a paraphrase cannot add conditions.

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

The report lists, per requirement, the checks covering it, the evidence channels they use, and its trust: how hard it is to satisfy by faking page content. Every check must pass, so a requirement is as strong as its strongest check. An `anyOf` is as weak as its weakest branch, because that branch alone can pass; an `allOf` is as strong as its strongest part. Requirements covered only by free text are flagged.

### Models

- `ModelClient` is a small provider-neutral interface: one request in, one assistant turn out. Provider-native content (e.g. thinking blocks) is carried opaquely and sent back unchanged.
- `runAgent` is a provider-neutral tool loop:
  - it validates every tool input against its schema before running the tool,
  - it returns all of a turn's tool results in one message,
  - it checks for refusal and `max_tokens` before running anything,
  - it stops running calls once one finishes the task, so later calls in the same turn can't contradict the accepted result,
  - it never sends back an empty assistant turn.
- The bundled adapter, `anthropicModel`, uses the official Anthropic SDK (an optional peer dependency) with these defaults:
  - model `claude-opus-5-5`,
  - adaptive thinking (the model's default),
  - explicit effort `high`,
  - streamed requests,
  - server-side refusal fallback `fallbacks: "default"`,
  - prompt caching (`cache_control`), because agent loops re-send a long stable prefix every turn; usage reports cache reads and writes,
  - up to two retries when a streamed tool input arrives as invalid JSON (a client-side SDK error, not an API error).

  Other providers implement the same interface.

- **Cassettes** make model steps reproducible. A live run records each turn under a digest of the full request plus the model ID, which includes the effort. Later runs replay it without a key. The cassette is written after every turn, so an error mid-run keeps what was already paid for. Tools are deterministic (fixed snapshots, pure evaluation), so a replayed run issues exactly the recorded requests. If the prompt, tools or inputs change, the replay fails loudly instead of drifting.

### Trajectories

An agent trajectory may be passed as context. The prompt marks it as context only. It is never evidence, and no check can refer to it, because the DSL has no such source.

## Consequences

- A compiled check set has, by construction, passed on a correct run. With negative references it has also been shown to reject at least those. Stress testing (milestone 3) checks robustness beyond the references.
- Evaluating on held-out runs is straightforward. The Tiny Shop acceptance run compiles from one correct run per task and judges all the other labelled runs. Every task has at least one further correct run (an extra item, other changes alongside, a different order of steps), so over-constraint shows up as a rejected correct run.
- Compilation depends on the model's exploration quality. The repair loop, the validator and the reference checks bound the damage: an over-constrained check that still passes on the single reference is caught by held-out correct runs and by milestone 3's valid variants, not by the compiler.
