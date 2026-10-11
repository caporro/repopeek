import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getOverview, getHistory, getHistoryPage, getCommitDiff, parseNumstat } from './native';
const exec = promisify(execFile);
let tick = 0;
async function git(root: string, ...args: string[]) {
  const date = `${1700000000 + tick++} +0000`;
  return (
    await exec(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-C',
        root,
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@localhost',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@localhost',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    )
  ).stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-b', 'main');
  return root;
}
async function commit(root: string, subject: string) {
  await git(root, 'add', '.');
  await git(root, 'commit', '--allow-empty', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}

test('reads local and remote branch history; refs decorate exact commits and HEAD is identified', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'base\n');
  const base = await commit(root, 'Base');
  await git(root, 'checkout', '-b', 'remote-source');
  const remote = await commit(root, 'Remote only');
  await git(root, 'update-ref', 'refs/remotes/origin/remote', remote);
  await git(root, 'checkout', 'main');
  await git(root, 'branch', '-D', 'remote-source');
  for (let i = 0; i < 5; i++) await commit(root, `Main ${i}`);
  const main = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'checkout', '-b', 'feature/local', base);
  await writeFile(path.join(root, 'feature.txt'), 'feature\n');
  const feature = await commit(root, 'Feature');
  await git(root, 'tag', '-a', 'v1.0', '-m', 'Version', feature);
  await git(root, 'tag', 'preview', feature);
  await git(root, 'checkout', 'main');
  const history = await getHistory(root);
  assert.equal(history.length, 5);
  assert.equal(history[0].hash, feature);
  assert(!history.some((c) => c.hash === remote));
  assert.deepEqual(history[0].branches, ['feature/local']);
  assert.deepEqual(history[0].tags.sort(), ['preview', 'v1.0']);
  assert.equal(history[0].author, 'Test');
  assert.match(history[0].authoredAt, /^\d{4}-/);
  assert.deepEqual(history.find((c) => c.hash === main)?.branches, ['main']);
  assert(history.filter((c) => c.hash !== main && c.hash !== feature).every((c) => c.branches.length === 0));
  assert.deepEqual(history[0].files, { modified: 0, added: 1, deleted: 0 });
  const page = await getHistoryPage({ path: root });
  assert.equal(page.head, main);
  assert.deepEqual(page.commits.find((c) => c.hash === remote)?.remoteBranches, ['origin/remote']);
  await git(root, 'checkout', '--detach', base);
  const overview = await getOverview({ path: root });
  assert.equal(overview.head, base);
  assert(overview.commits.some((c) => c.hash === base));
});

test('root commits, historical blobs, renames with tabs/newlines, additions and deletions have correct counts', async (t) => {
  const root = await fixture(t),
    old = 'old\tname.txt',
    next = 'folder/new\nname.txt';
  await writeFile(path.join(root, old), 'one\ntwo\nthree\nfour\n');
  await writeFile(path.join(root, 'removed.txt'), 'gone\n');
  const initial = await commit(root, 'Initial');
  let history = await getHistory(root);
  assert.deepEqual(history[0].files, { modified: 0, added: 2, deleted: 0 });
  const initialDiff = await getCommitDiff({ path: root }, initial, `commit:${initial}:${old}`);
  assert.equal(initialDiff.type, 'text');
  if (initialDiff.type === 'text') {
    assert.equal(initialDiff.original, '');
    assert.equal(initialDiff.modified, 'one\ntwo\nthree\nfour\n');
  }
  await mkdir(path.join(root, 'folder'));
  await git(root, 'mv', old, next);
  await writeFile(path.join(root, next), 'one\ntwo\nthree\nfour\nfive\n');
  await rm(path.join(root, 'removed.txt'));
  await writeFile(path.join(root, 'added.txt'), 'added\n');
  const hash = await commit(root, 'Rename and edit');
  await writeFile(path.join(root, next), 'working content is irrelevant\n');
  history = await getHistory(root);
  assert.deepEqual(history[0].files, { modified: 1, added: 1, deleted: 1 });
  const changed = history[0].changes.find((c) => c.path === next)!;
  assert.equal(changed.previousPath, old);
  assert.deepEqual(changed.lines, { added: 1, deleted: 0, unavailable: 0 });
  const diff = await getCommitDiff({ path: root }, hash, changed.key);
  assert.equal(diff.type, 'text');
  if (diff.type === 'text') {
    assert.equal(diff.original, 'one\ntwo\nthree\nfour\n');
    assert.equal(diff.modified, 'one\ntwo\nthree\nfour\nfive\n');
  }
  const deleted = await getCommitDiff({ path: root }, hash, `commit:${hash}:removed.txt`);
  assert.equal(deleted.type, 'text');
  if (deleted.type === 'text') {
    assert.equal(deleted.original, 'gone\n');
    assert.equal(deleted.modified, '');
  }
});

