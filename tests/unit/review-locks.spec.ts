/** ADR 0013: approval, signed locks, tamper detection, rejection, re-review diffs and the review sheet. */
import { test, expect } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  approveCheckSet,
  assertLocked,
  contentDigest,
  diffCheckSets,
  evidenceRead,
  formatCheckSetDiff,
  generateSigningKey,
  isLocked,
  keyId,
  lockCheckSet,
  LockError,
  rejectCheckSet,
  reviewSheet,
  reviewState,
  stressDigest,
  unlockCheckSet,
  validateCheckSet,
  verify,
  verifyLock,
  type CheckSet,
  type EvidenceSnapshot,
} from '../../src/index.ts';
import { stressTest } from '../../src/stress/index.ts';
import { pemBlocks, trustedKeySet } from '../../src/verifier/sign.ts';
import { itemDigests, stressReportProblem } from '../../src/verifier/lock.ts';

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const TWO_MUGS: CheckSet = read('examples/tiny-shop/tasks/03-cart-two-mugs.checks.json');
const BLUE_MUG: CheckSet = read('examples/tiny-shop/tasks/02-add-blue-mug.checks.json');
const BOTH_MUGS: EvidenceSnapshot = read('examples/tiny-shop/references/03-cart-two-mugs/both-mugs.json').snapshot;
const ADDED_BLUE: EvidenceSnapshot = read('examples/tiny-shop/references/02-add-blue-mug/added-blue-mug.json').snapshot;
/** A lock written by Assay 0.1.0's lockCheckSet ({ by, at, digest }). */
const LEGACY: CheckSet = read('tests/support/legacy-locked.checks.json');

const AT = '2026-11-05T00:00:00.000Z';
const alice = generateSigningKey();
const mallory = generateSigningKey();
const clone = <T>(x: T): T => structuredClone(x);

test.describe('keys', () => {
  test('Ed25519 key pairs, key ids from either half, several PEM blocks in one string', () => {
    expect(alice.keyId).toMatch(/^ed25519:[0-9a-f]{16}$/);
    expect(keyId(alice.privateKey)).toBe(alice.keyId);
    expect(keyId(alice.publicKey)).toBe(alice.keyId);
    expect(alice.keyId).not.toBe(mallory.keyId);
    expect(pemBlocks(`${alice.publicKey}\n${mallory.publicKey}`)).toHaveLength(2);
    expect([...trustedKeySet([alice.publicKey + mallory.publicKey]).keys.keys()]).toEqual([alice.keyId, mallory.keyId]);
    expect(trustedKeySet([{ name: 'Alice', key: alice.publicKey }]).keys.get(alice.keyId)?.name).toBe('Alice');
  });

  test('other key types and junk are refused', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => approveCheckSet(TWO_MUGS, { by: 'a', key: pem })).toThrow('locks are signed with Ed25519');
    expect(() => approveCheckSet(TWO_MUGS, { by: 'a', key: alice.publicKey })).toThrow('not a PEM private key');
    expect(() => trustedKeySet(['nonsense'])).toThrow('holds no PEM block');
  });
});

