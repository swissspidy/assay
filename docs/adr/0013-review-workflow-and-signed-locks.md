# ADR 0013: Review workflow and signed locks

- Status: Accepted
- Date: 2026-11-05
- Scope: check set format (`locked`, `rejected`), `verify`'s `requireLocked`, records, review sheet,
  CLI (`approve`, `reject`, `unlock`, `keygen`; `review`, `verify` and `validate` options)
- Amends: [ADR 0004](0004-escalation-and-records.md) (locking), [ADR 0010](0010-command-line-tool.md)
  (no command to lock)

## Context

A compiled check set is only as good as the person who read it. ADR 0004 added `lockCheckSet`: a
lock `{ by, at, digest }` whose digest covers the set together with `by` and `at`, so any later
edit breaks it, and `requireLocked` to refuse an unlocked set. Three things were missing:

- **Who.** The digest is unkeyed. Anyone who can edit the file can re-lock it under any name, so a
  lock shows that nobody edited the file carelessly, not that a particular person approved it.
- **What changed.** A broken lock said "content changed after locking" and nothing else. A reviewer
  asked to re-approve a recompiled set had to read all of it again, or diff JSON by hand.
- **A workflow.** There was no way to reject a proposal, no record of what the reviewer saw (stress
  results, warnings), and ADR 0010 kept locking out of the CLI, because a flag would make a
  confirmation too easy to give without reading.

## Decision

### Lifecycle

A check set's review state is derived from the file itself, so it travels with the file through a
pull request:

| State      | In the file                                                  | `verify --require-locked`  |
| ---------- | ------------------------------------------------------------ | -------------------------- |
| `proposal` | no `locked`; or a `rejected` whose content differs (revised) | refused                    |
| `rejected` | `rejected: { by, at, note, content }`, content unchanged     | refused (says who and why) |
| `approved` | `locked`, digest (and checked signature) valid               | accepted                   |
| `changed`  | `locked`, but the set or the lock was edited                 | refused (names the change) |

`approveCheckSet(cs, { by, note?, key?, stress? })` validates the set and locks it, replacing a
lock or rejection. `rejectCheckSet(cs, { by, note })` needs a note. `unlockCheckSet` removes both.
`reviewState(cs)` reports the state. `lockCheckSet(cs, by, at?)` remains, as an unsigned approval.

A rejection is not signed: it only withholds trust, and deleting it gains nothing, since an
unapproved set is refused anyway. A set cannot be both locked and rejected (a validation error).

### The lock

```jsonc
"locked": {
  "by": "alice@example.com",
  "at": "2026-11-05T10:00:00.000Z",
  "note": "Checked R2 against the order API.",       // optional
  "content": "sha256:…",                              // contentDigest(set)
  "items": { "id": "sha256:…", "version": "sha256:…", "task": "sha256:…", "compiled": "sha256:…",
             "requirement:R1": "sha256:…", "check:C1": "sha256:…" },
  "stress": "sha256:…",                               // optional: the stress report the reviewer saw
  "supersedes": "sha256:…",                           // optional: digest of the lock this replaced
  "digest": "sha256:…",
  "signature": { "alg": "ed25519", "keyId": "ed25519:3f2a9c0b1d4e5f60", "value": "base64…" } // optional
}
```

- **Content.** The normalized check set is its canonical JSON (keys sorted, no whitespace,
  `undefined` dropped; `canonicalJson`, as for every other digest) without `locked` and `rejected`.
  Array order counts: reordering requirements or checks changes the order of results and is
  reported ("requirements or checks were reordered"). No other normalization: the reviewer approved
  the exact text, including descriptions.
- **Digest.** `sha256(canonical({ ...set, locked: lock fields except digest and signature }))`. For
  a lock with only `by` and `at` this is ADR 0004's digest, so **locks written before this ADR verify
  unchanged** (`tests/support/legacy-locked.checks.json` is one); they just cannot say what changed.
- **Item digests** name what changed when the lock breaks: "changed after approval: requirement R2
  changed, check C3 removed". They are covered by the digest, so editing them to hide a change also
  breaks the lock. When no item differs but the content does, the set was reordered; when neither
  differs, the lock's own fields were edited.
- **Stress.** `stressDigest(report)` of the report `assay stress --json` printed. `approve` refuses a
  report for another id or version. The report names the set only by id and version, so the digest
  proves which report the reviewer saw, not that it was run on exactly this content.
