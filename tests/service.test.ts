import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { native, SettingsStore } from './native';
import type { AddResult, AppState, Settings } from '../src/shared/types';
const exec = promisify(execFile);

test('native commands require registered repositories and validate mutation and preference input', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-service-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'),
    file = path.join(root, 'settings.json');
  await mkdir(repo);
  await exec('/usr/bin/git', ['-C', repo, 'init', '-b', 'main']);
  await writeFile(path.join(repo, 'file.txt'), 'working\n');
  const call = <T>(method: string, ...args: unknown[]) => native<T>('service', file, method, ...args);
  await assert.rejects(call('diff', repo, 'working:file.txt'), /Repository non presente/);
  const added = await call<AddResult>('add', [repo, repo]);
  assert.equal(added.settings.repositories.length, 1);
  assert.equal(added.rejected.length, 1);
  assert.equal((await call<AppState>('refresh')).statuses[0].state, 'dirty');
  for (const target of [
    { path: '../outside', kind: 'file' },
    { path: '/absolute', kind: 'file' },
    { path: 'file.txt', kind: 'other' },
    { path: 'file.txt', kind: 'file', command: 'anything' },
  ]) {
    await assert.rejects(call('stage', repo, target));
  }
  await assert.rejects(call('preferences', { theme: null }));
  await assert.rejects(call('preferences', { theme: 'dark', command: 'anything' }));
  await assert.rejects(
    call('preferences', { selectedRepository: '/unregistered' }),
    /Repository non presente/,
  );
  const settings = await call<Settings>('rename', repo, '  Native  ');
  assert.equal(settings.repositories[0].name, 'Native');
  await call('remove', repo);
  await assert.rejects(call('stage', repo, { path: 'file.txt', kind: 'file' }), /Repository non presente/);
});

test('native settings preserve invalid optional values and write private atomic files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-private-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const invalid = JSON.stringify({
    version: 1,
    repositories: [{ path: '/project', name: null }],
    preferences: { theme: 'system' },
  });
  await writeFile(file, invalid);
  const invalidStore = new SettingsStore(file);
  await invalidStore.load();
  assert.match(invalidStore.warning!, /preservato/);
  await assert.rejects(invalidStore.update((current) => current));
  assert.equal(await readFile(file, 'utf8'), invalid);
  await rm(file);
  const store = new SettingsStore(file);
  await store.load();
  await store.update((current) => ({ ...current, repositories: [{ path: '/project' }] }));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