test.describe('locks', () => {
  test('a lock written before signed locks still verifies, and still breaks on any edit', async () => {
    expect(validateCheckSet(LEGACY).errors).toEqual([]);
    expect(isLocked(LEGACY)).toBe(true);
    expect(verifyLock(LEGACY)).toMatchObject({ state: 'valid', signature: 'none' });
    const res = await verify(LEGACY, BOTH_MUGS, { requireLocked: true });
    expect(res.record.checkSet).toMatchObject({ locked: { by: 'reviewer@example.com' }, lockBroken: false });
    const edited = { ...LEGACY, version: '2' };
    expect(verifyLock(edited)).toMatchObject({
      state: 'broken',
      changes: [],
      problems: ['content, reviewer or time changed after locking (an older lock cannot say which)'],
    });
    // Approving it again upgrades it, and records which lock it replaced.
    const upgraded = approveCheckSet(LEGACY, { by: 'reviewer@example.com', at: AT });
    expect(upgraded.locked).toMatchObject({ supersedes: LEGACY.locked!.digest, content: contentDigest(LEGACY) });
  });

  test('an unsigned lock records the content and item digests', () => {
    const locked = lockCheckSet(TWO_MUGS, 'reviewer@example.com', AT);
    expect(validateCheckSet(locked).errors).toEqual([]);
    expect(locked.locked).toMatchObject({ by: 'reviewer@example.com', at: AT, content: contentDigest(TWO_MUGS) });
    expect(Object.keys(locked.locked.items!)).toEqual([
      'id',
      'version',
      'task',
      'requirement:R1',
      'requirement:R2',
      ...TWO_MUGS.checks.map((c) => `check:${c.id}`),
    ]);
    expect(locked.locked.signature).toBeUndefined();
    expect(verifyLock(locked)).toMatchObject({ state: 'valid', signature: 'none' });
    // The content digest ignores the review state; approving twice at the same time is deterministic.
    expect(contentDigest(locked)).toBe(contentDigest(TWO_MUGS));
    expect(lockCheckSet(locked, 'reviewer@example.com', AT).locked.content).toBe(locked.locked.content);
  });

  test('tampering names what changed', () => {
    const locked = approveCheckSet(TWO_MUGS, { by: 'alice', at: AT, note: 'ok', key: alice.privateKey });
    const problems = (cs: CheckSet) => verifyLock(cs, { trustedKeys: [alice.publicKey] }).problems;

    const check = clone(locked);
    (check.checks[0]!.assert as { count?: unknown }).count = { gte: 2 };
    expect(problems(check)).toEqual([`changed after approval: check ${TWO_MUGS.checks[0]!.id} changed`]);

    const req = clone(locked);
    req.requirements[1]!.kind = 'soft';
    req.requirements.push({ ...req.requirements[0]!, id: 'R9' });
    req.checks.pop();
    expect(problems(req)).toEqual([
      `changed after approval: requirement R2 changed, requirement R9 added, check ${TWO_MUGS.checks.at(-1)!.id} removed`,
    ]);

    const task = clone(locked);
    task.task.instruction += ' Quickly.';
    task.version = '2';
    expect(problems(task)).toEqual(['changed after approval: version changed, task changed']);

    const reordered = clone(locked);
    reordered.checks.reverse();
    expect(problems(reordered)).toEqual(['changed after approval: requirements or checks were reordered']);

    const by = clone(locked);
    by.locked.by = 'mallory';
    expect(problems(by)).toEqual(["the lock's own fields (reviewer, time, note or digests) were edited"]);
    const note = clone(locked);
    note.locked.note = 'not ok';
    expect(verifyLock(note).state).toBe('broken');
    // Editing one recorded item digest breaks the lock, and so does updating it to hide a change.
    const items = clone(locked);
    items.locked.items!['check:C1'] = `sha256:${'0'.repeat(64)}`;
    expect(problems(items)).toEqual(["the lock's own fields (reviewer, time, note or digests) were edited"]);
    const hidden = clone(check);
    hidden.locked.items!['check:C1'] = itemDigests(hidden)['check:C1']!;
    expect(isLocked(hidden)).toBe(false);
  });

  test('signatures: trusted, untrusted, unchecked and invalid', () => {
    const locked = approveCheckSet(TWO_MUGS, { by: 'alice', at: AT, key: alice.privateKey });
    expect(locked.locked.signature).toMatchObject({ alg: 'ed25519', keyId: alice.keyId });
    expect(verifyLock(locked)).toMatchObject({ state: 'valid', signature: 'unchecked' });
    expect(verifyLock(locked, { trustedKeys: [{ name: 'Alice', key: alice.publicKey }] })).toMatchObject({
      state: 'valid',
      signature: 'trusted',
      signer: 'Alice',
    });
    // A private key stands for its public half.
    expect(verifyLock(locked, { trustedKeys: [alice.privateKey] }).signature).toBe('trusted');
    expect(verifyLock(locked, { trustedKeys: [mallory.publicKey] })).toMatchObject({
      state: 'valid',
      signature: 'untrusted',
    });

    // Mallory edits the set and re-signs it with her key, claiming to be Alice.
    const forged = approveCheckSet(
      { ...clone(locked), version: '2' },
      { by: 'alice', at: AT, key: mallory.privateKey },
    );
    expect(verifyLock(forged, { trustedKeys: [alice.publicKey] }).signature).toBe('untrusted');
    // ... or keeps Alice's key id on her own signature.
    const spoofed = clone(forged);
    spoofed.locked.signature!.keyId = alice.keyId;
    expect(verifyLock(spoofed, { trustedKeys: [alice.publicKey] })).toMatchObject({
      state: 'broken',
      signature: 'invalid',
      problems: [`the signature does not verify with trusted key ${alice.keyId}`],
    });
    // A changed signature value is invalid too; the unsigned digest alone still matches.
    const flipped = clone(locked);
    flipped.locked.signature!.value = forged.locked.signature!.value;
    expect(verifyLock(flipped, { trustedKeys: [alice.publicKey] }).state).toBe('broken');
    expect(verifyLock(flipped).state).toBe('valid');
  });

  test('requireLocked: any valid lock, or one signed by a trusted key, with clear refusals', async () => {
    const unsigned = lockCheckSet(TWO_MUGS, 'bob', AT);
    const signed = approveCheckSet(TWO_MUGS, { by: 'alice', at: AT, key: alice.privateKey });
    const trusted = { trustedKeys: [alice.publicKey] };
    expect(() => assertLocked(TWO_MUGS, true)).toThrow(
      'Check set tiny-shop/cart-two-mugs v1 is not locked: it is a proposal nobody has approved.',
    );
    expect(() => assertLocked(unsigned, trusted)).toThrow(
      'is locked by bob but not signed; a signature from a trusted key is required.',
    );
    expect(() => assertLocked(signed, { trustedKeys: [mallory.publicKey] })).toThrow(
      `is signed with key ${alice.keyId}, which is not a trusted key.`,
    );
    const broken = { ...signed, checks: signed.checks.slice(1) };
    let error: unknown;
    try {
      assertLocked(broken, trusted);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LockError);
    expect((error as Error).message).toBe(
      `Check set tiny-shop/cart-two-mugs v1 is not locked: its lock is broken (changed after approval: check ${TWO_MUGS.checks[0]!.id} removed).`,
    );
    expect((error as LockError).status.changes).toEqual([
      { part: 'check', id: TWO_MUGS.checks[0]!.id, change: 'removed' },
    ]);
    expect(assertLocked(unsigned, true)?.state).toBe('valid');

    await expect(verify(unsigned, BOTH_MUGS, { requireLocked: trusted })).rejects.toThrow('not signed');
    const res = await verify(signed, BOTH_MUGS, { requireLocked: trusted });
    expect(res.record.checkSet.locked).toEqual({
      by: 'alice',
      at: AT,
      signature: { keyId: alice.keyId, status: 'trusted', signer: alice.keyId },
    });
    const plain = await verify(broken, BOTH_MUGS);
    expect(plain.record.checkSet).toMatchObject({
      locked: null,
      lockBroken: true,
      lockProblems: [`changed after approval: check ${TWO_MUGS.checks[0]!.id} removed`],
    });
  });
});