- **Signature.** Ed25519 (`node:crypto`, no dependency) over the bytes of `"assay.lock/v1\n" +
  digest`. The digest covers the content and every lock field, so the signature does too; the fixed
  prefix keeps a lock signature from being valid as anything else. `keyId` is `ed25519:` and the first
  16 hex digits of the SHA-256 of the public key (SPKI DER). It only selects which trusted key to
  check with: trust comes from the keys the verifier is given, never from the file, which is why
  the lock does not embed the public key.

### Verifying a lock

`verifyLock(cs, { trustedKeys? })` returns the state (`none`, `valid`, `broken`), what changed, the
problems in plain language, and the signature status:

| Signature   | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `none`      | unsigned                                                                     |
| `unchecked` | signed, but no trusted keys were given                                       |
| `trusted`   | signed by a trusted key, and the signature verifies                          |
| `untrusted` | signed by a key that is not trusted (for example, someone re-signed an edit) |
| `invalid`   | signed under a trusted key's id but does not verify: the lock is **broken**  |

`requireLocked` (on `verify`, `verifyPage`, `expectOutcome`) is `true` for any valid lock, or
`{ trustedKeys }` to also require a `trusted` signature. A refusal is a `LockError` (with the
status) whose message says why: a proposal nobody approved, who rejected it and why, what changed,
"locked by bob but not signed", or "signed with key …, which is not a trusted key". `trustedKeys` on
its own only reports the signature in the record. Trusted keys are PEM strings (several blocks in
one string are fine), key objects, or `{ name, key }`; a private key stands for its public half.

The record's `checkSet.locked` gains `signature: { keyId, status, signer? }`, and a broken lock adds
`lockProblems`. Both are optional fields of `assay.record/v1`.

### Re-review: diff, and no carried-over approval

`diffCheckSets(old, new)` matches requirements and checks by id and reports, in the review sheet's
plain language (`describeAssertion`, the evidence each check reads, its settings), what was added,
removed, changed (and which fields), and renamed (same content, new id). `toReview` lists the
requirements a reviewer must read again: added or changed ones, those with a check added, removed,
changed, renamed or moved, and every requirement when the instruction or expected outcomes changed,
since a requirement's quote means what the task says. `reviewSheet(cs, { previous })` shows the diff
and then only those requirements in full; the others are one line each (collapsed in a PR comment).

**Approval is not carried over for unchanged requirements.** A lock is a statement about the whole
set, and the parts are not independent: the verdict is a conjunction over hard requirements, a
removed check leaves a requirement uncovered (abstain), a changed task changes what every quote
means, and escalation (`onFail`) works across checks of a requirement. A partial lock would also let
a check nobody read run under a reviewer's signature, and would need per-requirement signatures from
possibly different reviewers, which `requireLocked` would then have to reason about. What carries over
is the review effort: the diff tells the reviewer what to read, and approving again is one command.
`supersedes` links each approval to the one it replaced for an audit trail.

### Review sheet

`reviewSheet(cs, options)` (Markdown by default, or `format: 'html'`) shows, per requirement, each
check's description, what it tests, the evidence it reads with its trust level ("network log
(structured)", "page text (free text, spoofable)"), its settings, its stress findings
(over-constrained, fragile, weak, untested) and validation warnings about it; then the set's other
warnings, the stress rates and whether the report is the one the approver saw, and the approval state
(who, when, the note, the signature status, or what broke). Text from the check set is untrusted: it
is kept on one line and escaped (`<`/`>` in Markdown, everything in HTML), so a description cannot
forge a heading, an "approved" line or markup in a PR comment.

### CLI

ADR 0010 kept locking out of the CLI. A signature changes that: approving with `--key` needs the
reviewer's private key, which an automated step should not hold, so signing is the explicit human act.
An unsigned `approve` remains for teams that do not sign; `--require-signed` is how a consumer
insists on a signature.

| Command                                                                      | What it does                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `assay keygen [--out alice.pem]`                                             | An Ed25519 key pair (`alice.pem`, mode 600, and `alice.pub.pem`)    |
| `assay review <checks> [--diff <old>] [--stress <report>] [--format f]`      | The review sheet; `f` is `markdown`, `github` (collapsed) or `html` |
| `assay approve <checks> --reviewer <name> [--key <pem>] [--note] [--stress]` | Lock (signed with a key); rewrites the file unless `--out`          |
| `assay reject <checks> --reviewer <name> --note <text>`                      | Record a rejection                                                  |
| `assay unlock <checks>`                                                      | Back to a proposal                                                  |
| `assay verify … --require-signed --trusted-key <pem\|dir>`                   | Refuse a set without a trusted signature                            |
| `assay validate <checks…> --require-locked \| --require-signed`              | A CI gate: a set not approved as required is a problem (exit 1)     |

