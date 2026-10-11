import { useMemo, useState } from 'react';
import type { Change, ChangeKind } from '../shared/types';
import { buildChangeTree } from '../shared/change-tree';
import type { ChangeNode } from '../shared/change-tree';
import { Icon, LineCounters } from './ui';
const labels: Record<ChangeKind, string> = {
  modified: 'Modificato',
  added: 'Aggiunto',
  deleted: 'Eliminato',
  renamed: 'Rinominato',
  untracked: 'Non tracciato',
  conflict: 'Conflitto',
};
const letters: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflict: '!',
};
export function FileTree({
  changes,
  compact = false,
  selected,
  onSelect,
  move,
}: {
  changes: Change[];
  compact?: boolean;
  selected?: string;
  onSelect: (change: Change) => void;
  move?: {
    direction: 'stage' | 'unstage';
    disabled?: boolean;
    pending?: (path: string, kind: 'file' | 'directory') => boolean;
    onMove: (path: string, kind: 'file' | 'directory') => void;
  };
}) {
  const nodes = useMemo(() => buildChangeTree(changes), [changes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const render = (items: ChangeNode[], depth = 0): React.ReactNode => (
    <ul className="file-tree">
      {items.map((node) => (
        <li key={node.path}>
          {node.type === 'file' ? (
            <div className="tree-item-row">
              <button
                className={`file-row ${selected === node.change.key ? 'selected' : ''}`}
                style={{ paddingLeft: 14 + depth * 15 }}
                onClick={() => onSelect(node.change)}
                title={node.change.previousPath ? `${node.change.previousPath} → ${node.path}` : node.path}
                aria-label={`${node.path} · ${labels[node.change.kind]}`}
                aria-pressed={selected === node.change.key}
              >
                <span className={`status-letter ${node.change.kind}`}>{letters[node.change.kind]}</span>
                <span className="tree-name">{node.name}</span>
                <LineCounters lines={node.lines} />
              </button>
              {move && <MoveButton move={move} path={node.path} kind="file" />}
            </div>
          ) : (
            <>
              <div className="tree-item-row">
                <button
                  className="folder-row"
                  style={{ paddingLeft: 14 + depth * 15 }}
                  title={node.path}
                  aria-label={`Cartella ${node.path}`}
                  aria-expanded={compact ? undefined : !collapsed.has(node.path)}
                  onClick={() => {
                    if (compact) onSelect(node.first);
                    else
                      setCollapsed((old) => {
                        const next = new Set(old);
                        if (next.has(node.path)) next.delete(node.path);
                        else next.add(node.path);
                        return next;
                      });
                  }}
                >
                  <span
                    className={`tree-chevron ${!compact && !collapsed.has(node.path) ? 'expanded' : ''}`}
                    aria-hidden="true"
                  />
                  <Icon name="folder" size={14} />
                  <span className="tree-name">{node.name}</span>
                  <LineCounters lines={node.lines} />
                </button>
                {move && <MoveButton move={move} path={node.path} kind="directory" />}
              </div>
              {!compact && !collapsed.has(node.path) && render(node.children, depth + 1)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
  return render(nodes);
}

function MoveButton({
  move,
  path,
  kind,
}: {
  move: {
    direction: 'stage' | 'unstage';
    disabled?: boolean;
    pending?: (path: string, kind: 'file' | 'directory') => boolean;
    onMove: (path: string, kind: 'file' | 'directory') => void;
  };
  path: string;
  kind: 'file' | 'directory';
}) {
  const stage = move.direction === 'stage';
  const subject = kind === 'directory' ? 'cartella' : 'file';
  const label = stage
    ? `Aggiungi ${subject} ${path} allo staging`
    : `Rimuovi ${subject} ${path} dallo staging`;
  const pending = move.pending?.(path, kind) ?? false;
  return (
    <button
      className={`tree-move-button ${move.direction}`}
      aria-label={label}
      title={label}
      disabled={move.disabled || pending}
      aria-busy={pending}
      onClick={() => move.onMove(path, kind)}
    >
      {pending ? <span className="move-spinner" /> : <Icon name={move.direction} size={14} />}
    </button>
  );
}
