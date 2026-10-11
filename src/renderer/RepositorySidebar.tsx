import { useRef, useState } from 'react';
import type { Repository, RepositoryOverview } from '../shared/types';
import { RepositoryState } from './RepositoryState';
import { FileCounters, Icon } from './ui';
import { summarizeChanges } from '../shared/change-summary';
const displayName = (repo: Repository) => repo.name || repo.path.split('/').pop();

export function RepositorySidebar({
  statuses,
  selected,
  mutating,
  onSelect,
  onRename,
  onRemove,
  reorder,
}: {
  statuses: RepositoryOverview[];
  selected?: string;
  mutating: boolean;
  onSelect: (path: string) => void;
  onRename: (repository: Repository) => void;
  onRemove: (path: string) => void;
  reorder: (paths: string[]) => Promise<void>;
}) {
  const [dragged, setDragged] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ path: string; before: boolean }>();
  const dragPath = useRef<string | undefined>(undefined);
  const clearDrag = () => {
    dragPath.current = undefined;
    setDragged(undefined);
    setDropTarget(undefined);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= statuses.length || from === to || mutating) return;
    const paths = statuses.map((status) => status.repository.path);
    const [moved] = paths.splice(from, 1);
    paths.splice(to, 0, moved);
    void reorder(paths);
  };
  return (
    <nav className="repository-sidebar" aria-label="Repository">
      <div className="sidebar-heading">
        REPOSITORY <span>{statuses.length}</span>
      </div>
      <div className="repository-strips">
        {statuses.map((status, index) => {
          const repo = status.repository,
            pending = status.state === 'dirty';
          const nameState =
            status.state === 'unavailable'
              ? 'unavailable'
              : pending
                ? 'dirty'
                : status.deployment.state === 'tagged' && status.deployment.ahead > 0
                  ? 'ahead'
                  : 'clean';
          return (
            <article
              key={repo.path}
              className={`repo-strip ${selected === repo.path ? 'selected' : ''} ${dragged === repo.path ? 'dragging' : ''} ${dropTarget?.path === repo.path ? (dropTarget.before ? 'drop-before' : 'drop-after') : ''}`}
              aria-label={`Repository ${displayName(repo)}`}
              tabIndex={0}
              onClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) onSelect(repo.path);
              }}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSelect(repo.path);
                }
              }}
              onDragOver={(event) => {
                if (!dragPath.current || dragPath.current === repo.path || mutating) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const bounds = event.currentTarget.getBoundingClientRect();
                setDropTarget({ path: repo.path, before: event.clientY < bounds.y + bounds.height / 2 });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropTarget(undefined);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragPath.current;
                clearDrag();
                if (!from || from === repo.path || mutating) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const paths = statuses.map((item) => item.repository.path).filter((path) => path !== from);
                paths.splice(
                  paths.indexOf(repo.path) + (event.clientY < bounds.y + bounds.height / 2 ? 0 : 1),
                  0,
                  from,
                );
                void reorder(paths);
              }}
            >
              <div className="repo-info">
                <div className="repo-name-row">
                  <h2 className={`repo-name ${nameState}`} title={repo.path}>
                    <button
                      className="repo-select"
                      aria-label={`Seleziona repository ${displayName(repo)}`}
                      aria-pressed={selected === repo.path}
                      onClick={() => onSelect(repo.path)}
                    >
                      {displayName(repo)}
                    </button>
                  </h2>
                  {status.state !== 'unavailable' && (
                    <FileCounters counts={summarizeChanges(status.changes)} />
                  )}
                </div>
                <div className="repo-state-row">
                  <div className="repo-state-metadata">
                    <p className="repo-branch" title={status.branch}>
                      <Icon name="branch" size={14} />
                      <span className="branch-name">{status.branch || 'Non disponibile'}</span>
                    </p>
                    <div className="repo-release">
                      {status.deployment.state === 'tagged' ? (
                        <>
                          <Icon name="tag" size={13} />
                          <span
                            className="release-tag"
                            title={`Ultimo tag v* raggiungibile dal branch: ${status.deployment.tag}`}
                          >
                            {status.deployment.tag}
                          </span>
                        </>
                      ) : (
                        <span className="release-empty">
                          {status.deployment.state === 'unborn'
                            ? 'Nessun commit'
                            : status.deployment.state === 'untagged'
                              ? 'Nessun tag v* nel branch'
                              : 'Tag non disponibile'}
                        </span>
                      )}
                    </div>
                  </div>
                  <RepositoryState deployment={status.deployment} dirty={pending} />
                </div>
                <div className="repo-info-bottom">
                  <div className="repo-actions">
                    <button
                      className="icon-button reorder-handle"
                      aria-label={`Riordina ${displayName(repo)}`}
                      title="Trascina per riordinare, oppure usa ↑ e ↓"
                      disabled={mutating}
                      draggable={!mutating}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
                        }
                      }}
                      onDragStart={(event) => {
                        if (mutating) {
                          event.preventDefault();
                          return;
                        }
                        dragPath.current = repo.path;
                        setDragged(repo.path);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-repopeek-repository', repo.path);
                      }}
                      onDragEnd={clearDrag}
                    >
                      <Icon name="grip" size={13} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Sposta ${displayName(repo)} su`}
                      title="Sposta su"
                      disabled={mutating || index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <Icon name="up" size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Sposta ${displayName(repo)} giù`}
                      title="Sposta giù"
                      disabled={mutating || index === statuses.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <Icon name="down" size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="Rinomina repository"
                      aria-label={`Rinomina ${displayName(repo)}`}
                      onClick={() => onRename(repo)}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="Rimuovi dalla lista"
                      aria-label={`Rimuovi ${displayName(repo)} dalla lista`}
                      disabled={mutating}
                      onClick={() => onRemove(repo.path)}
                    >
                      <Icon name="remove" size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </nav>
  );
}