test('merge counts and preview compare only to first parent', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'base'), 'base\n');
  await commit(root, 'Base');
  await git(root, 'checkout', '-b', 'feature');
  await writeFile(path.join(root, 'feature'), 'feature\n');
  await commit(root, 'Feature');
  await git(root, 'checkout', 'main');
  await writeFile(path.join(root, 'main'), 'main\n');
  const parent = await commit(root, 'Main');
  await git(root, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const [merge] = await getHistory(root);
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.parents[0], parent);
  assert.deepEqual(merge.files, { modified: 0, added: 1, deleted: 0 });
  assert.equal(merge.changes[0].path, 'feature');
  const diff = await getCommitDiff({ path: root }, merge.hash, merge.changes[0].key);
  assert.equal(diff.type, 'text');
  if (diff.type === 'text') {
    assert.equal(diff.original, '');
    assert.equal(diff.modified, 'feature\n');
    assert.match(diff.note!, /primo genitore/);
  }
});

test('local line counts separate staged/working, count untracked text and preserve unavailable binary/conflict counts', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.txt'), 'one\ntwo\n');
  await writeFile(path.join(root, 'mode.sh'), 'echo hello\n');
  await commit(root, 'Base');
  await writeFile(path.join(root, 'src/a.txt'), 'one\nnew\n');
  await git(root, 'add', '.');
  await writeFile(path.join(root, 'src/a.txt'), 'one\nnew\nthree\n');
  await writeFile(path.join(root, 'src/untracked'), 'a\nb');
  await writeFile(path.join(root, 'empty'), '');
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, '.gitattributes'), 'marked -diff\n');
  await writeFile(path.join(root, 'marked'), 'text\n');
  await chmod(path.join(root, 'mode.sh'), 0o755);
  const overview = await getOverview({ path: root });
  assert.equal(overview.statsError, undefined);
  assert.equal(overview.historyError, undefined);
  const stats = (key: string) => overview.changes.find((c) => c.key === key)?.lines;
  assert.deepEqual(stats('staged:src/a.txt'), { added: 1, deleted: 1, unavailable: 0 });
  assert.deepEqual(stats('working:src/a.txt'), { added: 1, deleted: 0, unavailable: 0 });
  assert.deepEqual(stats('working:src/untracked'), { added: 2, deleted: 0, unavailable: 0 });
  assert.deepEqual(stats('working:empty'), { added: 0, deleted: 0, unavailable: 0 });
  assert.deepEqual(stats('working:mode.sh'), { added: 0, deleted: 0, unavailable: 0 });
  assert.equal(stats('working:binary')?.unavailable, 1);
  assert.equal(stats('working:marked')?.unavailable, 1);
});

test('unborn and detached HEAD repositories remain usable; invalid commit requests are rejected', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'new'), 'first\n');
  await git(root, 'add', '.');
  let overview = await getOverview({ path: root });
  assert.equal(overview.historyError, undefined);
  assert.deepEqual(overview.commits, []);
  assert.deepEqual(overview.changes[0].lines, { added: 1, deleted: 0, unavailable: 0 });
  const hash = await commit(root, 'Base');
  const invalid = await getCommitDiff({ path: root }, '--help', 'anything');
  assert.equal(invalid.type, 'message');
  assert.equal((await getCommitDiff({ path: root }, hash, `commit:${hash}:../outside`)).type, 'message');
  await git(root, 'checkout', '--detach');
  await git(root, 'branch', '-D', 'main');
  assert.equal((await getCommitDiff({ path: root }, hash, `commit:${hash}:new`)).type, 'text');
  overview = await getOverview({ path: root });
  assert.equal(overview.head, hash);
  assert.equal(overview.commits[0].hash, hash);
});

