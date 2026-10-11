import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../shared/types';

export function defaultSettings(): Settings {
  return { version: 1, repositories: [], preferences: { theme: 'system', fileView: 'list' } };
}
export function validateSettings(value: unknown): Settings {
  const data = value as Settings;
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.repositories) ||
    !data.preferences ||
    !['system', 'dark', 'light'].includes(data.preferences.theme) ||
    (data.preferences.fileView !== undefined && !['list', 'tree'].includes(data.preferences.fileView)) ||
    data.repositories.some(
      (repo) =>
        !repo ||
        typeof repo.path !== 'string' ||
        !path.isAbsolute(repo.path) ||
        repo.path.includes('\0') ||
        (repo.name !== undefined && typeof repo.name !== 'string'),
    ) ||
    (data.preferences.selectedRepository !== undefined &&
      typeof data.preferences.selectedRepository !== 'string')
  )
    throw new Error('Configurazione non valida.');
  return {
    version: 1,
    repositories: [
      ...new Map(
        data.repositories.map((repo) => [
          repo.path,
          { path: repo.path, ...(repo.name ? { name: repo.name } : {}) },
        ]),
      ).values(),
    ],
    preferences: {
      theme: data.preferences.theme,
      fileView: data.preferences.fileView ?? 'list',
      ...(data.preferences.selectedRepository
        ? { selectedRepository: data.preferences.selectedRepository }
        : {}),
    },
  };
}

export class SettingsStore {
  private value: Settings = defaultSettings();
  private queue: Promise<unknown> = Promise.resolve();
  warning?: string;
  constructor(public readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      this.value = validateSettings(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning = `Configurazione non leggibile. Il file è stato preservato: ${this.file}. Correggilo o spostalo e riavvia RepoPeek.`;
      }
    }
    return this.get();
  }
  get(): Settings {
    return structuredClone(this.value);
  }

  reorderRepositories(paths: unknown): Promise<Settings> {
    return this.update((current) => {
      const byPath = new Map(current.repositories.map((repo) => [repo.path, repo]));
      if (
        !Array.isArray(paths) ||
        paths.length !== current.repositories.length ||
        new Set(paths).size !== paths.length ||
        paths.some((value) => typeof value !== 'string' || !byPath.has(value))
      )
        throw new Error('La lista dei repository è cambiata. Aggiorna e riprova il riordino.');
      return { ...current, repositories: paths.map((value) => byPath.get(value)!) };
    });
  }

  update(change: (current: Settings) => Settings): Promise<Settings> {
    const task = this.queue.then(async () => {
      if (this.warning) throw new Error(this.warning);
      const next = validateSettings(change(this.get()));
      const directory = path.dirname(this.file);
      await mkdir(directory, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(next, null, 2) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.file);
        this.value = next;
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return this.get();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
