---
'@swissspidy/assay': minor
---

Check sets now go through a review workflow: a compiled set is a proposal until a reviewer approves it (`approveCheckSet`, `assay approve`) or rejects it with a note (`rejectCheckSet`, `assay reject`). An approval can be signed with an Ed25519 key (`assay keygen`, `--key` or `ASSAY_SIGNING_KEY`), and `verify` can require a signature from a key you trust: `requireLocked: { trustedKeys }` in code, `--require-signed --trusted-key <pem>` (or `ASSAY_TRUSTED_KEYS`) on the command line; `assay validate --require-signed` is a CI gate. When a set is edited after approval, the refusal names what changed ("changed after approval: check C2 changed"). Locks made with `lockCheckSet` before this release still verify.

`assay review` gains `--diff <old>` (what changed since the approved version, and which requirements to re-review), `--stress <report>`, and `--format github|html` for pull request comments; the review sheet also shows the evidence each check reads and validation warnings. `reviewSheet(cs, options)`, `diffCheckSets` and `formatCheckSetDiff` do the same in code. Outcome records show the lock's signature and why a lock is broken.

```sh
assay approve checks/order.checks.json --reviewer alice --key alice.pem
assay verify checks/order.checks.json snapshot.json --require-signed --trusted-key alice.pub.pem
```
