import type { FileCounts, LineStats } from '../shared/types';
export function Icon({
  name,
  size = 16,
}: {
  name:
    | 'plus'
    | 'refresh'
    | 'branch'
    | 'folder'
    | 'edit'
    | 'remove'
    | 'check'
    | 'lock'
    | 'back'
    | 'tag'
    | 'up'
    | 'down'
    | 'grip'
    | 'stage'
    | 'unstage'
    | 'commit'
    | 'remote';
  size?: number;
}) {
  const paths = {
    remote: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z" />
      </>
    ),
    tag: (
      <>
        <path d="M3 3h8l10 10-8 8L3 11Z" />
        <circle cx="7.5" cy="7.5" r="1" />
      </>
    ),
    up: <path d="m6 14 6-6 6 6" />,
    down: <path d="m6 10 6 6 6-6" />,
    grip: (
      <>
        <path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" strokeWidth="3" />
      </>
    ),
    stage: <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />,
    unstage: <path d="M12 21V9m0 0 5 5m-5-5-5 5M5 4h14" />,
    commit: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M3 12h6m6 0h6" />
      </>
    ),
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.5 6.5a7.8 7.8 0 0 1 12.8 2M17.5 17.5a7.8 7.8 0 0 1-12.8-2" />
      </>
    ),
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="5" r="2" />
        <path d="M6 7v10M18 7a7 7 0 0 1-7 7H6" />
      </>
    ),
    folder: <path d="M3 6a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v10H3Z" />,
    edit: <path d="m14 5 5 5M4 20l5-1L20 8l-5-5L4 14Z" />,
    remove: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function FileCounters({ counts }: { counts: FileCounts }) {
  const description = [
    counts.modified > 0 && `${counts.modified} file modificati`,
    counts.added > 0 && `${counts.added} aggiunti`,
    counts.deleted > 0 && `${counts.deleted} eliminati`,
  ]
    .filter(Boolean)
    .join(', ');
  if (!description) return null;
  return (
    <span className="file-counters" aria-label={description} title={description}>
      {counts.modified > 0 && (
        <span>
          <Icon name="edit" size={12} />
          {counts.modified}
        </span>
      )}
      {counts.added > 0 && (
        <span>
          <b className="green">+</b>
          {counts.added}
        </span>
      )}
      {counts.deleted > 0 && (
        <span>
          <b className="red">−</b>
          {counts.deleted}
        </span>
      )}
    </span>
  );
}
export function LineCounters({ lines }: { lines: LineStats }) {
  const title = [
    lines.added > 0 && `${lines.added} righe aggiunte`,
    lines.deleted > 0 && `${lines.deleted} righe eliminate`,
    lines.unavailable > 0 &&
      `Conteggio non disponibile per ${lines.unavailable} file (binari, submodule, conflitti o non leggibili)`,
  ]
    .filter(Boolean)
    .join(', ');
  if (!title) return null;
  return (
    <span className="line-counters" title={title} aria-label={title}>
      {lines.added > 0 && <span className="green">+{lines.added}</span>}
      {lines.deleted > 0 && <span className="red">−{lines.deleted}</span>}
      {lines.unavailable > 0 && <span className="unknown-count">*</span>}
    </span>
  );
}
