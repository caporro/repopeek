import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDeploymentStatus } from './native';
const exec = promisify(execFile);
async function git(root: string, ...args: string[]) {
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
        },
      },
    )
  ).stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-deployment-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-b', 'main');
  return root;
}
async function commit(root: string, name = 'Commit') {
  await git(root, 'add', '.');
  await git(root, 'commit', '--allow-empty', '-m', name);
}

test('counts four commits after a lightweight deployment tag, excludes dirty files, and detects annotated tags at HEAD', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file'), 'base\n');
  await commit(root);
  await git(root, 'tag', 'v0.2.0-full');
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'v0.2.0-full', ahead: 0 });
  for (let i = 0; i < 4; i++) await commit(root, `After ${i}`);
  await writeFile(path.join(root, 'file'), 'working\n');
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'v0.2.0-full', ahead: 4 });
  await git(root, 'tag', '-a', 'V0.3.0', '-m', 'Deployment');
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'V0.3.0', ahead: 0 });
});

test('ignores non-version tags and tags on unrelated branches and handles unborn, detached and unavailable states', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await getDeploymentStatus(root), { state: 'unborn' });
  await commit(root);
  await git(root, 'tag', 'checkpoint');
  assert.deepEqual(await getDeploymentStatus(root), { state: 'untagged' });
  await git(root, 'tag', 'v1.0');
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'checkout', '-b', 'other');
  await commit(root, 'Other branch');
  await git(root, 'tag', 'v9.0');
  await git(root, 'checkout', 'main');
  await commit(root, 'Main branch');
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'v1.0', ahead: 1 });
  await git(root, 'checkout', '--detach', base);
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'v1.0', ahead: 0 });
  assert.deepEqual(await getDeploymentStatus(root + '/missing'), { state: 'unavailable' });
});

test('merge counts include every commit after the reachable deployment tag', async (t) => {
  const root = await fixture(t);
  await commit(root);
  await git(root, 'tag', 'v1.0');
  await git(root, 'checkout', '-b', 'feature');
  await commit(root, 'Feature 1');
  await commit(root, 'Feature 2');
  await git(root, 'checkout', 'main');
  await commit(root, 'Main');
  await git(root, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const count = Number(await git(root, 'rev-list', '--count', 'v1.0..HEAD'));
  assert.equal(count, 4);
  assert.deepEqual(await getDeploymentStatus(root), { state: 'tagged', tag: 'v1.0', ahead: count });
});
