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

   Lines that aren't read as outcomes are returned as `ignored` and reported as compile warnings, in failed compiles too. They are never dropped silently. If outcomes are given but no clause can be read from them, the compile fails.

   A model then proposes requirements by calling `submit_rubric`. The submission is rejected (with reasons sent back to the model) when:
   - a quote or text is empty or blank, or a quote is not verbatim in the instruction or the outcomes,
   - a quote spans several outcome clauses (one requirement per outcome). Identical clauses count once, and a clause nested in another merged clause doesn't count separately.
   - a requirement quoting (part of) an expected outcome is soft, although its quoted words don't say it is optional ("ideally", "if possible", "optional", …). A clause can therefore be split into a hard part and an optional soft part.
   - a quote mixes a mandatory and an optional part: a soft quote must be one optional part (the optional wording opens it, closes it, or follows it after a comma or dash), a hard quote may not contain optional wording, and a quote with any negation never counts as optional. The rule is deliberately conservative: an unusual phrasing makes compilation fail or a requirement stricter, never drops a mandatory part.
   - an outcome clause is not fully covered. The quotes of all requirements together must cover every word of it: either one quote contains the whole clause, or several partial quotes leave no word out. A quote that drops the decisive word ("the order ships" for "the order ships express") covers nothing on its own.
   - two requirements share an ID, or there is no hard requirement.

   The discovery agent sees each requirement as its quote. The requirement's `text` is only a label, so a paraphrase cannot add conditions.

   `rubric: 'deterministic'` skips the model and makes one hard requirement per clause.

2. **Evidence discovery.** An agent explores the reference snapshots with read-only tools: `page_outline`, `find_nodes`, `network_log`, `network_entry`, `storage`, `probes`, plus `try_assertion`, which evaluates a draft assertion against every reference. The system prompt carries the rules from ADR 0001:
   - anchors vs. assertions,
   - the trust order (prefer structured evidence),
   - no unstated conditions,
   - permissive matching (contains, normalizers, schemas with only the required properties), but exact comparisons for exact values (`equals`, an anchored regex, pinned schema properties listed in `required`),
   - a check that the page is the one a requirement names ("the event page"): its URL path or a heading or landmark only it has,
   - a witness on absence checks,
   - a request check paired with every value read from a network body.
3. **Compile and repair.** `submit_checks` is both the output and the repair loop. A submission is accepted only when:
   - it passes the JSON Schema and the semantic validator, which also enforces traceability,
   - every requirement has at least one check,
   - every check passes on every correct reference,
   - no incorrect reference, if any are given, is judged a success,
   - no check fails or abstains on a valid variant of a correct reference (stress testing, ADR 0003).

   Otherwise the errors go back to the agent. Warnings, such as free-text-only coverage, an incorrect run that abstains instead of failing, anchor drift or a weak check, are reported but don't block acceptance. The exception is the validator's loose-match warnings (an unanchored literal regex on structured evidence, a JSON Schema property pinned with `const` or `enum` but not required; ADR 0001 §2.6): an accepted submission ends the run, so a warning on it is never acted on, and the fix never needs new evidence. The compiler refuses them as errors; `validateCheckSet` still reports them as warnings, since a handwritten set may mean them.

The report lists, per requirement, the checks covering it, the evidence channels they use, and its trust: how hard it is to satisfy by faking page content. Every check must pass, so a requirement is as strong as its strongest check. An `anyOf` is as weak as its weakest branch, because that branch alone can pass; an `allOf` is as strong as its strongest part. Requirements covered only by free text are flagged.

An accepted set carries its provenance in `compiled`: the compiler (`assay/<version>`), the model client it was given (`anthropic:claude-opus-5-5@high`, which includes the effort), the models that actually served the turns as the API reported them (a server-side fallback shows up here), and when the model ran. `compiled` is part of the set, so a lock (ADR 0004) covers it too. Handwritten sets have no `compiled`.

