import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CommitSummary, HistoryCursor, HistoryPage, RepositoryOverview } from '../shared/types';
import { buildCommitGraph } from '../shared/commit-graph';
import type { GraphRow } from '../shared/commit-graph';
import { summarizeChanges } from '../shared/change-summary';
import { FileCounters, Icon } from './ui';

const colors = ['#25a8bd', '#5d8cf0', '#be67db', '#e3a452', '#dc6b92', '#53b799', '#aa87e8'];
const ROW_HEIGHT = 28;
const laneX = (column: number) => 18 + column * 22;

export function CommitRefs({
  commit,
  head,
  all = false,
}: {
  commit: CommitSummary;
  head?: string;
  all?: boolean;
}) {
  const refs = [
    ...commit.branches.map((name) => ({ name, type: 'branch' as const })),
    ...commit.tags.map((name) => ({ name, type: 'tag' as const })),
    ...commit.remoteBranches.map((name) => ({ name, type: 'remote' as const })),
  ];
  return (
    <span className={`graph-refs ${all ? 'all-refs' : ''}`} title={refs.map((ref) => ref.name).join('\n')}>
      {head === commit.hash && (
        <span className="head-badge" title="HEAD">
          ●
        </span>
      )}
      {(all ? refs : refs.slice(0, 1)).map((ref) => (
        <span
          className={`ref-badge ${ref.type}`}
          key={`${ref.type}:${ref.name}`}
          title={`${ref.type === 'remote' ? 'Branch remoto' : ref.type === 'tag' ? 'Tag' : 'Branch locale'} ${ref.name}`}
        >
          <Icon name={ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'remote' : 'branch'} size={12} />
          <span>{ref.name}</span>
        </span>
      ))}
      {!all && refs.length > 1 && <span className="ref-more">+{refs.length - 1}</span>}
    </span>
  );
}

function GraphNode({ row, width, pending }: { row: GraphRow; width: number; pending?: boolean }) {
  return (
    <svg className="graph-lanes" width={width} height={ROW_HEIGHT} aria-hidden="true">
      {row.edges.map((edge, index) => {
        const x1 = laneX(edge.from),
          x2 = laneX(edge.to);
        const y1 = edge.start === 'top' ? 0 : ROW_HEIGHT / 2;
        const y2 = edge.end === 'node' ? ROW_HEIGHT / 2 : ROW_HEIGHT;
        const middle = (y1 + y2) / 2;
        return (
          <path
            key={index}
            d={`M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`}
            fill="none"
            stroke={colors[edge.color % colors.length]}
            strokeWidth="2"
          />
        );
      })}
      <circle
        cx={laneX(row.column)}
        cy={ROW_HEIGHT / 2}
        r={pending ? 7 : 5}
        fill={pending ? 'var(--panel)' : colors[row.color % colors.length]}
        stroke={colors[row.color % colors.length]}
        strokeWidth={pending ? 2 : 0}
        strokeDasharray={pending ? '3 2' : undefined}
      />
      {!pending && <circle cx={laneX(row.column)} cy={ROW_HEIGHT / 2} r="2" fill="var(--panel)" />}
    </svg>
  );
}

