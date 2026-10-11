import type { CommitSummary } from '../shared/types';
import { FileCounters, Icon } from './ui';
export function CommitRow({
  commit,
  selected,
  onSelect,
  showHash = false,
}: {
  commit: CommitSummary;
  selected?: boolean;
  onSelect: () => void;
  showHash?: boolean;
}) {
  return (
    <button
      className={`commit-row ${selected ? 'selected' : ''}`}
      aria-label={`Commit ${commit.subject} ${commit.hash.slice(0, 7)}`}
      aria-pressed={!!selected}
      title={`${commit.hash}\n${commit.subject}${commit.parents.length > 1 ? '\nMerge · confronto con il primo genitore' : ''}`}
      onClick={onSelect}
    >
      <span className="commit-dot" aria-hidden="true" />
      {showHash && <span className="commit-hash">{commit.hash.slice(0, 7)}</span>}
      <span className="commit-content">
        <span className="commit-refs">
          {commit.tags.map((tag) => (
            <span className="ref-badge tag" key={`tag:${tag}`} title={`Tag ${tag}`}>
              {tag}
            </span>
          ))}
          {commit.branches.map((branch) => (
            <span
              className="ref-badge branch"
              key={`branch:${branch}`}
              title={`Il branch ${branch} punta a questo commit`}
            >
              <Icon name="branch" size={11} />
              {branch}
            </span>
          ))}
        </span>
        <span className="commit-subject">{commit.subject || '(senza messaggio)'}</span>
      </span>
      <FileCounters counts={commit.files} />
    </button>
  );
}
