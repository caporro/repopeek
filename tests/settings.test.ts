import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/main/settings';

test('persists repositories and preferences across reloads with serialized atomic updates', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new SettingsStore(file);
  assert.equal((await store.load()).repositories.length, 0);
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      store.update((current) => ({
        ...current,
        repositories: [...current.repositories, { path: `/project/${i}` }],
      })),
    ),
  );
  await store.update((current) => ({
    ...current,
    preferences: { theme: 'dark', selectedRepository: '/project/3' },
  }));
  const restored = new SettingsStore(file);
  assert.deepEqual(await restored.load(), store.get());
  assert.equal(restored.get().repositories.length, 15);
  assert.deepEqual(await readdir(root), ['settings.json']);
  assert(!JSON.stringify(restored.get()).includes('changes'));
});
test('preserves corrupt configuration and refuses to overwrite it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await writeFile(file, '{broken');
  const store = new SettingsStore(file);
  await store.load();
  assert.match(store.warning!, /preservato/);
  await assert.rejects(store.update((current) => current));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('failed validation does not mutate the saved state or block later saves', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new SettingsStore(file);
  await store.load();
  await assert.rejects(store.update((current) => ({ ...current, repositories: [{ path: '../bad' }] })));
  await store.update((current) => ({ ...current, repositories: [{ path: '/valid' }] }));
  assert.equal(store.get().repositories[0].path, '/valid');
});

test('old settings default to list view and tree preference survives a restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      repositories: [{ path: '/project', name: 'Project' }],
      preferences: { theme: 'dark', selectedRepository: '/project' },
    }),
  );
  const store = new SettingsStore(file);
  assert.equal((await store.load()).preferences.fileView, 'list');
  await store.update((current) => ({
    ...current,
    preferences: { ...current.preferences, fileView: 'tree' },
  }));
  const restored = await new SettingsStore(file).load();
  assert.equal(restored.preferences.fileView, 'tree');
  assert.equal(restored.preferences.selectedRepository, '/project');
  assert.equal(restored.repositories[0].name, 'Project');
  await assert.rejects(
    store.update((current) => ({
      ...current,
      preferences: { ...current.preferences, fileView: 'invalid' as 'tree' },
    })),
  );
});

test('repository ordering persists without losing names or preferences, and rejects incomplete or stale orders atomically', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'repopeek-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new SettingsStore(file);
  await store.load();
  await store.update((current) => ({
    ...current,
    repositories: [{ path: '/a', name: 'A' }, { path: '/b', name: 'B' }, { path: '/c' }],
    preferences: { theme: 'dark', selectedRepository: '/b' },
  }));
  const result = await store.reorderRepositories(['/c', '/a', '/b']);
  assert.deepEqual(result.repositories, [
    { path: '/c' },
    { path: '/a', name: 'A' },
    { path: '/b', name: 'B' },
  ]);
  assert.equal(result.preferences.selectedRepository, '/b');
  assert.deepEqual(await new SettingsStore(file).load(), result);
  for (const bad of [['/a', '/a', '/c'], ['/a', '/b'], ['/a', '/b', '/other'], [1, '/a', '/c'], null]) {
    await assert.rejects(store.reorderRepositories(bad), /lista dei repository è cambiata/);
    assert.deepEqual(store.get(), result);
  }
  const add = store.update((current) => ({
    ...current,
    repositories: [...current.repositories, { path: '/d' }],
  }));
  const reorder = store.reorderRepositories(['/a', '/b', '/c']);
  await add;
  await assert.rejects(reorder, /lista dei repository è cambiata/);
  assert.deepEqual(
    store.get().repositories.map((r) => r.path),
    ['/c', '/a', '/b', '/d'],
  );
  assert.deepEqual((await new SettingsStore(file).load()).repositories, store.get().repositories);
});
