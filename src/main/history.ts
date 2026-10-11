import type {
  Change,
  CommitSummary,
  HistoryCursor,
  HistoryPage,
  DiffResult,
  LineStats,
  Repository,
  RepositoryOverview,
  RepositoryStatus,
} from '../shared/types';
import { createHash } from 'node:crypto';
import { getDeploymentStatus } from './deployment';
import { summarizeChanges } from '../shared/change-summary';
import { decode, getStatus, git, PreviewError, readBlob, resolveRepository, workingVersion } from './git';

const unknownLines = (): LineStats => ({ added: 0, deleted: 0, unavailable: 1 });
const zeroLines = (): LineStats => ({ added: 0, deleted: 0, unavailable: 0 });
const diffOptions = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=none',
  '--find-renames=50%',
];

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

// NUL delimiters also preserve tabs, newlines and literal pathspec characters in filenames.
export function parseNumstat(output: Buffer): Map<string, LineStats> {
  const records = output.toString().split('\0');
  const stats = new Map<string, LineStats>();
  for (let i = 0; i < records.length && records[i]; i++) {
    const record = records[i];
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw new Error('Statistiche Git non riconosciute.');
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    let file = record.slice(second + 1);
    if (!file) {
      i++;
      file = records[++i];
    }
    if (!file) throw new Error('Percorso Git mancante.');
    stats.set(
      file,
      added === '-' || deleted === '-'
        ? unknownLines()
        : {
            added: Number(added),
            deleted: Number(deleted),
            unavailable: 0,
          },
    );
  }
  return stats;
}

interface RawChange {
  change: Change;
  before: string;
  after: string;
}
function parseRaw(output: Buffer, hash: string): RawChange[] {
  const records = output.toString().split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i < records.length && records[i]; i++) {
    const match = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(records[i]);
    if (!match) throw new Error('Modifiche Git non riconosciute.');
    const [, beforeMode, afterMode, before, after, status] = match;
    const previous = records[++i];
    const renamed = status === 'R' || status === 'C';
    const file = renamed ? records[++i] : previous;
    const submodule = beforeMode === '160000' || afterMode === '160000';
    changes.push({
      before,
      after,
      change: {
        key: `commit:${hash}:${file}`,
        path: file,
        section: 'commit',
        kind:
          status === 'A' || status === 'C'
            ? 'added'
            : status === 'D'
              ? 'deleted'
              : status === 'R'
                ? 'renamed'
                : 'modified',
        ...(renamed ? { previousPath: previous } : {}),
        ...(submodule ? { submodule: { commitChanged: true, modified: false, untracked: false } } : {}),
      },
    });
  }
  return changes;
}

async function commitData(root: string, hash: string) {
  const metadata = (
    await git(root, [
      'show',
      '-s',
      '--no-show-signature',
      '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%b',
      hash,
    ])
  )
    .toString()
    .replace(/\n$/, '')
    .split('\0');
  const parents = metadata[1] ? metadata[1].split(' ') : [];
  // Merge summaries and previews consistently compare the merge with its first parent.
  const revisions = parents.length ? [parents[0], hash] : [hash];
  const base = ['diff-tree', '--root', '--no-commit-id', '-r', '-z', ...diffOptions];
  const [raw, numbers] = await Promise.all([
    git(root, [...base, '--raw', '--no-abbrev', ...revisions, '--']),
    git(root, [...base, '--numstat', ...revisions, '--']),
  ]);
  const stats = parseNumstat(numbers);
  const entries = parseRaw(raw, hash);
  for (const entry of entries)
    entry.change.lines = entry.change.submodule
      ? unknownLines()
      : (stats.get(entry.change.path) ?? unknownLines());
  return {
    hash,
    subject: metadata[2] ?? '',
    author: metadata[3] ?? '',
    authoredAt: metadata[4] ?? '',
    body: (metadata[5] ?? '').trimEnd(),
    parents,
    entries,
  };
}