### Models

- `ModelClient` is a small provider-neutral interface: one request in, one assistant turn out. Provider-native content (e.g. thinking blocks) is carried opaquely and sent back unchanged.
- `runAgent` is a provider-neutral tool loop:
  - it validates every tool input against its schema before running the tool,
  - it returns all of a turn's tool results in one message,
  - it checks for refusal and `max_tokens` before running anything,
  - it stops running calls once one finishes the task, so later calls in the same turn can't contradict the accepted result,
  - it never sends back an empty assistant turn.
- The bundled adapter, `anthropicModel` (in `@swissspidy/assay/models`), uses the official Anthropic SDK (an optional peer dependency) with these defaults:
  - model `claude-opus-5-5`,
  - adaptive thinking (the model's default),
  - explicit effort `high`,
  - streamed requests,
  - server-side refusal fallback `fallbacks: "default"`,
  - prompt caching (`cache_control`), because agent loops re-send a long stable prefix every turn; usage reports cache reads and writes,
  - up to two retries when a streamed tool input arrives as invalid JSON (a client-side SDK error, not an API error).

  Other providers implement the same interface; `aiSdkModel` covers the providers of the Vercel AI SDK (ADR 0007).

- **Cassettes** make model steps reproducible. A live run records each turn under a digest of the full request plus the model ID, which includes the effort. Later runs replay it without a key. The cassette is written after every turn, so an error mid-run keeps what was already paid for. Tools are deterministic (fixed snapshots, pure evaluation), so a replayed run issues exactly the recorded requests. If the prompt, tools or inputs change, the replay fails loudly instead of drifting. A cassette records when it was recorded, and a replayed compile writes that time, not the replay's, into `compiled.at`, so replaying reproduces the committed file byte for byte. The scripts replay an existing cassette and record only missing ones; `ASSAY_MODEL_MODE=record` re-records all of them, and `ASSAY_MODEL_MODE=replay` never calls the model.

### Trajectories

An agent trajectory may be passed as context. The prompt marks it as context only. It is never evidence, and no check can refer to it, because the DSL has no such source.

## Consequences

- A compiled check set has, by construction, passed on a correct run. With negative references it has also been shown to reject at least those. Stress testing (milestone 3) checks robustness beyond the references.
- Evaluating on held-out runs is straightforward. The Tiny Shop acceptance run compiles from one correct run per task and judges all the other labelled runs. Every task has at least one further correct run (an extra item, other changes alongside, a different order of steps), so over-constraint shows up as a rejected correct run.
- The recompile for baselines judged every held-out run correctly, but two accepted checks abstained on valid variants, which the compiler then reported as a warning and did not refuse (it now refuses them, see below). Both were tool bugs, not model mistakes: a `text` source scoped to a region read its text without whitespace normalization, so a pattern with a plain space missed non-breaking spaces; and date re-formatting variants replaced a node's whole text, dropping the "Estimated delivery:" label that the check cut off with a `replace` and was anchored on. Scoped text is now canonicalized like a node's text, and variants and mutants re-render only the part left after the leading steps that cut text away. The tasks were then re-recorded.
- A later review of the compiled sets found three loose checks that every labelled run still judged correctly: an event page date checked on whatever page was open, a time zone matched with `/Berlin/`, and an order response schema pinning `status` without requiring it. The discovery prompt now asks for a page identity check (URL path, or a heading or landmark) when a requirement names a page, and the compiler refuses the two loose matches (above). The recompile then accepted a date check whose `extract` pattern stopped at the first four-digit run, so an ISO date abstained on a valid variant; abstaining on a valid variant is now refused like failing on one. That task was re-recorded; the other 29 recordings replay unchanged under the new rule.
- Compilation depends on the model's exploration quality. The repair loop, the validator and the reference checks bound the damage: an over-constrained check that still passes on the single reference is caught by held-out correct runs and by milestone 3's valid variants, not by the compiler.