test('NUL numstat handles rename paths, special characters and binary entries', async () => {
  const stats = await parseNumstat(
    Buffer.from('1\t2\tfile\twith\nspaces\0' + '3\t4\t\0old\nname\0new\tname\0-\t-\tbinary\0'),
  );
  assert.deepEqual(stats.get('file\twith\nspaces'), { added: 1, deleted: 2, unavailable: 0 });
  assert.deepEqual(stats.get('new\tname'), { added: 3, deleted: 4, unavailable: 0 });
  assert.equal(stats.get('binary')?.unavailable, 1);
});

test('history pages include older local commits without gaps and reject paging after local refs change', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'base\n');
  const first = await commit(root, 'Initial');
  for (let i = 1; i <= 23; i++) await commit(root, `Commit ${i}`);
  const page1 = await getHistoryPage({ path: root });
  assert.equal(page1.commits.length, 20);
  assert(page1.nextCursor);
  assert.deepEqual(
    (await getHistory(root)).map((c) => c.hash),
    page1.commits.slice(0, 5).map((c) => c.hash),
  );
  const page2 = await getHistoryPage({ path: root }, page1.nextCursor);
  assert.equal(page2.commits.length, 4);
  assert.equal(page2.nextCursor, undefined);
  assert.equal(page2.commits.at(-1)?.hash, first);
  assert.equal(new Set([...page1.commits, ...page2.commits].map((c) => c.hash)).size, 24);
  await git(root, 'branch', 'another', first);
  await assert.rejects(getHistoryPage({ path: root }, page1.nextCursor), /cronologia è cambiata/);
  await assert.rejects(
    getHistoryPage({ path: root }, { offset: -1, revision: page1.nextCursor.revision }),
    /non valida/,
  );
  await assert.rejects(getHistoryPage({ path: root }, { offset: 1, revision: '--all' }), /non valida/);
  const refreshed = await getHistoryPage({ path: root });
  assert.equal(refreshed.commits.length, 20);
  assert.notEqual(refreshed.nextCursor?.revision, page1.nextCursor.revision);
});

test('remote-only commit previews, full messages and cursor invalidation after remote/tag changes', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'base\n');
  await commit(root, 'Base');
  for (let i = 0; i < 21; i++) await commit(root, `Change ${i}`);
  await git(root, 'checkout', '-b', 'remote-source');
  await writeFile(path.join(root, 'remote.txt'), 'remote version\n');
  const remote = await commit(root, 'Remote subject\n\nFull description\nSecond line');
  await git(root, 'update-ref', 'refs/remotes/origin/feature', remote);
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature');
  await git(root, 'checkout', 'main');
  await git(root, 'branch', '-D', 'remote-source');
  const page = await getHistoryPage({ path: root });
  const entry = page.commits.find((c) => c.hash === remote)!;
  assert.deepEqual(entry.branches, []);
  assert.deepEqual(entry.remoteBranches, ['origin/feature']);
  assert.equal(entry.subject, 'Remote subject');
  assert.equal(entry.body, 'Full description\nSecond line');
  const preview = await getCommitDiff({ path: root }, remote, entry.changes[0].key);
  assert.equal(preview.type, 'text');
  if (preview.type === 'text') assert.equal(preview.modified, 'remote version\n');
  await git(root, 'tag', 'preview', remote);
  await assert.rejects(getHistoryPage({ path: root }, page.nextCursor), /cronologia è cambiata/);
  const updated = await getHistoryPage({ path: root });
  await git(root, 'update-ref', 'refs/remotes/origin/feature', 'main');
  await assert.rejects(getHistoryPage({ path: root }, updated.nextCursor), /cronologia è cambiata/);
  assert.equal((await getCommitDiff({ path: root }, remote, entry.changes[0].key)).type, 'message');
});