export function CommitGraph({
  status,
  refreshedAt,
  selected,
  onSelect,
  onLocal,
}: {
  status: RepositoryOverview;
  refreshedAt: string;
  selected?: CommitSummary;
  onSelect: (commit: CommitSummary) => void;
  onLocal: () => void;
}) {
  const [page, setPage] = useState<HistoryPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const busy = useRef(false);
  const currentPage = useRef<HistoryPage | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (cursor?: HistoryCursor) => {
      if (cursor && busy.current) return;
      const id = ++request.current;
      busy.current = true;
      setLoading(true);
      setError('');
      const previousCount = currentPage.current?.commits.length ?? 0;
      try {
        let result = await window.repopeek.getHistory(status.repository.path, cursor);
        if (cursor)
          result = { ...result, commits: [...(currentPage.current?.commits ?? []), ...result.commits] };
        else {
          // Refresh the visible history without dropping already loaded pages or its scroll position.
          while (result.nextCursor && result.commits.length < previousCount && id === request.current) {
            const next = await window.repopeek.getHistory(status.repository.path, result.nextCursor);
            result = { ...next, commits: [...result.commits, ...next.commits] };
          }
        }
        if (id === request.current) {
          currentPage.current = result;
          setPage(result);
        }
      } catch (error) {
        if (id === request.current)
          setError(
            error instanceof Error
              ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
              : 'Cronologia non disponibile.',
          );
      } finally {
        if (id === request.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [status.repository.path],
  );
  useEffect(() => {
    if (status.state !== 'unavailable') void load();
    return () => {
      request.current++;
      busy.current = false;
    };
  }, [load, refreshedAt, status.state === 'unavailable']);

  const pending = status.state === 'dirty';
  const commits = status.state === 'unavailable' ? [] : (page?.commits ?? []);
  const head = status.head ?? page?.head;
  const graph = useMemo(
    () => buildCommitGraph([...(pending ? [{ hash: 'wip', parents: head ? [head] : [] }] : []), ...commits]),
    [commits, pending, head],
  );
  const width = Math.max(84, graph.columns * 22 + 14);
  const tableStyle = {
    '--graph-width': `${width}px`,
    '--graph-row-height': `${ROW_HEIGHT}px`,
  } as CSSProperties;
  return (
    <section className="history-graph" aria-label="Grafo dei commit">
      <header className="repository-heading">
        <strong>{status.repository.name || status.repository.path.split('/').pop()}</strong>
        <span>
          <Icon name="branch" size={13} />
          {status.branch || 'Non disponibile'}
        </span>
      </header>
      <div
        className="graph-scroll"
        ref={scroll}
        aria-busy={loading}
        onScroll={() => {
          const node = scroll.current;
          if (
            node &&
            node.scrollHeight - node.scrollTop - node.clientHeight < 160 &&
            page?.nextCursor &&
            !loading &&
            !error
          )
            void load(page.nextCursor);
        }}
      >
        <div className="graph-table" style={tableStyle}>
          <div className="graph-columns">
            <span>BRANCH / TAG</span>
            <span>GRAFO</span>
            <span>COMMIT</span>
          </div>
          {graph.rows.map((row, index) => {
            const isPending = pending && index === 0;
            const commit = isPending ? undefined : commits[index - (pending ? 1 : 0)];
            const isSelected = isPending ? !selected : selected?.hash === commit?.hash;
            return (
              <button
                key={row.hash}
                className={`graph-row ${isSelected ? 'selected' : ''} ${isPending ? 'wip-row' : ''}`}
                aria-label={
                  isPending ? 'Commit da fare' : `Commit ${commit!.subject} ${commit!.hash.slice(0, 7)}`
                }
                aria-pressed={isSelected}
                style={{ '--lane-color': colors[row.color % colors.length] } as CSSProperties}
                title={
                  isPending
                    ? 'Modifiche locali: Working e Staged'
                    : `${commit!.hash}\n${commit!.subject}\n${commit!.author}`
                }
                onClick={() => (isPending ? onLocal() : onSelect(commit!))}
              >
                {isPending ? (
                  <span className="graph-refs">
                    <span className="ref-badge branch">{status.branch}</span>
                  </span>
                ) : (
                  <CommitRefs commit={commit!} head={head} />
                )}
                <GraphNode row={row} width={width} pending={isPending} />
                <span className="graph-message">
                  <span className="graph-subject">
                    {isPending ? (
                      <>
                        <span className="pending-badge">WIP</span> Modifiche locali
                      </>
                    ) : (
                      commit!.subject || '(senza messaggio)'
                    )}
                  </span>
                  {!isPending && <span className="graph-hash">{commit!.hash.slice(0, 7)}</span>}
                  <FileCounters counts={isPending ? summarizeChanges(status.changes) : commit!.files} />
                </span>
              </button>
            );
          })}
        </div>
        {status.state === 'unavailable' && <p className="panel-message">{status.error}</p>}
        {!loading && !error && status.state !== 'unavailable' && !commits.length && (
          <p className="panel-message">
            Nessun commit. {pending ? 'Le modifiche locali sono pronte per lo staging.' : ''}
          </p>
        )}
        {loading && (
          <div className="history-loading" role="status">
            <span className="spinner" />
            Caricamento commit…
          </div>
        )}
        {error && (
          <div className="graph-error">
            <p role="alert">{error}</p>
            <button className="text-button" onClick={() => void load()}>
              Ricarica cronologia
            </button>
          </div>
        )}
        {!error && page?.nextCursor && (
          <button
            className="load-history text-button"
            disabled={loading}
            onClick={() => void load(page.nextCursor)}
          >
            Carica altri commit
          </button>
        )}
      </div>
      <footer className="graph-footer">
        <span>{commits.length} commit caricati</span>
        <span>Branch locali e remoti</span>
      </footer>
    </section>
  );
}
