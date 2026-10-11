import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  ChangeTarget,
  CommitSummary,
  DeploymentStatus,
  DiffResult,
  HistoryCursor,
  HistoryPage,
  LineStats,
  Repository,
  RepositoryOverview,
  RepositoryStatus,
  Settings,
} from '../src/shared/types';

const executable =
  process.env.REPOPEEK_TEST_DRIVER ?? path.resolve('src-tauri/target/debug/repopeek-test-driver');
export function native<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(Buffer.concat(output).toString());
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch {
        reject(
          new Error(Buffer.concat(errors).toString() || 'Driver Rust non disponibile: esegui npm test.'),
        );
      }
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ method, args }));
  });
}
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const resolveRepository = (path: string) => native<string>('resolveRepository', path);
export const getStatus = (repository: Repository) => native<RepositoryStatus>('getStatus', repository);
export const getDiff = (repository: Repository, key: string) =>
  native<DiffResult>('getDiff', repository, key);
export const stage = (repository: Repository, target?: ChangeTarget) =>
  native<void>('stage', repository, target);
export const unstage = (repository: Repository, target?: ChangeTarget) =>
  native<void>('unstage', repository, target);
export const commitStaged = (repository: Repository, message: string) =>
  native<void>('commitStaged', repository, message);
export const getOverview = (repository: Repository) => native<RepositoryOverview>('getOverview', repository);
export const getLocalStatus = (repository: Repository) =>
  native<RepositoryStatus>('getLocalStatus', repository);
export const getHistory = (path: string) => native<CommitSummary[]>('getHistory', path);
export const getHistoryPage = (repository: Repository, cursor?: HistoryCursor) =>
  native<HistoryPage>('getHistoryPage', repository, cursor);
export const getCommitDiff = (repository: Repository, hash: string, key: string) =>
  native<DiffResult>('getCommitDiff', repository, hash, key);
export const getDeploymentStatus = (path: string) => native<DeploymentStatus>('getDeploymentStatus', path);
export const parseNumstat = async (output: Buffer) =>
  new Map(Object.entries(await native<Record<string, LineStats>>('parseNumstat', output.toString())));

// Adapter keeps existing settings scenarios unchanged; validation and disk writes happen in Rust.
export class SettingsStore {
  private value!: Settings;
  private queue: Promise<unknown> = Promise.resolve();
  warning?: string;
  constructor(readonly file: string) {}
  async load() {
    const result = await native<{ settings: Settings; warning?: string }>('settingsLoad', this.file);
    this.value = result.settings;
    this.warning = result.warning;
    return this.get();
  }
  get() {
    return structuredClone(this.value);
  }
  update(change: (settings: Settings) => Settings) {
    const task = this.queue.then(async () => {
      this.value = await native<Settings>('settingsUpdate', this.file, change(this.get()));
      return this.get();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  reorderRepositories(paths: unknown) {
    const task = this.queue.then(async () => {
      this.value = await native<Settings>('settingsReorder', this.file, paths);
      return this.get();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