test.describe('lifecycle', () => {
  test('proposal → rejected → revised proposal → approved → changed → unlocked', () => {
    expect(reviewState(TWO_MUGS).state).toBe('proposal');
    expect(() => rejectCheckSet(TWO_MUGS, { by: 'bob', note: ' ' })).toThrow('needs a note');
    const rejected = rejectCheckSet(TWO_MUGS, { by: 'bob', at: AT, note: 'R2 reads free text' });
    expect(validateCheckSet(rejected).errors).toEqual([]);
    expect(reviewState(rejected)).toMatchObject({
      state: 'rejected',
      rejected: { by: 'bob', note: 'R2 reads free text' },
    });
    expect(() => assertLocked(rejected, true)).toThrow('is not locked: bob rejected it (R2 reads free text).');
    const revised = { ...clone(rejected), version: '2' };
    expect(reviewState(revised).state).toBe('proposal');
    const approved = approveCheckSet(revised, { by: 'bob', at: AT });
    expect(approved).not.toHaveProperty('rejected');
    expect(reviewState(approved).state).toBe('approved');
    expect(reviewState({ ...approved, version: '3' }).state).toBe('changed');
    expect(unlockCheckSet(approved)).toEqual(unlockCheckSet(revised));
    expect(validateCheckSet({ ...approved, rejected: rejected.rejected }).errors).toContain(
      'a check set cannot be both locked and rejected',
    );
  });

  test('approval validates the set and binds the stress report the reviewer saw', () => {
    expect(() => approveCheckSet({ ...TWO_MUGS, requirements: [] } as CheckSet, { by: 'a' })).toThrow(
      'Invalid check set',
    );
    expect(() => approveCheckSet(TWO_MUGS, { by: ' ' })).toThrow('needs the reviewer');
    const report = stressTest(TWO_MUGS, [{ name: 'both-mugs', snapshot: BOTH_MUGS }]);
    const locked = approveCheckSet(TWO_MUGS, { by: 'a', at: AT, stress: report });
    expect(locked.locked.stress).toBe(stressDigest(JSON.parse(JSON.stringify(report))));
    expect(() => approveCheckSet(BLUE_MUG, { by: 'a', stress: report })).toThrow(
      'the stress report is for tiny-shop/cart-two-mugs v1, not tiny-shop/add-blue-mug v1',
    );
    expect(reviewSheet(locked, { stress: report })).toContain('this is the report the approver saw');
    const weak = {
      ...report,
      weak: [{ check: 'C1', mutants: [{ reference: 'both-mugs', id: 'm', description: 'd' }] }],
    };
    expect(reviewSheet(TWO_MUGS, { stress: weak })).toContain('  - stress: weak: still passes both-mugs/m (d)');
    const other = stressTest(TWO_MUGS, [{ name: 'both-mugs', snapshot: BOTH_MUGS }], { successClaims: false });
    expect(reviewSheet(locked, { stress: other })).toContain('this is not the report the approver saw');
  });
});

