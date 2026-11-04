---
'@swissspidy/assay': minor
---

Breaking: one `verify` function and focused entry points.

- `verify(checkSet, snapshot, options)` replaces `verifyWithEscalation` and `verifySnapshot`. It validates the check set, runs the checks, escalates to `options.verifier` when given and returns the outcome with its record. With `recordDir` it also writes the record.

  ```ts
  // Before
  const outcome = verifySnapshot(checks, snapshot);
  const { record, proposal } = await verifyWithEscalation(checks, snapshot, { verifier });
  writeOutcomeRecord('records', record, snapshot, checks, proposal);
  // After
  const { outcome } = await verify(checks, snapshot);
  const result = await verify(checks, snapshot, { verifier, recordDir: 'records' });
  // or: writeOutcomeRecord('records', result);
  ```

- The `EscalationResult` type is now `VerifyResult`; it also carries the validated `checkSet`, the `snapshot` and, with `recordDir`, the `written` files.
- `writeOutcomeRecord(dir, result)` takes a `verify` result instead of `(dir, record, snapshot, checkSet, proposal?)`.
- `expectOutcome` takes the verification options directly: `{ escalate: { verifier }, recordDir }` becomes `{ verifier, recordDir }`.
- `verifyPage` moved to `@swissspidy/assay/playwright`. It now returns a `verify` result (`outcome`, `snapshot`, `record`, …) and can escalate with live page access.
- `captureSnapshot`, `EvidenceRecorder` and the `CaptureOptions`, `Probe` and `RecorderOptions` types are exported from `@swissspidy/assay/playwright` only.
- The root entry keeps verification, validation, records, locking, reports and the model interface types. The rest moved:

  | Moved to                     | Exports                                                                                                                                                                 |
  | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `@swissspidy/assay/compiler` | `compileTask`, `parseOutcomes`, `parseOutcomesDetailed`, `rubricFromClauses`, `checkRubric`, `coversClause`, `verifyCandidate`, `coverage`, `assertionTrust`            |
  | `@swissspidy/assay/stress`   | `stressTest`, `formatStressReport`, `generateVariants`, `generateMutants`, `withSuccessClaim`, `GENERIC_VARIANTS`, `mapA11y`, `editNodes`, `removeNodes`, `unwrapNodes` |
  | `@swissspidy/assay/models`   | `anthropicModel`, `toAnthropicMessages`, `fromAnthropicMessage`, `runAgent`, `replayModel`, `recordingModel`, `requestKey`                                              |
  | `@swissspidy/assay/eval`     | `llmJudge`, `JUDGE_SYSTEM`, `metrics`, `costUsd`, `PRICING`                                                                                                             |

- No longer exported: `evaluateAssertion`, `kleeneAnd`, `kleeneOr`, `applyNormalizers`, `parseLocaleNumber`, `parseCurrency`, `parseDate`, `parseDateTime`, `NormalizeError`, `parseAriaSnapshot`, `canonical`, `matchText`, `canonicalJson`, `citedEvidence`, `sameOrigin`, `newRecordId`, `lockState` and `schemaViolations`.
- Only `@swissspidy/assay/models` names `@anthropic-ai/sdk` in its type declarations, so TypeScript consumers of the root, `/playwright`, `/compiler`, `/stress` and `/eval` no longer need `skipLibCheck` when the SDK is not installed. (`/ai-sdk` consumers need `skipLibCheck` or `@types/json-schema`, because the AI SDK's own declarations import `json-schema`.)
- `loadSnapshot` also checks the accessibility tree's shape (every node has a string `role`, `children` is an array) and rejects a malformed tree with an error naming the node, instead of `verify` failing later with a `TypeError`.