async function historyPage(
  root: string,
  limit: number,
  cursor?: HistoryCursor,
  includeHead = false,
): Promise<HistoryPage> {
  const refs = (
    await git(root, [
      'for-each-ref',
      '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ])
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  let head: string | undefined;
  try {
    head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).toString().trim();
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const branchRefs = refs.filter((record) => {
    const parts = record.split('\0');
    return !parts[3] && (parts[2].startsWith('refs/heads/') || parts[2].startsWith('refs/remotes/'));
  });
  const revision = createHash('sha256')
    .update(refs.join('\n') + '\n' + (head ?? ''))
    .digest('hex');
  if (cursor && cursor.revision !== revision)
    throw new Error('La cronologia è cambiata. Ricarica la lista per continuare.');
  // Pin each page to local/remote refs and HEAD. Reading remote refs never fetches.
  const tips = [...new Set([...branchRefs.map((record) => record.split('\0')[0]), ...(head ? [head] : [])])];
  if (!tips.length) return { commits: [] };
  const offset = cursor?.offset ?? 0;
  const hashes = (
    await git(root, [
      'rev-list',
      '--date-order',
      `--max-count=${limit + 1}`,
      `--skip=${offset}`,
      ...tips,
      '--',
    ])
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const visibleHashes = hashes.slice(0, limit);
  if (includeHead && head && !visibleHashes.includes(head)) visibleHashes.push(head);
  const commits = await mapLimit(visibleHashes, 2, async (hash) => {
    const data = await commitData(root, hash);
    const branches: string[] = [],
      remoteBranches: string[] = [],
      tags: string[] = [];
    for (const record of refs) {
      const [direct, peeled, name, symbolic] = record.split('\0');
      if (symbolic) continue;
      if ((peeled || direct) !== hash) continue;
      if (name.startsWith('refs/heads/')) branches.push(name.slice(11));
      else if (name.startsWith('refs/remotes/')) remoteBranches.push(name.slice(13));
      else if (name.startsWith('refs/tags/')) tags.push(name.slice(10));
    }
    const changes = data.entries.map((entry) => entry.change);
    return {
      hash,
      subject: data.subject,
      author: data.author,
      authoredAt: data.authoredAt,
      body: data.body,
      parents: data.parents,
      branches,
      remoteBranches,
      tags,
      changes,
      files: summarizeChanges(changes),
    };
  });
  return {
    commits,
    head,
    ...(hashes.length > limit ? { nextCursor: { offset: offset + limit, revision } } : {}),
  };
}

export async function getHistory(root: string): Promise<CommitSummary[]> {
  return (await historyPage(root, 5)).commits;
}

export async function getHistoryPage(repository: Repository, cursor?: HistoryCursor): Promise<HistoryPage> {
  if ((await resolveRepository(repository.path)) !== repository.path)
    throw new Error('Repository non disponibile.');
  if (
    cursor &&
    (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !/^[a-f0-9]{64}$/.test(cursor.revision))
  )
    throw new Error('Pagina della cronologia non valida.');
  return historyPage(repository.path, 20, cursor);
}

async function localLineStats(root: string, changes: Change[]): Promise<Change[]> {
  const [staged, working] = await Promise.all([
    git(root, ['diff', '--cached', '--numstat', '-z', ...diffOptions, '--']).then(parseNumstat),
    git(root, ['diff', '--numstat', '-z', ...diffOptions, '--']).then(parseNumstat),
  ]);
  const untracked = changes.filter((change) => change.kind === 'untracked');
  const binary = new Set<string>();
  for (let i = 0; i < untracked.length; i += 128) {
    const attrs = (
      await git(root, ['check-attr', '-z', 'diff', '--', ...untracked.slice(i, i + 128).map((c) => c.path)])
    )
      .toString()
      .split('\0');
    for (let j = 0; j + 2 < attrs.length; j += 3) if (attrs[j + 2] === 'unset') binary.add(attrs[j]);
  }
  return mapLimit(changes, 4, async (change) => {
    let lines = unknownLines();
    if (!change.submodule && change.kind !== 'conflict') {
      if (change.kind === 'untracked') {
        try {
          if (!binary.has(change.path)) {
            const content = decode(await workingVersion(root, change.path));
            const count = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
            lines = { ...zeroLines(), added: count };
          }
        } catch {
          /* Unreadable, binary or oversized files remain explicitly uncounted. */
        }
      } else lines = (change.section === 'staged' ? staged : working).get(change.path) ?? unknownLines();
    }
    return { ...change, lines };
  });
}

/** Refresh only working/index state and line counts, without reading history or tags. */
export async function getLocalStatus(repository: Repository): Promise<RepositoryStatus> {
  const status = await getStatus(repository);
  if (status.state === 'unavailable') return status;
  try {
    return { ...status, changes: await localLineStats(repository.path, status.changes) };
  } catch {
    return {
      ...status,
      changes: status.changes.map((change) => ({ ...change, lines: unknownLines() })),
      statsError: 'Conteggi delle righe non disponibili. Riprova con Aggiorna.',
    };
  }
}

export async function getOverview(repository: Repository): Promise<RepositoryOverview> {
  const status = await getStatus(repository);
  if (status.state === 'unavailable') return { ...status, commits: [], deployment: { state: 'unavailable' } };
  const [local, history, deployment] = await Promise.allSettled([
    localLineStats(repository.path, status.changes),
    historyPage(repository.path, 5, undefined, true).then((page) => page.commits),
    getDeploymentStatus(repository.path),
  ]);
  return {
    ...status,
    changes:
      local.status === 'fulfilled'
        ? local.value
        : status.changes.map((c) => ({ ...c, lines: unknownLines() })),
    commits: history.status === 'fulfilled' ? history.value : [],
    deployment: deployment.status === 'fulfilled' ? deployment.value : { state: 'unavailable' },
    ...(local.status === 'rejected'
      ? { statsError: 'Conteggi delle righe non disponibili. Riprova con Aggiorna.' }
      : {}),
    ...(history.status === 'rejected'
      ? { historyError: 'Cronologia non disponibile. Riprova con Aggiorna.' }
      : {}),
  };
}

export async function getCommitDiff(repository: Repository, hash: string, key: string): Promise<DiffResult> {
  try {
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) ||
      (await resolveRepository(repository.path)) !== repository.path
    )
      throw new Error('Repository o commit non valido.');
    const reachable = (
      await git(repository.path, [
        'for-each-ref',
        `--contains=${hash}`,
        '--count=1',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
      ])
    )
      .toString()
      .trim();
    if (!reachable) {
      // Detached HEAD is part of the graph even without a branch pointing to it.
      await git(repository.path, ['merge-base', '--is-ancestor', hash, 'HEAD']);
    }
    const data = await commitData(repository.path, hash);
    const entry = data.entries.find((item) => item.change.key === key);
    if (!entry) throw new Error('File non presente nel commit.');
    if (entry.change.submodule)
      return {
        type: 'message',
        reason: 'submodule',
        message: `Submodule\nPrima: ${/^0+$/.test(entry.before) ? 'assente' : entry.before}\nDopo: ${/^0+$/.test(entry.after) ? 'assente' : entry.after}`,
      };
    if (entry.change.lines?.unavailable)
      throw new PreviewError('binary', 'File binario: anteprima non disponibile.');
    const [before, after] = await Promise.all(
      [entry.before, entry.after].map((oid) =>
        /^0+$/.test(oid) ? Buffer.alloc(0) : readBlob(repository.path, oid),
      ),
    );
    const original = decode(before),
      modified = decode(after);
    const notes = [
      data.parents.length > 1 && 'Merge confrontato con il primo genitore.',
      original === modified && 'Contenuto invariato: modifica di nome, tipo o permessi.',
    ].filter(Boolean);
    return {
      type: 'text',
      original,
      modified,
      originalLabel: data.parents[0]?.slice(0, 7) ?? 'Prima del primo commit',
      modifiedLabel: hash.slice(0, 7),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  } catch (error) {
    return error instanceof PreviewError
      ? { type: 'message', reason: error.reason, message: error.message }
      : {
          type: 'message',
          reason: 'unavailable',
          message: 'Versione del commit non disponibile. Aggiorna la panoramica.',
        };
  }
}
