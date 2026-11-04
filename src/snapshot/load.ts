import type { EvidenceSnapshot } from '../types.ts';
import { SNAPSHOT_SCHEMA } from '../types.ts';

/** Parse and minimally validate a serialized snapshot. */
export function loadSnapshot(input: string | unknown): EvidenceSnapshot {
  const s = (typeof input === 'string' ? JSON.parse(input) : input) as EvidenceSnapshot;
  if (!s || typeof s !== 'object' || s.schema !== SNAPSHOT_SCHEMA)
    throw new Error(`not an ${SNAPSHOT_SCHEMA} document`);
  if (!s.a11y || typeof s.page?.url !== 'string') throw new Error('snapshot is missing a11y or page');
  return s;
}
