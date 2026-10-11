import type { Change } from './types';

export interface ChangeSummary {
  modified: number;
  added: number;
  deleted: number;
}

/** One category per path across staging and working; the sum matches changedFiles. */
export function summarizeChanges(changes: Change[]): ChangeSummary {
  const byPath = new Map<string, Set<Change['kind']>>();
  for (const change of changes) {
    const kinds = byPath.get(change.path) ?? new Set<Change['kind']>();
    kinds.add(change.kind);
    byPath.set(change.path, kinds);
  }
  const summary: ChangeSummary = { modified: 0, added: 0, deleted: 0 };
  for (const kinds of byPath.values()) {
    if (kinds.has('conflict') || (kinds.has('deleted') && kinds.has('untracked'))) {
      // A staged deletion followed by a recreated file is one changed existing path.
      summary.modified++;
    } else if (kinds.has('added') || kinds.has('untracked')) {
      // A new staged file remains an addition even if edited or removed in working.
      summary.added++;
    } else if (kinds.has('deleted')) {
      summary.deleted++;
    } else {
      summary.modified++;
    }
  }
  return summary;
}
