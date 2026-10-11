import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RepoPeekAPI } from '../shared/types';
function subscribe(event: string, callback: () => void) {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void listen(event, callback).then((stop) => {
    if (disposed) stop();
    else unsubscribe = stop;
  });
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
export const api: RepoPeekAPI = {
  refresh: () => invoke('refresh'),
  addRepositories: () => invoke('add_repositories'),
  removeRepository: (path) => invoke('remove_repository', { path }),
  reorderRepositories: (paths) => invoke('reorder_repositories', { paths }),
  renameRepository: (path, name) => invoke('rename_repository', { path, name }),
  savePreferences: (preferences) => invoke('save_preferences', { preferences }),
  getDiff: (path, key) => invoke('get_diff', { path, key }),
  getHistory: (path, cursor) => invoke('get_history', { path, cursor }),
  getCommitDiff: (path, hash, key) => invoke('get_commit_diff', { path, hash, key }),
  stage: (path, target) => invoke('stage', { path, target }),
  unstage: (path, target) => invoke('unstage', { path, target }),
  stageAll: (path) => invoke('stage_all', { path }),
  unstageAll: (path) => invoke('unstage_all', { path }),
  getLocalStatus: (path) => invoke('get_local_status', { path }),
  commit: (path, message) => invoke('commit', { path, message }),
  onRefresh: (callback) => subscribe('repopeek:refresh-requested', callback),
  onAddRepositories: (callback) => subscribe('repopeek:add-requested', callback),
};
window.repopeek = api;
