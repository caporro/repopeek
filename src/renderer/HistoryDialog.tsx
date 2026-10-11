import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitSummary, HistoryCursor, HistoryPage, Repository } from '../shared/types';
import { CommitRow } from './CommitRow';
export function HistoryDialog({
  repository,
  selected,
  onClose,
  onSelect,
}: {
  repository: Repository;
  selected?: string;
  onClose: () => void;
  onSelect: (commit: CommitSummary) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  const [page, setPage] = useState<HistoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    async (cursor?: HistoryCursor) => {
      const id = ++request.current;
      setLoading(true);
      setError('');
      if (!cursor) setPage(undefined);
      try {
        const result = await window.repopeek.getHistory(repository.path, cursor);
        if (id === request.current)
          setPage((old) => ({
            ...result,
            commits: cursor ? [...(old?.commits ?? []), ...result.commits] : result.commits,
          }));
      } catch (error) {
        if (id === request.current)
          setError(
            error instanceof Error
              ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
              : 'Cronologia non disponibile.',
          );
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [repository.path],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  const name = repository.name || repository.path.split('/').pop();
  return (
    <dialog
      ref={dialog}
      className="history-dialog"
      aria-labelledby="history-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <header className="history-heading">
        <div>
          <h2 id="history-title">Cronologia · {name}</h2>
          <p>Tutti i branch locali</p>
        </div>
        <button
          className="icon-button"
          aria-label="Chiudi cronologia"
          onClick={() => dialog.current?.close()}
          autoFocus
        >
          ×
        </button>
      </header>
      <div className="history-scroll" aria-busy={loading}>
        {page?.commits.map((commit) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            selected={selected === commit.hash}
            showHash
            onSelect={() => {
              dialog.current?.close();
              onSelect(commit);
            }}
          />
        ))}
        {!loading && !error && !page?.commits.length && (
          <p className="panel-message">Nessun commit nei branch locali.</p>
        )}
        {loading && (
          <div className="history-loading" role="status">
            <span className="spinner" />
            Caricamento commit…
          </div>
        )}
      </div>
      <footer className="history-footer">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button className="text-button" onClick={() => void load()}>
              Ricarica
            </button>
          </>
        ) : (
          <>
            <span>{page ? `${page.commits.length} commit` : ''}</span>
            {page?.nextCursor && (
              <button className="text-button" disabled={loading} onClick={() => void load(page.nextCursor)}>
                Carica altri commit
              </button>
            )}
          </>
        )}
      </footer>
    </dialog>
  );
}
