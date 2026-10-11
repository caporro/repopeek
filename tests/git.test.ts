import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  readdir,
  stat,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import {
  commitStaged,
  getStatus,
  getDiff,
  resolveRepository,
  stage,
  unstage,
  MAX_FILE_BYTES,
} from './native';
import { getOverview, getCommitDiff, getHistoryPage } from './native';
const exec = promisify(execFile);
const testEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'RepoPeek Test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'RepoPeek Test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
};
async function git(root: string, ...args: string[]) {
  return (
    await exec(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args],
      { env: testEnv },
    )
  ).stdout;
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'RepoPeek Test');
  await git(root, 'config', 'user.email', 'test@localhost');
  return root;
}
async function commit(root: string) {
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'Fixture');
}
async function textDiff(root: string, key: string) {
  const diff = await getDiff({ path: root }, key);
  assert.equal(diff.type, 'text', JSON.stringify(diff));
  if (diff.type !== 'text') throw new Error();
  return diff;
}

test('distinguishes HEAD/index/working and counts a doubly modified file once', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'const n = 1;\n');
  await commit(root);
  await writeFile(path.join(root, 'file.ts'), 'const n = 2;\n');
  await git(root, 'add', 'file.ts');
  await writeFile(path.join(root, 'file.ts'), 'const n = 3;\n');
  const status = await getStatus({ path: root });
  assert.equal(status.branch, 'main');
  assert.equal(status.changedFiles, 1);
  assert.equal(status.changes.length, 2);
  const staged = await textDiff(root, 'staged:file.ts');
  assert.equal(staged.original, 'const n = 1;\n');
  assert.equal(staged.modified, 'const n = 2;\n');
  const working = await textDiff(root, 'working:file.ts');
  assert.equal(working.original, 'const n = 2;\n');
  assert.equal(working.modified, 'const n = 3;\n');
});
test('supports unborn branches, added files, untracked directories, ignored files', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.gitignore'), '*.ignored\n');
  await writeFile(path.join(root, 'a.ignored'), 'hidden');
  await mkdir(path.join(root, 'new'));
  await writeFile(path.join(root, 'new/file.txt'), 'new');
  await writeFile(path.join(root, 'staged.txt'), 'added');
  await git(root, 'add', 'staged.txt');
  const status = await getStatus({ path: root });
  assert.equal(status.branch, 'main');
  assert(!status.changes.some((c) => c.path === 'a.ignored'));
  assert.equal(status.changes.find((c) => c.path === 'new/file.txt')?.kind, 'untracked');
  assert.equal((await textDiff(root, 'staged:staged.txt')).original, '');
  assert.equal((await textDiff(root, 'working:new/file.txt')).modified, 'new');
});
test('supports staged renames with spaces, tabs, newlines and subsequent working edits', async (t) => {
  const root = await fixture(t);
  const old = 'old name\tfile.txt';
  const next = 'nuovo\nfile.txt';
  await writeFile(path.join(root, old), 'original\n');
  await commit(root);
  await git(root, 'mv', old, next);
  await writeFile(path.join(root, next), 'working\n');
  const status = await getStatus({ path: root });
  assert.equal(status.changedFiles, 1);
  assert.equal(status.changes.find((c) => c.section === 'staged')?.previousPath, old);
  assert.equal((await textDiff(root, `staged:${next}`)).original, 'original\n');
  const working = await textDiff(root, `working:${next}`);
  assert.equal(working.original, 'original\n');
  assert.equal(working.modified, 'working\n');
});
test('uses literal filenames for Git pathspec characters', async (t) => {
  const root = await fixture(t);
  const file = ':(glob)*.txt';
  await writeFile(path.join(root, file), 'old');
  await commit(root);
  await writeFile(path.join(root, file), 'new');
  const diff = await textDiff(root, `working:${file}`);
  assert.equal(diff.original, 'old');
  assert.equal(diff.modified, 'new');
});
test('handles working and staged deletion, including deleted then recreated paths', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'gone'), 'old');
  await commit(root);
  await rm(path.join(root, 'gone'));
  assert.equal((await textDiff(root, 'working:gone')).modified, '');
  await git(root, 'add', '-u');
  assert.equal((await textDiff(root, 'staged:gone')).original, 'old');
  await writeFile(path.join(root, 'gone'), 'reborn');
  const status = await getStatus({ path: root });
  assert.equal(status.changedFiles, 1);
  assert.equal(status.changes.length, 2);
  assert.equal((await textDiff(root, 'working:gone')).original, '');
});
test('handles binary, invalid UTF-8, attributes and large files in every version', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'big'), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await commit(root);
  await writeFile(path.join(root, 'big'), 'small');
  assert.equal((await getDiff({ path: root }, 'working:big')).type, 'message');
  await git(root, 'add', 'big');
  assert.deepEqual(await getDiff({ path: root }, 'staged:big'), {
    type: 'message',
    reason: 'large',
    message: 'File troppo grande: la diff è disponibile fino a 2 MiB per versione.',
  });
  await writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66]));
  await writeFile(path.join(root, 'encoding'), Buffer.from([255, 254, 65]));
  await writeFile(path.join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1, 66));
  await writeFile(path.join(root, '.gitattributes'), 'marked -diff\n');
  await writeFile(path.join(root, 'marked'), 'text');
  for (const file of ['binary', 'encoding', 'marked', 'large']) {
    const diff = await getDiff({ path: root }, `working:${file}`);
    assert.equal(diff.type, 'message');
    if (diff.type === 'message') assert.equal(diff.reason, file === 'large' ? 'large' : 'binary');
  }
});
test('shows mode-only changes and reads symlink targets without following them', async (t) => {
  const root = await fixture(t);
  await symlink('/etc/passwd', path.join(root, 'link'));
  await commit(root);
  await rm(path.join(root, 'link'));
  await symlink('/etc/hosts', path.join(root, 'link'));
  const diff = await textDiff(root, 'working:link');
  assert.equal(diff.original, '/etc/passwd');
  assert.equal(diff.modified, '/etc/hosts');
  await writeFile(path.join(root, 'script'), 'echo ok');
  await commit(root);
  await git(root, 'update-index', '--chmod=+x', 'script');
  assert.match((await textDiff(root, 'staged:script')).note!, /Contenuto invariato/);
});
test('shows conflicts exactly once in working changes with actual conflict content', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'conflict'), 'base\n');
  await commit(root);
  await git(root, 'checkout', '-b', 'other');
  await writeFile(path.join(root, 'conflict'), 'other\n');
  await commit(root);
  await git(root, 'checkout', 'main');
  await writeFile(path.join(root, 'conflict'), 'main\n');
  await commit(root);
  await assert.rejects(git(root, 'merge', 'other'));
  const status = await getStatus({ path: root });
  assert.equal(status.changes.length, 1);
  assert.equal(status.changes[0].section, 'working');
  assert.equal(status.changes[0].kind, 'conflict');
  assert.equal((await getOverview({ path: root })).changes[0].lines?.unavailable, 1);
  const diff = await getDiff({ path: root }, 'working:conflict');
  assert.equal(diff.type, 'conflict');
  if (diff.type === 'conflict') assert.match(diff.content, /<<<<<<< HEAD/);
});
test('supports linked worktrees, detached HEAD, canonical paths and unavailable repositories', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'base');
  await commit(root);
  const linked = `${root}-linked`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await git(root, 'worktree', 'add', '--detach', linked);
  assert.equal(await resolveRepository(linked), linked);
  assert.match((await getStatus({ path: linked })).branch, /^Detached/);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  assert.equal(await resolveRepository(alias), root);
  assert.equal((await getStatus({ path: root + '/missing' })).state, 'unavailable');
  await assert.rejects(resolveRepository(path.dirname(root)));
});
test('shows submodule internal changes as one item without exposing inner files', async (t) => {
  const root = await fixture(t);
  const source = await fixture(t);
  await writeFile(path.join(source, 'inner'), 'first');
  await commit(source);
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'module');
  await commit(root);
  await writeFile(path.join(root, 'module/inner'), 'modified');
  const status = await getStatus({ path: root });
  assert.equal(status.changedFiles, 1);
  assert.equal(status.changes[0].path, 'module');
  assert(status.changes[0].submodule?.modified);
  assert.equal((await getOverview({ path: root })).changes[0].lines?.unavailable, 1);
  const diff = await getDiff({ path: root }, 'working:module');
  assert.equal(diff.type, 'message');
  if (diff.type === 'message') assert.equal(diff.reason, 'submodule');
});
test('stages and unstages files or complete folders', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'old a\n');
  await writeFile(path.join(root, 'outside.ts'), 'old outside\n');
  await commit(root);
  await writeFile(path.join(root, 'src/a.ts'), 'new a\n');
  await writeFile(path.join(root, 'src/new.ts'), 'new file\n');
  await writeFile(path.join(root, 'outside.ts'), 'new outside\n');

  await stage({ path: root }, { path: 'src', kind: 'directory' });
  let status = await getStatus({ path: root });
  assert.deepEqual(
    status.changes
      .filter((change) => change.section === 'staged')
      .map((change) => change.path)
      .sort(),
    ['src/a.ts', 'src/new.ts'],
  );
  assert.deepEqual(
    status.changes.filter((change) => change.section === 'working').map((change) => change.path),
    ['outside.ts'],
  );

  await unstage({ path: root }, { path: 'src', kind: 'directory' });
  status = await getStatus({ path: root });
  assert.equal(status.changes.filter((change) => change.section === 'staged').length, 0);
  assert.deepEqual(
    status.changes
      .filter((change) => change.section === 'working')
      .map((change) => change.path)
      .sort(),
    ['outside.ts', 'src/a.ts', 'src/new.ts'],
  );
});
test('unstages a new file before the first commit without touching its contents', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'first.txt'), 'preserved\n');
  await stage({ path: root }, { path: 'first.txt', kind: 'file' });
  assert.equal((await getStatus({ path: root })).changes[0].section, 'staged');
  await unstage({ path: root }, { path: 'first.txt', kind: 'file' });
  const status = await getStatus({ path: root });
  assert.equal(status.changes[0].section, 'working');
  assert.equal(status.changes[0].kind, 'untracked');
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'preserved\n');
});
test('commits only staged changes with the supplied message', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'staged.txt'), 'old staged\n');
  await writeFile(path.join(root, 'working.txt'), 'old working\n');
  await commit(root);
  await writeFile(path.join(root, 'staged.txt'), 'new staged\n');
  await writeFile(path.join(root, 'working.txt'), 'new working\n');
  await stage({ path: root }, { path: 'staged.txt', kind: 'file' });
  await commitStaged({ path: root }, 'Commit from RepoPeek');

  assert.equal((await git(root, 'log', '-1', '--format=%s')).trim(), 'Commit from RepoPeek');
  assert.equal((await git(root, 'show', 'HEAD:staged.txt')).toString(), 'new staged\n');
  assert.equal((await git(root, 'show', 'HEAD:working.txt')).toString(), 'old working\n');
  const status = await getStatus({ path: root });
  assert.deepEqual(
    status.changes.map((change) => `${change.section}:${change.path}`),
    ['working:working.txt'],
  );
});
async function fingerprint(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprint(root, file));
    else if (entry.isFile()) {
      const info = await stat(path.join(root, file));
      result[file] = `${info.mtimeMs}:${createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex')}`;
    }
  }
  return result;
}
test('status and diff leave Git index, refs, metadata and worktree unchanged; external helpers never run', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'original');
  await commit(root);
  await writeFile(path.join(root, 'file'), 'staged');
  await git(root, 'add', 'file');
  await writeFile(path.join(root, 'file'), 'working');
  const helper = path.join(root, 'helper.sh');
  await writeFile(helper, '#!/bin/sh\ntouch "' + root + '/HELPER_EXECUTED"\n', { mode: 0o755 });
  await git(root, 'config', 'core.fsmonitor', helper);
  await git(root, 'config', 'diff.external', helper);
  await git(root, 'config', 'diff.custom.textconv', helper);
  await writeFile(path.join(root, '.gitattributes'), 'file diff=custom\n');
  const before = await fingerprint(root);
  for (let i = 0; i < 2; i++) {
    await getStatus({ path: root });
    await textDiff(root, 'staged:file');
    await textDiff(root, 'working:file');
    const overview = await getOverview({ path: root });
    assert.equal(overview.historyError, undefined);
    assert.equal(overview.statsError, undefined);
    assert.equal(overview.deployment.state, 'untagged');
    await getHistoryPage({ path: root });
    const commit = overview.commits[0];
    assert.equal((await getCommitDiff({ path: root }, commit.hash, commit.changes[0].key)).type, 'text');
  }
  assert.deepEqual(await fingerprint(root), before);
});
test('a disappeared change returns an explicit stale-state message', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'original');
  await commit(root);
  const result = await getDiff({ path: root }, 'working:file');
  assert.equal(result.type, 'message');
  if (result.type === 'message') assert.equal(result.reason, 'unavailable');
});