test.describe('re-review diff', () => {
  test('added, removed, changed and renamed requirements and checks; what to re-review', () => {
    const v2 = clone(TWO_MUGS);
    v2.version = '2';
    const [first, second] = v2.checks;
    first!.description = 'The cart lists the Blue Mug.';
    const renamedFrom = second!.id;
    second!.id = 'renamed';
    v2.requirements.push({ id: 'R3', kind: 'soft', text: 'Quickly', source: v2.requirements[0]!.source });
    v2.checks.push({ ...clone(first!), id: 'new', requirement: 'R3' });
    const d = diffCheckSets(TWO_MUGS, v2);
    expect(d.identical).toBe(false);
    expect(d.set).toEqual([{ field: 'version', before: '1', after: '2' }]);
    expect(d.requirements.added.map((r) => r.id)).toEqual(['R3']);
    expect(d.requirements.unchanged).toEqual(['R1', 'R2']);
    expect(d.checks.changed).toMatchObject([{ id: first!.id, fields: ['description'] }]);
    expect(d.checks.renamed).toEqual([{ from: renamedFrom, to: 'renamed' }]);
    expect(d.checks.added.map((c) => c.id)).toEqual(['new']);
    expect(d.checks.added[0]!.reads.length).toBeGreaterThan(0);
    expect(d.toReview).toEqual([...new Set([first!.requirement, second!.requirement, 'R3'])].filter(Boolean));

    const md = formatCheckSetDiff(d);
    expect(md).toContain(`## Changes: tiny-shop/cart-two-mugs v1 → tiny-shop/cart-two-mugs v2`);
    expect(md).toContain('- version: 1 → 2');
    expect(md).toContain('- added **R3** (soft):');
    expect(md).toContain(`- renamed ${renamedFrom} → renamed (unchanged otherwise)`);
    expect(md).toContain('    - after: The cart lists the Blue Mug.');

    // A task change puts every requirement up for review; removing a check, the requirement it covered.
    const task = { ...clone(TWO_MUGS), task: { ...TWO_MUGS.task, outcomes: `${TWO_MUGS.task.outcomes}\nThen done` } };
    expect(diffCheckSets(TWO_MUGS, task).toReview).toEqual(['R1', 'R2']);
    const fewer = { ...clone(TWO_MUGS), checks: TWO_MUGS.checks.filter((c) => c.requirement !== 'R2') };
    expect(diffCheckSets(TWO_MUGS, fewer).toReview).toEqual(['R2']);
    expect(diffCheckSets(TWO_MUGS, lockCheckSet(TWO_MUGS, 'a')).identical).toBe(true);
  });

  test('the review sheet against the approved version expands only what changed', () => {
    const approved = lockCheckSet(TWO_MUGS, 'alice', AT);
    const v2 = clone(approved);
    v2.checks = v2.checks.filter((c) => c.requirement !== 'R2' || c === v2.checks.find((x) => x.requirement === 'R2'));
    const r2 = v2.checks.find((c) => c.requirement === 'R2')!;
    r2.description = 'changed';
    const sheet = reviewSheet(v2, { previous: approved });
    expect(sheet).toContain('## Changes since tiny-shop/cart-two-mugs v1');
    expect(sheet).toContain('## R2 (hard): "');
    expect(sheet).toContain('(checks changed)');
    expect(sheet).toMatch(/### Unchanged since tiny-shop\/cart-two-mugs v1 \(1 requirement\)\n\n- \*\*R1\*\*/);
    expect(sheet).toContain('Locked by alice at 2026-11-05T00:00:00.000Z (BROKEN: changed after approval:');
    expect(reviewSheet(v2, { previous: approved, details: true })).toContain(
      '<details><summary>Unchanged since tiny-shop/cart-two-mugs v1 (1 requirement)</summary>',
    );
    // Without the approved version, the lock still names what changed.
    expect(reviewSheet(v2)).toContain(`**Changed since approval:** check ${r2.id} changed`);
  });
});

test.describe('review sheet', () => {
  test('evidence read, warnings next to their check, the approval state', () => {
    expect(evidenceRead(BLUE_MUG.checks[0]!.assert)).toEqual(['backend probe (structured)']);
    expect(
      evidenceRead({
        kind: 'anyOf',
        of: [
          { kind: 'value', source: { from: 'text', pattern: 'x' }, expect: { eq: 'x' } },
          { kind: 'request', match: { method: 'POST' } },
        ],
      } as never),
    ).toEqual(['network log (structured)', 'page text (free text, spoofable)']);
    const warned: CheckSet = read('examples/tiny-shop/tasks/05-set-quantity.checks.json');
    const sheet = reviewSheet(warned);
    expect(sheet).toMatch(/- \*\*C1\*\* .*\n(  - .*\n)*  - warning: check C1: exact equality on a number/);
    expect(sheet).toContain('Not locked: a proposal awaiting review.');
    const signed = approveCheckSet(BLUE_MUG, { by: 'alice', at: AT, note: 'fine', key: alice.privateKey });
    expect(reviewSheet(signed, { trustedKeys: [{ name: 'Alice', key: alice.publicKey }] })).toContain(
      'Locked by alice at 2026-11-05T00:00:00.000Z (valid, signed with trusted key Alice).\n\n**Note:** fine',
    );
    expect(reviewSheet(signed)).toContain(`signed with key ${alice.keyId} (not checked: no trusted keys given)`);
    expect(reviewSheet(signed, { trustedKeys: [mallory.publicKey] })).toContain('which is NOT a trusted key');
    expect(reviewSheet(rejectCheckSet(BLUE_MUG, { by: 'bob', at: AT, note: 'no' }))).toContain(
      `**Rejected by bob at ${AT}:** no`,
    );
  });

  test('untrusted text cannot add markup: one line, angle brackets escaped, HTML escaped', () => {
    const evil = clone(BLUE_MUG);
    evil.checks[0]!.description = 'fine\n## Approved <img src=x onerror=alert(1)>';
    const md = reviewSheet(evil);
    expect(md).toContain('- **C1** fine ## Approved \\<img src=x onerror=alert(1)\\>');
    const html = reviewSheet(evil, { format: 'html' });
    expect(html).toContain('<h1>Review: tiny-shop/add-blue-mug v1</h1>');
    expect(html).toContain('fine ## Approved &lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  test('a verified run of a signed set from the review sheet to the record', async () => {
    const signed = approveCheckSet(BLUE_MUG, { by: 'alice', at: AT, key: alice.privateKey });
    const res = await verify(JSON.parse(JSON.stringify(signed)), ADDED_BLUE, {
      requireLocked: { trustedKeys: [{ name: 'Alice', key: alice.publicKey }] },
    });
    expect(res.outcome.verdict).toBe('success');
    expect(res.record.checkSet.locked?.signature).toEqual({ keyId: alice.keyId, status: 'trusted', signer: 'Alice' });
  });

  test('a key removed from the trusted list is not trusted on the next verify of the same objects', async () => {
    const signed = approveCheckSet(BLUE_MUG, { by: 'alice', at: AT, key: alice.privateKey });
    const trustedKeys = [{ name: 'Alice', key: alice.publicKey }];
    const first = await verify(signed, ADDED_BLUE, { trustedKeys });
    expect(first.record.checkSet.locked?.signature?.status).toBe('trusted');
    await expect(verify(signed, ADDED_BLUE, { requireLocked: { trustedKeys } })).resolves.toBeDefined();
    trustedKeys.splice(0, 1, { name: 'Mallory', key: mallory.publicKey }); // the same array, Alice revoked
    const second = await verify(signed, ADDED_BLUE, { trustedKeys });
    expect(second.record.checkSet.locked?.signature?.status).toBe('untrusted');
    await expect(verify(signed, ADDED_BLUE, { requireLocked: { trustedKeys } })).rejects.toThrow(LockError);
    trustedKeys.length = 0;
    expect((await verify(signed, ADDED_BLUE, { trustedKeys })).record.checkSet.locked?.signature?.status).toBe(
      'untrusted',
    );
  });

  test('a key name that spells out another key does not keep that key trusted', async () => {
    // The memo once joined "id\0name" pairs with newlines; this name rebuilt the two-key string.
    const [low, signer] = alice.keyId < mallory.keyId ? [alice, mallory] : [mallory, alice];
    const signed = approveCheckSet(BLUE_MUG, { by: 'signer', at: AT, key: signer.privateKey });
    const trustedKeys = [
      { name: 'Team', key: low.publicKey },
      { name: 'Signer', key: signer.publicKey },
    ];
    await expect(verify(signed, ADDED_BLUE, { requireLocked: { trustedKeys } })).resolves.toBeDefined();
    trustedKeys.splice(0, 2, { name: `Team\n${signer.keyId}\u0000Signer`, key: low.publicKey });
    await expect(verify(signed, ADDED_BLUE, { requireLocked: { trustedKeys } })).rejects.toThrow(LockError);
  });
});

test.describe('route and page checks (ADR 0011, 0012)', () => {
  const withRoute = (): CheckSet => {
    const cs = clone(TWO_MUGS);
    cs.checks[1] = {
      ...cs.checks[1]!,
      onMissing: 'abstain',
      assert: {
        kind: 'page',
        match: { url: { path: '/cart' } },
        assert: { kind: 'contains', match: { role: 'row', name: { contains: 'Red Mug' } } },
      } as never,
    };
    return cs;
  };

  test('the lock covers onMissing and page assertions; the diff and the sheet show them', () => {
    const cs = withRoute();
    expect(validateCheckSet(cs).errors).toEqual([]);
    const locked = lockCheckSet(cs, 'alice', AT);
    expect(isLocked(locked)).toBe(true);

    const fail = clone(locked);
    fail.checks[1]!.onMissing = 'fail';
    expect(verifyLock(fail).problems).toEqual(['changed after approval: check C2 changed']);
    const page = clone(locked);
    (page.checks[1]!.assert as { match: { url: { path: string } } }).match.url.path = '/checkout';
    expect(verifyLock(page).problems).toEqual(['changed after approval: check C2 changed']);

    const d = diffCheckSets(locked, fail);
    expect(d.checks.changed).toMatchObject([{ id: 'C2', fields: ['on missing route evidence'] }]);
    expect(formatCheckSetDiff(d)).toContain(
      '- before: on missing route evidence: abstain (the run may have done it another way)',
    );
    expect(diffCheckSets(locked, page).checks.changed).toMatchObject([{ id: 'C2', fields: ['what it tests'] }]);

    const sheet = reviewSheet(locked);
    expect(sheet).toContain('  - on missing route evidence: abstain (the run may have done it another way)');
    expect(sheet).toMatch(/ {2}- tests: on the one open page \(tab or popup\) with .*\/cart/);
    expect(sheet).toContain('  - reads: URL (structured), accessibility tree (semantic)');
  });
});

test.describe('review findings (PR #24)', () => {
  test('approve and reject refuse an empty time and a malformed stress report', () => {
    expect(() => approveCheckSet(TWO_MUGS, { by: 'a', at: ' ' })).toThrow('`at` is empty');
    expect(() => rejectCheckSet(TWO_MUGS, { by: 'a', note: 'no', at: '' })).toThrow('`at` is empty');
    const report = stressTest(TWO_MUGS, [{ name: 'both-mugs', snapshot: BOTH_MUGS }]);
    expect(stressReportProblem(JSON.parse(JSON.stringify(report)))).toBeUndefined();
    const { weak: _w, ...noWeak } = report;
    expect(() => approveCheckSet(TWO_MUGS, { by: 'a', stress: noWeak })).toThrow('not a stress report: no weak list');
    expect(stressReportProblem({ ...report, rates: { a: 'x' } })).toBe('no rates');
  });

  test('a set both locked and rejected is broken; a revised rejection reads as a plain proposal', () => {
    const locked = lockCheckSet(TWO_MUGS, 'a', AT);
    const both = { ...locked, rejected: rejectCheckSet(TWO_MUGS, { by: 'b', note: 'no', at: AT }).rejected };
    expect(verifyLock(both)).toMatchObject({ state: 'broken', problems: ['the set is both locked and rejected'] });
    const revised = { ...rejectCheckSet(TWO_MUGS, { by: 'bob', note: 'no', at: AT }), version: '2' };
    expect(() => assertLocked(revised, true)).toThrow('is not locked: it is a proposal nobody has approved.');
  });

  test('the diff reports provenance models, requirement renames, reordering and source changes', () => {
    const compiled: CheckSet = read('examples/tiny-shop/compiled/02-add-blue-mug.checks.json');
    const served = clone(compiled);
    served.compiled!.modelsUsed = ['other-model'];
    const prov = diffCheckSets(compiled, served).set;
    expect(prov).toHaveLength(1);
    expect(prov[0]!.after).toContain('served by other-model');

    const renamed = clone(TWO_MUGS);
    renamed.requirements[1]!.id = 'R2b';
    renamed.checks[1]!.requirement = 'R2b';
    const d = diffCheckSets(TWO_MUGS, renamed);
    expect(d.requirements).toMatchObject({ added: [], removed: [], renamed: [{ from: 'R2', to: 'R2b' }] });
    expect(formatCheckSetDiff(d)).toContain('- renamed R2 → R2b (unchanged otherwise)');

    const reordered = { ...clone(TWO_MUGS), checks: TWO_MUGS.checks.toReversed() };
    const r = diffCheckSets(TWO_MUGS, reordered);
    expect(r).toMatchObject({ identical: false, reordered: { requirements: false, checks: true } });
    expect(formatCheckSetDiff(r)).toContain('- reordered (the order of results changes)');

    const moved = clone(TWO_MUGS);
    moved.task.instruction += ' The cart page lists a Blue Mug.';
    moved.requirements[0]!.source.field = 'instruction';
    const src = diffCheckSets(TWO_MUGS, moved);
    expect(src.requirements.changed).toMatchObject([{ id: 'R1', fields: ['source'] }]);
    expect(formatCheckSetDiff(src)).toContain(
      '- source: outcomes "the cart page lists a Blue Mug" → instruction "the cart page lists a Blue Mug"',
    );
  });

  test('warnings go to the right check, dotted ids included; unmatched ones are general', () => {
    const cs = clone(TWO_MUGS);
    cs.checks[0]!.id = 'C1.a';
    const sheet = reviewSheet(cs, {
      warnings: ['check C1.a.allOf[0]: dotted', 'check C2: plain', 'check C9: unknown', 'requirement R1 has none'],
    });
    expect(sheet).toMatch(/- \*\*C1\.a\*\* .*\n( {2}- .*\n)*? {2}- warning: check C1\.a\.allOf\\\[0\\\]: dotted/);
    expect(sheet).toMatch(/- \*\*C2\*\* .*\n( {2}- .*\n)*? {2}- warning: check C2: plain/);
    expect(sheet).toContain('## Warnings\n\n- check C9: unknown');
    expect(sheet).toContain('- warning: requirement R1 has none');
  });

  test('unchanged requirements keep their stress findings and warnings in the collapsed section', () => {
    const report = stressTest(TWO_MUGS, [{ name: 'both-mugs', snapshot: BOTH_MUGS }]);
    const weak = {
      ...report,
      weak: [{ check: 'C1', mutants: [{ reference: 'both-mugs', id: 'm', description: 'd' }] }],
    };
    const v2 = clone(TWO_MUGS);
    v2.checks[1]!.description = 'Changed.';
    const sheet = reviewSheet(v2, { previous: TWO_MUGS, stress: weak, warnings: ['check C1: careful'] });
    expect(sheet).toContain(
      '- **R1** (hard): "the cart page lists a Blue Mug": checks C1\n  - C1 stress: weak: still passes both-mugs/m (d)\n  - warning: check C1: careful',
    );
  });

  test('a named trusted key holding several PEM blocks indexes each under its name', () => {
    const set = trustedKeySet([{ name: 'team', key: alice.publicKey + mallory.publicKey }]);
    expect([...set.keys.values()].map((k) => k.name)).toEqual(['team', 'team']);
    expect(set.keys.has(mallory.keyId)).toBe(true);
  });

  test('Markdown escapes backslashes, links, images and code spans in check set text', () => {
    const evil = clone(BLUE_MUG);
    evil.checks[0]!.description = '![x](https://e.test/a.png) [ok](https://e.test) \\<b> `x`';
    expect(reviewSheet(evil)).toContain(
      '- **C1** !\\[x\\](https://e.test/a.png) \\[ok\\](https://e.test) \\\\\\<b\\> \\`x\\`',
    );
  });
});
