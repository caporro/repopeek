import { contextBridge, ipcRenderer } from 'electron';
import type { RepoPeekAPI } from '../shared/types';

function subscribe(channel: string, callback: () => void) {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const api: RepoPeekAPI = {
  refresh: () => ipcRenderer.invoke('repopeek:refresh'),
  addRepositories: () => ipcRenderer.invoke('repopeek:add'),
  removeRepository: (path) => ipcRenderer.invoke('repopeek:remove', path),
  reorderRepositories: (paths) => ipcRenderer.invoke('repopeek:reorder', paths),
  renameRepository: (path, name) => ipcRenderer.invoke('repopeek:rename', path, name),
  savePreferences: (preferences) => ipcRenderer.invoke('repopeek:preferences', preferences),
  getDiff: (path, key) => ipcRenderer.invoke('repopeek:diff', path, key),
  getHistory: (path, cursor) => ipcRenderer.invoke('repopeek:history', path, cursor),
  getCommitDiff: (path, hash, key) => ipcRenderer.invoke('repopeek:commit-diff', path, hash, key),
  stage: (path, target) => ipcRenderer.invoke('repopeek:stage', path, target),
  unstage: (path, target) => ipcRenderer.invoke('repopeek:unstage', path, target),
  stageAll: (path) => ipcRenderer.invoke('repopeek:stage-all', path),
  unstageAll: (path) => ipcRenderer.invoke('repopeek:unstage-all', path),
  getLocalStatus: (path) => ipcRenderer.invoke('repopeek:local-status', path),
  commit: (path, message) => ipcRenderer.invoke('repopeek:commit', path, message),
  onRefresh: (callback) => subscribe('repopeek:refresh-requested', callback),
  onAddRepositories: (callback) => subscribe('repopeek:add-requested', callback),
};
contextBridge.exposeInMainWorld('repopeek', api);
