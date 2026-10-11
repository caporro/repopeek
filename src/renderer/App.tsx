import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppState,
  Change,
  ChangeTarget,
  CommitSummary,
  DiffResult,
  Repository,
  RepositoryOverview,
  RepositoryStatus,
  Settings,
  Theme,
} from '../shared/types';
import { RepositorySidebar } from './RepositorySidebar';
import { CommitGraph } from './CommitGraph';
import { RepositoryDetail } from './RepositoryDetail';
import type { CommitDraft } from './RepositoryDetail';
const CodeDiff = lazy(() => import('./CodeDiff').then((module) => ({ default: module.CodeDiff })));
import { Icon } from './ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
const basename = (value: string) => value.split('/').pop() || value;
const displayName = (repo: Repository) => repo.name || basename(repo.path);
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error);
type Detail = { path: string; key: string; commit?: CommitSummary };
type PendingMove = { id: number; repository: string; target?: ChangeTarget };
const containsPath = (target: ChangeTarget, path: string) =>
  target.path === path || (target.kind === 'directory' && path.startsWith(`${target.path}/`));
const overlaps = (left?: ChangeTarget, right?: ChangeTarget) =>
  !left || !right || containsPath(left, right.path) || containsPath(right, left.path);
const emptyDraft: CommitDraft = { summary: '', body: '' };