Keys: `--key` or `$ASSAY_SIGNING_KEY` (PEM text) to sign; `--trusted-key` (a PEM file, which may
hold several keys, or a directory of `.pem` files, named by file; repeatable) or
`$ASSAY_TRUSTED_KEYS` (PEM text) to trust. `$ASSAY_REVIEWER` stands in for `--reviewer`.
`--require-signed` without any trusted key is an error.

Exit statuses keep ADR 0010's contract: `approve`, `reject`, `unlock` and `keygen` exit 0, 3 on
usage (a missing `--reviewer` or `--note`, an unknown `--format`), 4 on errors (an invalid set, an
unreadable or non-Ed25519 key, a stress report for another set). `verify` refusing a set is 4, as
before: it cannot run it. `validate` reports a set that is not approved as required as 1, a definite
answer about the input, like an invalid set.

### Example: a pull request gate (documentation only)

Posts the review sheet with the diff against the base branch as a PR comment, and fails when a
changed check set has no fresh approval by a trusted key. Everything that runs comes from the base
branch. The workflow is triggered by `pull_request_target`, so its definition is read from the base
branch and a pull request cannot edit the gate away (with `pull_request`, it runs the pull request's
own copy of the workflow). Assay is installed from the base checkout, and the pull request's checkout
is only data, read by `git` and by `assay` (no `npm ci`, no scripts from the pull request), which is
what makes `pull_request_target` safe here. Make the job a required status check in the branch
protection rules or ruleset of the base branch, so a merge waits for it. The trusted public keys
are a repository variable, not files in the pull request, which could add its own key. The token
that can comment is given to the one step that comments, never to a step that installs packages.

```yaml
name: Check set review
on:
  pull_request_target: # the workflow comes from the base branch; never run code from the PR checkout
    paths: ['checks/**.checks.json']
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    env:
      BASE: ${{ github.base_ref }}
      ASSAY_TRUSTED_KEYS: ${{ vars.ASSAY_TRUSTED_KEYS }}
    steps:
      - uses: actions/checkout@v4 # trusted code: the base branch, which pins @swissspidy/assay
        with: { ref: '${{ github.base_ref }}', path: base, persist-credentials: false }
      - uses: actions/checkout@v4 # data only: the pull request
        with: { ref: '${{ github.event.pull_request.head.sha }}', path: pr, fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci --prefix base
      - name: Review sheets
        run: |
          shopt -s globstar nullglob
          assay=$PWD/base/node_modules/.bin/assay
          cd pr
          : > ../sheet.md
          for f in $(git diff --name-only "origin/$BASE...HEAD" -- 'checks/**/*.checks.json'); do
            [ -f "$f" ] || continue
            if git show "origin/$BASE:$f" > ../old.json 2>/dev/null; then diff=(--diff ../old.json); else diff=(); fi
            "$assay" review "$f" "${diff[@]}" --format github >> ../sheet.md
            echo >> ../sheet.md
          done
      - name: Comment
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          if [ -s sheet.md ]; then gh pr comment "$PR" -R "$GITHUB_REPOSITORY" --body-file sheet.md --edit-last --create-if-none; fi
      - name: Require a signed approval
        run: |
          shopt -s globstar nullglob
          cd pr && ../base/node_modules/.bin/assay validate checks/**/*.checks.json --require-signed
```

The reviewer reads the comment, runs `assay approve <file> --reviewer <name> --key <pem>` locally and
pushes; the next run passes. The gate covers every set, including those in subdirectories of
`checks/` (`globstar`), so a repository adopting it signs its existing sets once. Changes to this
workflow file only take effect once merged into the base branch, so they go through ordinary code
review.

## Consequences

- A set can carry proof of who approved it, checked against keys the deployment chooses. Rotating a
  key is changing the trusted set; approvals by a removed key become `untrusted` and need approving
  again.
- What a signature does not prove: the time (`at` is the signer's claim) and that the reviewer read
  anything. Private keys are the reviewer's to protect (`keygen` writes them with mode 600; CI should
  never hold one).
- Older Assay versions reject check sets with the new lock fields or `rejected` (the schema is
  closed); sets with ADR 0004 locks are unchanged. `lockCheckSet` now writes the new fields too.
- `tests/unit/review-locks.spec.ts` covers hashing, signing, tamper detection, the lifecycle, diffs
  and the sheet; `tests/unit/cli.spec.ts` the commands; `test:pack` a signed approval and verify from
  the packed tarball.
