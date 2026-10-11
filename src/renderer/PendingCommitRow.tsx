import type { Change } from '../shared/types';
import { summarizeChanges } from '../shared/change-summary';
import { FileCounters } from './ui';

export function PendingCommitRow({
  changes,
  selected,
  onSelect,
}: {
  changes: Change[];
  selected: boolean;
  onSelect: () => void;
}) {
  const staged = changes.filter((change) => change.section === 'staged').length;
  const working = changes.filter((change) => change.section === 'working').length;
  const label = staged ? 'Modifiche in staging' : 'Modifiche locali';
  return (
    <button
      className={`commit-row pending-commit-row ${selected ? 'selected' : ''}`}
      aria-label="Commit da fare"
      aria-pressed={selected}
      title={`Commit da fare · ${staged} file nello staging · ${working} file nel working tree. Mostra tutte le modifiche locali.`}
      onClick={onSelect}
    >
      <span className="commit-dot" aria-hidden="true" />
      <span className="commit-content">
        <span className="pending-badge">Da fare</span>
        <span className="commit-subject">{label}</span>
      </span>
      <FileCounters counts={summarizeChanges(changes)} />
    </button>
  );
}