test('bulk stage/unstage preserves ignored files, deletions, literal names and working contents', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'tracked.txt'), 'original\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await commit(root);
  await rm(path.join(root, 'tracked.txt'));
  await writeFile(path.join(root, 'literal[1].txt'), 'literal content\n');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored content\n');
  await stage({ path: root });
  let status = await getStatus({ path: root });
  assert(status.changes.every((change) => change.section === 'staged'));
  assert.equal(status.changes.length, 2);
  await writeFile(path.join(root, 'literal[1].txt'), 'newer working content\n');
  await unstage({ path: root });
  status = await getStatus({ path: root });
  assert(status.changes.every((change) => change.section === 'working'));
  assert.equal(status.changes.length, 2);
  assert.equal(await readFile(path.join(root, 'literal[1].txt'), 'utf8'), 'newer working content\n');
  assert.equal(await readFile(path.join(root, 'ignored.txt'), 'utf8'), 'ignored content\n');
  await assert.rejects(unstage({ path: root }));
});

test('bulk unstage before the first commit preserves all file contents', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'first.txt'), 'first\n');
  await writeFile(path.join(root, 'src/second.txt'), 'second\n');
  await stage({ path: root });
  assert.equal(
    (await getStatus({ path: root })).changes.filter((change) => change.section === 'staged').length,
    2,
  );
  await unstage({ path: root });
  const status = await getStatus({ path: root });
  assert.equal(status.changes.length, 2);
  assert(status.changes.every((change) => change.kind === 'untracked' && change.section === 'working'));
  assert.equal(await readFile(path.join(root, 'src/second.txt'), 'utf8'), 'second\n');
});
