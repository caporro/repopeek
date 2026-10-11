import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeChanges } from '../src/shared/change-summary';
import type { Change, ChangeKind, Section } from '../src/shared/types';
const change = (path: string, kind: ChangeKind, section: Section = 'working'): Change => ({
  path,
  kind,
  section,
  key: `${section}:${path}`,
});

test('repository totals deduplicate staged/working and classify new files as additions', () => {
  const changes = [
    change('existing', 'modified', 'staged'),
    change('existing', 'modified'),
    change('new', 'added', 'staged'),
    change('new', 'modified'),
    change('untracked', 'untracked'),
    change('removed', 'deleted'),
  ];
  assert.deepEqual(summarizeChanges(changes), { modified: 1, added: 2, deleted: 1 });
});
test('renames and conflicts count as modified; each path has one category', () => {
  assert.deepEqual(
    summarizeChanges([
      change('renamed', 'renamed', 'staged'),
      change('renamed', 'modified'),
      change('conflict', 'conflict'),
    ]),
    { modified: 2, added: 0, deleted: 0 },
  );
});
test('mixed staged/working deletion states preserve distinct file totals', () => {
  assert.deepEqual(
    summarizeChanges([
      change('recreated', 'deleted', 'staged'),
      change('recreated', 'untracked'),
      change('deleted', 'modified', 'staged'),
      change('deleted', 'deleted'),
      change('new', 'added', 'staged'),
      change('new', 'deleted'),
    ]),
    { modified: 1, added: 1, deleted: 1 },
  );
});
test('clean repositories have zero counts', () => {
  assert.deepEqual(summarizeChanges([]), { modified: 0, added: 0, deleted: 0 });
});
