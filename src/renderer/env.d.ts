import type { RepoPeekAPI } from '../shared/types';
declare global {
  interface Window {
    repopeek: RepoPeekAPI;
  }
}
