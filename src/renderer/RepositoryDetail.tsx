import type { Change, CommitSummary, RepositoryOverview } from '../shared/types';
import { FileTree } from './FileTree';
import { CommitRefs } from './CommitGraph';
import { FileCounters, Icon, LineCounters } from './ui';
import { summarizeChanges } from '../shared/change-summary';
import { sumLines } from '../shared/change-tree';

export interface CommitDraft {
  summary: string;
  body: string;
}
export function RepositoryDetail({
  status,
  commit,
  selected,
  mutating,
  moving,
  pendingMove,
  draft,
  onDraft,
  onSelect,
  onMove,
  onMoveAll,
  onCommit,
}: {
  status: RepositoryOverview;
  commit?: CommitSummary;
  selected?: string;
  mutating: boolean;
  moving: boolean;
  pendingMove: (path: string, kind: 'file' | 'directory') => boolean;
  draft: CommitDraft;
  onDraft: (draft: CommitDraft) => void;
  onSelect: (change: Change) => void;
  onMove: (section: 'working' | 'staged', path: string, kind: 'file' | 'directory') => void;
  onMoveAll: (section: 'working' | 'staged') => void;
  onCommit: () => void;
}) {
  const changes = commit?.changes ?? status.changes;
  const staged = status.changes.filter((change) => change.section === 'staged').length;
  const conflicts = status.changes.some((change) => change.kind === 'conflict');
  const length = draft.summary.trim().length + (draft.body.trim() ? draft.body.trim().length + 2 : 0);
  return (
    <aside
      className="changes-panel selection-panel"
      aria-label={commit ? `Dettaglio commit ${commit.hash.slice(0, 7)}` : 'Modifiche locali'}
    >
      <header className="selection-heading">
        <strong title={commit ? `${commit.hash} - ${commit.subject}` : status.branch}>
          {commit
            ? `${commit.hash.slice(0, 7)} - ${commit.subject || '(senza messaggio)'}`
            : 'Modifiche locali'}
        </strong>
        {commit ? (
          <>
            <p>
              {commit.author}{' '}
              <span>
                ·{' '}
                {new Date(commit.authoredAt).toLocaleString('it-IT', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </p>
            <CommitRefs commit={commit} head={status.head} all />
            {commit.body && <p className="commit-body">{commit.body}</p>}
            {commit.parents.length > 1 && (
              <p className="merge-note">Merge · diff rispetto al primo genitore</p>
            )}
          </>
        ) : (
          <p>
            <Icon name="branch" size={13} />
            {status.branch || 'Non disponibile'}
            <span>· {status.changedFiles} file</span>
          </p>
        )}
        <FileCounters counts={summarizeChanges(changes)} />
      </header>
      <div className="change-list">
        {status.state === 'unavailable' && !commit ? (
          <p className="panel-message">{status.error}</p>
        ) : (
          (commit ? (['commit'] as const) : (['working', 'staged'] as const)).map((section) => {
            const entries = changes.filter((change) => change.section === section);
            return (
              <section
                key={section}
                className={`change-section ${section}`}
                aria-label={
                  section === 'commit'
                    ? 'Commit changes'
                    : section === 'working'
                      ? 'Working changes'
                      : 'Staged changes'
                }
              >
                <div className="section-heading">
                  <span className="section-dot" />
                  <h3>
                    {section === 'commit'
                      ? 'File modificati'
                      : section === 'working'
                        ? 'Working changes'
                        : 'Staged changes'}
                  </h3>
                  <span className="section-count">{entries.length}</span>
                  {section !== 'commit' && entries.length > 0 && (
                    <button
                      className="section-action"
                      disabled={mutating || moving}
                      onClick={() => onMoveAll(section)}
                    >
                      {section === 'working' ? 'Stage tutto' : 'Unstage tutto'}
                    </button>
                  )}
                </div>
                {entries.length ? (
                  <FileTree
                    changes={entries}
                    selected={selected}
                    onSelect={onSelect}
                    move={
                      section === 'commit'
                        ? undefined
                        : {
                            direction: section === 'working' ? 'stage' : 'unstage',
                            disabled: mutating,
                            pending: pendingMove,
                            onMove: (path, kind) => onMove(section, path, kind),
                          }
                    }
                  />
                ) : (
                  <p className="section-empty">Nessuna modifica</p>
                )}
              </section>
            );
          })
        )}
        {status.statsError && !commit && <p className="panel-message">{status.statsError}</p>}
      </div>
      {!commit && status.state !== 'unavailable' ? (
        <form
          className="commit-editor"
          aria-label="Nuovo commit"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mutating && !moving && staged && draft.summary.trim() && length <= 10_000 && !conflicts)
              onCommit();
          }}
        >
          <div className="commit-editor-heading">
            <Icon name="commit" size={16} />
            <strong>Commit</strong>
            <span>{staged} file in staging</span>
          </div>
          <div className="commit-summary-field">
            <input
              aria-label="Titolo commit"
              placeholder="Titolo commit"
              value={draft.summary}
              maxLength={10_000}
              disabled={mutating}
              onChange={(event) => onDraft({ ...draft, summary: event.target.value })}
            />
            <span className={draft.summary.length > 72 ? 'over-summary-limit' : ''}>
              {72 - draft.summary.length}
            </span>
          </div>
          <textarea
            aria-label="Descrizione commit"
            placeholder="Descrizione (opzionale)"
            rows={3}
            value={draft.body}
            maxLength={10_000}
            disabled={mutating}
            onChange={(event) => onDraft({ ...draft, body: event.target.value })}
          />
          {conflicts && <p className="commit-hint">Risolvi i conflitti prima di creare il commit.</p>}
          {length > 10_000 && <p className="commit-hint">Il messaggio supera 10.000 caratteri.</p>}
          <button
            className="primary-button commit-submit"
            disabled={mutating || moving || !staged || !draft.summary.trim() || length > 10_000 || conflicts}
          >
            <Icon name="commit" size={15} />
            {mutating || moving
              ? 'Operazione in corso…'
              : staged
                ? `Commit di ${staged} file`
                : 'Aggiungi file allo staging'}
          </button>
        </form>
      ) : (
        <div className="tree-footer">
          <span>{changes.length} file</span>
          <LineCounters
            lines={sumLines(
              changes.map((change) => change.lines ?? { added: 0, deleted: 0, unavailable: 1 }),
            )}
          />
        </div>
      )}
    </aside>
  );
}
