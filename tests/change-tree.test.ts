import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChangeTree } from '../src/shared/change-tree';
import type { Change } from '../src/shared/types';
const change = (path: string, added: number, deleted: number, unavailable = 0): Change => ({
  key: `working:${path}`,
  path,
  section: 'working',
  kind: 'modified',
  lines: { added, deleted, unavailable },
});
test('tree compacts single-directory chains and aggregates descendants once including unknown counts', () => {
  const tree = buildChangeTree([
    change('src/ui/buttons/a.ts', 5, 2),
    change('src/ui/forms/z.ts', 4, 1, 1),
    change('root.txt', 3, 0),
  ]);
  assert.equal(tree.length, 2);
  const dir = tree[0];
  assert.equal(dir.type, 'directory');
  if (dir.type !== 'directory') throw new Error();
  assert.equal(dir.name, 'src/ui');
  assert.equal(dir.path, 'src/ui');
  assert.equal(dir.first.path, 'src/ui/buttons/a.ts');
  assert.deepEqual(dir.lines, { added: 9, deleted: 3, unavailable: 1 });
  assert.deepEqual(
    dir.children.map((c) => c.name),
    ['buttons', 'forms'],
  );
  assert.equal(tree[1].name, 'root.txt');
});
