export type Section = 'staged' | 'working' | 'commit';
export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
export type FileView = 'list' | 'tree';
export type Theme = 'system' | 'dark' | 'light';

export interface Repository {
  path: string;
  name?: string;
}
export interface Preferences {
  selectedRepository?: string;
  theme: Theme;
  fileView?: FileView;
}
export interface Settings {
  version: 1;
  repositories: Repository[];
  preferences: Preferences;
}
export interface LineStats {
  added: number;
  deleted: number;
  unavailable: number;
}
export interface FileCounts {
  modified: number;
  added: number;
  deleted: number;
}
export interface Change {
  key: string;
  path: string;
  previousPath?: string;
  section: Section;
  kind: ChangeKind;
  lines?: LineStats;
  submodule?: { commitChanged: boolean; modified: boolean; untracked: boolean };
}
export interface RepositoryStatus {
  repository: Repository;
  state: 'clean' | 'dirty' | 'unavailable';
  branch: string;
  head?: string;
  changes: Change[];
  changedFiles: number;
  error?: string;
  statsError?: string;
}
export interface CommitSummary {
  hash: string;
  subject: string;
  parents: string[];
  branches: string[];
  remoteBranches: string[];
  tags: string[];
  author: string;
  authoredAt: string;
  body: string;
  files: FileCounts;
  changes: Change[];
}
export interface HistoryCursor {
  offset: number;
  revision: string;
}
export interface HistoryPage {
  commits: CommitSummary[];
  head?: string;
  nextCursor?: HistoryCursor;
}
export type DeploymentStatus =
  { state: 'tagged'; tag: string; ahead: number } | { state: 'untagged' | 'unborn' | 'unavailable' };
export interface RepositoryOverview extends RepositoryStatus {
  commits: CommitSummary[];
  deployment: DeploymentStatus;
  historyError?: string;
}
export type DiffResult =
  | {
      type: 'text';
      original: string;
      modified: string;
      originalLabel: string;
      modifiedLabel: string;
      note?: string;
    }
  | { type: 'conflict'; content: string; message: string }
  | { type: 'message'; reason: 'binary' | 'large' | 'unavailable' | 'submodule'; message: string };
export interface AppState {
  settings: Settings;
  statuses: RepositoryOverview[];
  warning?: string;
  refreshedAt: string;
}
export interface AddResult {
  settings: Settings;
  rejected: { path: string; message: string }[];
}
export type ChangeTarget = { path: string; kind: 'file' | 'directory' };
export interface RepoPeekAPI {
  refresh(): Promise<AppState>;
  addRepositories(): Promise<AddResult>;
  removeRepository(path: string): Promise<Settings>;
  reorderRepositories(paths: string[]): Promise<Settings>;
  renameRepository(path: string, name: string): Promise<Settings>;
  savePreferences(preferences: Partial<Preferences>): Promise<Settings>;
  getDiff(path: string, key: string): Promise<DiffResult>;
  getHistory(path: string, cursor?: HistoryCursor): Promise<HistoryPage>;
  getCommitDiff(path: string, hash: string, key: string): Promise<DiffResult>;
  stage(path: string, target: ChangeTarget): Promise<RepositoryStatus>;
  unstage(path: string, target: ChangeTarget): Promise<RepositoryStatus>;
  stageAll(path: string): Promise<RepositoryStatus>;
  unstageAll(path: string): Promise<RepositoryStatus>;
  getLocalStatus(path: string): Promise<RepositoryStatus>;
  commit(path: string, message: string): Promise<void>;
  onRefresh(callback: () => void): () => void;
  onAddRepositories(callback: () => void): () => void;
}