export function App() {
  const [state, setState] = useState<AppState>();
  const [activeRepository, setActiveRepository] = useState<string>();
  const [sources, setSources] = useState<Record<string, CommitSummary | undefined>>({});
  const [drafts, setDrafts] = useState<Record<string, CommitDraft>>({});
  const [detail, setDetail] = useState<Detail>();
  const [diff, setDiff] = useState<DiffResult>();
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [pendingMoves, setPendingMoves] = useState<PendingMove[]>([]);
  const [error, setError] = useState('');
  const [rename, setRename] = useState<{ repository: Repository; name: string }>();
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const refreshBusy = useRef(false),
    refreshAgain = useRef(false),
    mutationBusy = useRef(false);
  const settingsRevision = useRef(0);
  const moveRevision = useRef(0);
  const moveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingMovesRef = useRef<PendingMove[]>([]);
  const dirtyRepositories = useRef(new Set<string>());
  const knownRepositories = useRef(new Set<string>());
  knownRepositories.current = new Set(state?.settings.repositories.map((repository) => repository.path));
  const statsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const theme = state?.settings.preferences.theme ?? 'system';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const requestedPath = activeRepository ?? state?.settings.preferences.selectedRepository;
  const current =
    state?.statuses.find((status) => status.repository.path === requestedPath) ?? state?.statuses[0];
  const currentPath = current?.repository.path;
  const source =
    current && current.state !== 'unavailable'
      ? (sources[current.repository.path] ??
        (current.state === 'clean'
          ? current.commits.find((commit) => commit.hash === current.head)
          : undefined))
      : undefined;
  const visibleDetail = current?.state !== 'unavailable' && detail?.path === currentPath ? detail : undefined;
  const selected = (visibleDetail?.commit?.changes ?? current?.changes)?.find(
    (change) => change.key === visibleDetail?.key,
  );
  const refresh = useCallback(async () => {
    if (refreshBusy.current) {
      refreshAgain.current = true;
      return;
    }
    refreshBusy.current = true;
    moveRevision.current++;
    clearTimeout(statsTimer.current);
    setRefreshing(true);
    try {
      do {
        refreshAgain.current = false;
        await moveQueue.current;
        const revision = settingsRevision.current;
        const localRevision = moveRevision.current;
        const next = await window.repopeek.refresh();
        if (revision !== settingsRevision.current || localRevision !== moveRevision.current) {
          refreshAgain.current = true;
          continue;
        }
        setState(next);
        dirtyRepositories.current.clear();
        setActiveRepository((old) =>
          next.statuses.some((status) => status.repository.path === old)
            ? old
            : (next.settings.preferences.selectedRepository ?? next.statuses[0]?.repository.path),
        );
        setSources((previous) =>
          Object.fromEntries(
            next.statuses.map((status) => {
              const old = previous[status.repository.path];
              return [
                status.repository.path,
                old ? (status.commits.find((commit) => commit.hash === old.hash) ?? old) : undefined,
              ];
            }),
          ),
        );
      } while (refreshAgain.current);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      refreshBusy.current = false;
      setRefreshing(false);
    }
  }, []);
  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      if (mutationBusy.current) return false;
      mutationBusy.current = true;
      moveRevision.current++;
      setMutating(true);
      setError('');
      try {
        await moveQueue.current;
        await action();
        await refresh();
        return true;
      } catch (error) {
        setError(errorMessage(error));
        return false;
      } finally {
        mutationBusy.current = false;
        setMutating(false);
      }
    },
    [refresh],
  );
  const add = useCallback(
    () =>
      mutate(async () => {
        const result = await window.repopeek.addRepositories();
        if (result.rejected.length)
          setError(result.rejected.map((item) => `${basename(item.path)}: ${item.message}`).join('\n'));
      }),
    [mutate],
  );
  useEffect(() => {
    void refresh();
    const unsubscribe = window.repopeek.onRefresh(() => void refresh());
    const unsubscribeAdd = window.repopeek.onAddRepositories(() => void add());
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => {
      unsubscribe();
      unsubscribeAdd();
      media.removeEventListener('change', change);
    };
  }, [refresh, add]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    let active = true;
    setDiff(undefined);
    if (!visibleDetail || !selected) {
      setLoadingDiff(false);
      return;
    }
    setLoadingDiff(true);
    const request = visibleDetail.commit
      ? window.repopeek.getCommitDiff(visibleDetail.path, visibleDetail.commit.hash, selected.key)
      : window.repopeek.getDiff(visibleDetail.path, selected.key);
    void request
      .then((result) => {
        if (active) setDiff(result);
      })
      .catch((error) => {
        if (active) setDiff({ type: 'message', reason: 'unavailable', message: errorMessage(error) });
      })
      .finally(() => {
        if (active) setLoadingDiff(false);
      });
    return () => {
      active = false;
    };
  }, [
    visibleDetail?.path,
    visibleDetail?.key,
    visibleDetail?.commit?.hash,
    selected?.key,
    state?.refreshedAt,
    visibleDetail,
  ]);
  const applyLocalStatus = useCallback(
    (status: RepositoryStatus, target?: ChangeTarget | null, revision?: number) => {
      setState((old) => {
        if (!old || (revision !== undefined && revision !== moveRevision.current)) return old;
        return {
          ...old,
          statuses: old.statuses.map((previous) => {
            if (previous.repository.path !== status.repository.path) return previous;
            const invalidated = new Set(
              target
                ? previous.changes
                    .filter((change) => containsPath(target, change.path))
                    .flatMap((change) => [change.path, change.previousPath].filter(Boolean))
                : [],
            );
            return {
              ...previous,
              ...status,
              repository: previous.repository,
              head: status.head,
              error: status.error,
              statsError: status.statsError,
              changes: status.changes.map((change) => ({
                ...change,
                lines:
                  change.lines ??
                  (target !== null &&
                  !invalidated.has(change.path) &&
                  (!target || !containsPath(target, change.path))
                    ? previous.changes.find((entry) => entry.key === change.key && entry.kind === change.kind)
                        ?.lines
                    : undefined),
              })),
            };
          }),
        };
      });
    },
    [],
  );
  const scheduleStats = useCallback(
    function schedule() {
      clearTimeout(statsTimer.current);
      statsTimer.current = setTimeout(async () => {
        if (pendingMovesRef.current.length || mutationBusy.current || refreshBusy.current) {
          schedule();
          return;
        }
        const revision = moveRevision.current;
        const paths = [...dirtyRepositories.current].filter((path) => knownRepositories.current.has(path));
        dirtyRepositories.current.clear();
        await Promise.all(
          paths.map(async (path) => {
            try {
              const status = await window.repopeek.getLocalStatus(path);
              if (revision === moveRevision.current) applyLocalStatus(status, undefined, revision);
              else if (knownRepositories.current.has(path)) dirtyRepositories.current.add(path);
            } catch (error) {
              if (revision === moveRevision.current && knownRepositories.current.has(path))
                setError(errorMessage(error));
            }
          }),
        );
        if (dirtyRepositories.current.size) schedule();
      }, 350);
    },
    [applyLocalStatus],
  );
  useEffect(
    () => () => {
      clearTimeout(statsTimer.current);
      moveRevision.current++;
    },
    [],
  );
  const updateSettings = (settings: Settings) => {
    settingsRevision.current++;
    setState((old) => (old ? { ...old, settings } : old));
  };
  const setTheme = (theme: Theme) => {
    void window.repopeek
      .savePreferences({ theme })
      .then(updateSettings)
      .catch((error) => setError(errorMessage(error)));
  };
  const selectRepository = (path: string) => {
    if (path === currentPath) return;
    setActiveRepository(path);
    setDetail(undefined);
    setError('');
    void window.repopeek
      .savePreferences({ selectedRepository: path })
      .then(updateSettings)
      .catch((error) => setError(errorMessage(error)));
  };
  const selectSource = (commit?: CommitSummary) => {
    if (!currentPath) return;
    setSources((old) => ({ ...old, [currentPath]: commit }));
    setDetail(undefined);
  };
  const openDetail = (change: Change) => {
    if (!currentPath) return;
    returnFocus.current = document.activeElement as HTMLElement;
    setDetail({ path: currentPath, key: change.key, commit: source });
  };
  const moveChange = (
    status: RepositoryOverview,
    section: 'working' | 'staged',
    targetPath?: string,
    kind?: 'file' | 'directory',
  ) => {
    const path = status.repository.path;
    const target = targetPath && kind ? { path: targetPath, kind } : undefined;
    if (
      mutationBusy.current ||
      pendingMovesRef.current.some((move) => move.repository === path && overlaps(move.target, target))
    )
      return;
    const selectedPath = detail?.path === path && !detail.commit ? selected?.path : undefined;
    const affected =
      selectedPath &&
      (!targetPath ||
        selectedPath === targetPath ||
        (kind === 'directory' && selectedPath.startsWith(`${targetPath}/`)));
    const action =
      section === 'working'
        ? targetPath && kind
          ? () => window.repopeek.stage(path, { path: targetPath, kind })
          : () => window.repopeek.stageAll(path)
        : targetPath && kind
          ? () => window.repopeek.unstage(path, { path: targetPath, kind })
          : () => window.repopeek.unstageAll(path);
    const job = { id: ++moveRevision.current, repository: path, target };
    const detailKey = detail?.key;
    pendingMovesRef.current = [...pendingMovesRef.current, job];
    setPendingMoves(pendingMovesRef.current);
    clearTimeout(statsTimer.current);
    setError('');
    moveQueue.current = moveQueue.current.then(async () => {
      try {
        const next = await action();
        applyLocalStatus(next, target ?? null);
        if (affected)
          setDetail((old) =>
            old?.path === path && !old.commit && old.key === detailKey
              ? { ...old, key: `${section === 'working' ? 'staged' : 'working'}:${selectedPath}` }
              : old,
          );
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        pendingMovesRef.current = pendingMovesRef.current.filter((pending) => pending.id !== job.id);
        setPendingMoves(pendingMovesRef.current);
        dirtyRepositories.current.add(path);
        scheduleStats();
      }
    });
  };
  const createCommit = async () => {
    if (!current) return;
    const path = current.repository.path,
      draft = drafts[path] ?? emptyDraft;
    const message = draft.summary.trim() + (draft.body.trim() ? `\n\n${draft.body.trim()}` : '');
    if (await mutate(() => window.repopeek.commit(path, message))) {
      setDrafts((old) => ({ ...old, [path]: emptyDraft }));
      setDetail((old) => (old?.path === path ? undefined : old));
      setSources((old) => ({ ...old, [path]: undefined }));
    }
  };
  const back = () => {
    setDetail(undefined);
    requestAnimationFrame(
      () => returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }),
    );
  };
  const reorder = async (paths: string[]) => {
    if (mutationBusy.current || pendingMovesRef.current.length) return;
    const focused = document.activeElement as HTMLElement | null;
    mutationBusy.current = true;
    setMutating(true);
    setError('');
    try {
      const settings = await window.repopeek.reorderRepositories(paths);
      settingsRevision.current++;
      setState((old) =>
        old
          ? {
              ...old,
              settings,
              statuses: settings.repositories.flatMap((repo) =>
                old.statuses.filter((status) => status.repository.path === repo.path),
              ),
            }
          : old,
      );
    } catch (error) {
      setError(errorMessage(error));
      void refresh();
    } finally {
      mutationBusy.current = false;
      setMutating(false);
      requestAnimationFrame(() => {
        const target =
          focused instanceof HTMLButtonElement && focused.disabled
            ? focused.closest('.repo-strip')?.querySelector<HTMLElement>('.reorder-handle')
            : focused;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }
  };
  const dirtyCount = state?.statuses.filter((status) => status.state === 'dirty').length ?? 0;
  return (
    <div className="app-shell">
      <header
        className="titlebar"
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as Element).closest('button,select,input,textarea'))
            void getCurrentWindow().startDragging();
        }}
      >
        <div className="brand">
          <span className="brand-mark">
            <Icon name="branch" size={18} />
          </span>
          <strong>RepoPeek</strong>
          <span className="version">LOCAL</span>
        </div>
        <div className="titlebar-right">
          <select aria-label="Tema" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">Sistema</option>
            <option value="dark">Scuro</option>
            <option value="light">Chiaro</option>
          </select>
          <button
            className={`refresh-button ${refreshing ? 'is-refreshing' : ''}`}
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Aggiorna tutti i repository (⌘R)"
          >
            <Icon name="refresh" />
            {refreshing ? 'Aggiornamento…' : 'Aggiorna'}
            <kbd>⌘R</kbd>
          </button>
          <button className="primary-button" onClick={() => void add()} disabled={mutating}>
            <Icon name="plus" size={15} />
            Aggiungi repository
          </button>
        </div>
      </header>
      {(error || state?.warning) && (
        <div className="notice" role="alert">
          <span>{error || state?.warning}</span>
          {error && (
            <button onClick={() => setError('')} aria-label="Chiudi messaggio">
              ×
            </button>
          )}
        </div>
      )}
      {!state ? (
        <main className="empty workspace-empty">
          <span className="spinner" />
          <p>Caricamento repository…</p>
        </main>
      ) : !state.statuses.length ? (
        <main className="empty welcome workspace-empty">
          <div className="peek-symbol">
            <span>−</span>
            <span>+</span>
          </div>
          <h2>Un’occhiata ai tuoi repository.</h2>
          <p>Aggiungi le cartelle Git che vuoi tenere sotto controllo.</p>
          <button className="primary-button" disabled={mutating} onClick={() => void add()}>
            <Icon name="plus" />
            Scegli cartelle
          </button>
        </main>
      ) : (
        <main className="workspace" aria-label="Repository selezionato">
          <RepositorySidebar
            statuses={state.statuses}
            selected={currentPath}
            mutating={mutating || pendingMoves.length > 0}
            onSelect={selectRepository}
            onRename={(repository) => setRename({ repository, name: repository.name ?? '' })}
            onRemove={(path) => void mutate(() => window.repopeek.removeRepository(path))}
            reorder={reorder}
          />
          {current && (
            <>
              <div className="repository-center">
                <div className="graph-container" hidden={!!visibleDetail}>
                  <CommitGraph
                    key={current.repository.path}
                    status={current}
                    refreshedAt={state.refreshedAt}
                    selected={source}
                    onSelect={selectSource}
                    onLocal={() => selectSource()}
                  />
                </div>
                {visibleDetail && (
                  <section className="diff-panel workspace-diff" aria-label="Diff del file">
                    <div className="detail-toolbar">
                      <button className="back-button" onClick={back}>
                        <Icon name="back" />
                        Torna al grafo
                      </button>
                      <span className="readonly">
                        <Icon name="lock" size={12} />
                        SOLA LETTURA
                      </span>
                    </div>
                    <div className="diff-heading">
                      <div className="diff-filename">
                        <strong>{selected ? basename(selected.path) : 'File non disponibile'}</strong>
                        {selected && (
                          <span className="section-pill">
                            {selected.section === 'commit'
                              ? 'Commit'
                              : selected.section === 'working'
                                ? 'Working'
                                : 'Staged'}
                          </span>
                        )}
                      </div>
                      <p title={selected?.path}>
                        {selected?.previousPath
                          ? `${selected.previousPath} → ${selected.path}`
                          : selected?.path}
                      </p>
                    </div>
                    {loadingDiff ? (
                      <div className="empty">
                        <span className="spinner" />
                        <p>Caricamento diff…</p>
                      </div>
                    ) : selected && diff ? (
                      <Suspense fallback={<div className="empty">Caricamento diff…</div>}>
                        <CodeDiff result={diff} file={selected.path} dark={dark} />
                      </Suspense>
                    ) : (
                      <div className="empty">
                        <p>Il file non presenta più modifiche o non è disponibile.</p>
                        <button className="text-button" onClick={back}>
                          Torna al grafo
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </div>
              <RepositoryDetail
                key={current.repository.path}
                status={current}
                commit={source}
                selected={selected?.key}
                mutating={mutating}
                moving={pendingMoves.length > 0}
                pendingMove={(path, kind) =>
                  pendingMoves.some(
                    (move) =>
                      move.repository === current.repository.path && overlaps(move.target, { path, kind }),
                  )
                }
                draft={drafts[current.repository.path] ?? emptyDraft}
                onDraft={(draft) => setDrafts((old) => ({ ...old, [current.repository.path]: draft }))}
                onSelect={openDetail}
                onMove={(section, path, kind) => void moveChange(current, section, path, kind)}
                onMoveAll={(section) => void moveChange(current, section)}
                onCommit={() => void createCommit()}
              />
            </>
          )}
        </main>
      )}
      <footer className="statusbar">
        <span>
          {state?.statuses.length ?? 0} repository <span className="status-divider">/</span>
          {dirtyCount} con modifiche
        </span>
        <span>
          {refreshing
            ? 'Aggiornamento in corso…'
            : state
              ? `Aggiornato alle ${new Date(state.refreshedAt).toLocaleTimeString('it-IT')}`
              : ''}
        </span>
      </footer>
      {rename && (
        <div className="modal-backdrop">
          <form
            className="rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              const value = rename;
              void mutate(async () => {
                await window.repopeek.renameRepository(value.repository.path, value.name);
                setRename(undefined);
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRename(undefined);
            }}
          >
            <h2 id="rename-title">Nome del repository</h2>
            <p>Lascia vuoto per usare il nome della cartella.</p>
            <input
              autoFocus
              aria-label="Nome del repository"
              maxLength={120}
              value={rename.name}
              onChange={(e) => setRename({ ...rename, name: e.target.value })}
            />
            <div>
              <button type="button" onClick={() => setRename(undefined)}>
                Annulla
              </button>
              <button className="primary-button" disabled={mutating}>
                Salva
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
