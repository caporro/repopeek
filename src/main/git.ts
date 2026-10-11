import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Change,
  ChangeKind,
  ChangeTarget,
  DiffResult,
  Repository,
  RepositoryStatus,
  Section,
} from '../shared/types';

const execute = promisify(execFile);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const gitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const env = {
  ...gitEnvironment,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  LC_ALL: 'C',
};

export async function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<Buffer> {
  const result = await execute(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'diff.autoRefreshIndex=false',
      '-C',
      root,
      ...args,
    ],
    { env, timeout: 15_000, maxBuffer, encoding: 'buffer', windowsHide: true },
  );
  return result.stdout;
}

export async function resolveRepository(selected: string): Promise<string> {
  const directory = await realpath(selected);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Seleziona una cartella.');
  if ((await git(directory, ['rev-parse', '--is-inside-work-tree'])).toString().trim() !== 'true') {
    throw new Error('La cartella non contiene un working tree Git.');
  }
  return realpath((await git(directory, ['rev-parse', '--show-toplevel'])).toString().replace(/\n$/, ''));
}

function fields(record: string, count: number): [string[], string] {
  const result: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(' ', offset);
    if (end < 0) throw new Error('Risposta Git non riconosciuta.');
    result.push(record.slice(offset, end));
    offset = end + 1;
  }
  return [result, record.slice(offset)];
}

function kind(code: string): ChangeKind {
  return (
    ({ A: 'added', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', M: 'modified' } as const)[
      code as 'M'
    ] ?? 'modified'
  );
}

export function parseStatus(output: Buffer, repository: Repository): RepositoryStatus {
  const records = output.toString('utf8').split('\0');
  const changes: Change[] = [];
  let branch = '';
  let oid = '';
  const append = (
    file: string,
    section: Section,
    changeKind: ChangeKind,
    previousPath?: string,
    sub?: string,
  ) => {
    changes.push({
      key: `${section}:${file}`,
      path: file,
      section,
      kind: changeKind,
      ...(previousPath ? { previousPath } : {}),
      ...(sub?.startsWith('S')
        ? {
            submodule: { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U' },
          }
        : {}),
    });
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    else if (record.startsWith('# branch.oid ')) oid = record.slice(13);
    else if (record.startsWith('? ')) append(record.slice(2), 'working', 'untracked');
    else if (record.startsWith('u ')) {
      const [parts, file] = fields(record, 10);
      append(file, 'working', 'conflict', undefined, parts[2]);
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const renamed = record[0] === '2';
      const [parts, file] = fields(record, renamed ? 9 : 8);
      const previousPath = renamed ? records[++i] : undefined;
      const [staged, working] = parts[1];
      if (staged !== '.')
        append(file, 'staged', kind(staged), /[RC]/.test(staged) ? previousPath : undefined, parts[2]);
      if (working !== '.')
        append(file, 'working', kind(working), /[RC]/.test(working) ? previousPath : undefined, parts[2]);
    }
  }
  if (branch === '(detached)') branch = `Detached · ${oid.slice(0, 7)}`;
  return {
    repository,
    branch,
    ...(/^[a-f0-9]{40,64}$/.test(oid) ? { head: oid } : {}),
    state: changes.length ? 'dirty' : 'clean',
    changes,
    changedFiles: new Set(changes.map((change) => change.path)).size,
  };
}

export async function getStatus(repository: Repository): Promise<RepositoryStatus> {
  try {
    // Prevent a removed nested repository from silently becoming its parent repository.
    if ((await resolveRepository(repository.path)) !== repository.path)
      throw new Error('Repository spostato.');
    return parseStatus(
      await git(repository.path, [
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        '--no-ahead-behind',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--find-renames=50%',
      ]),
      repository,
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return {
      repository,
      state: 'unavailable',
      branch: '',
      changes: [],
      changedFiles: 0,
      error: failure.killed
        ? 'Git non ha risposto entro 15 secondi. Riprova con Aggiorna.'
        : failure.code === 'ENOENT'
          ? 'Cartella o Git non disponibile.'
          : 'Repository non disponibile o non leggibile. Riprova con Aggiorna.',
    };
  }
}

function mutationError(error: unknown, fallback: string): Error {
  const failure = error as { stderr?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : failure.stderr;
  const message = (stderr || failure.message || fallback).trim().slice(0, 2000);
  return new Error(message || fallback);
}

function changesForTarget(
  status: RepositoryStatus,
  target: ChangeTarget | undefined,
  section: Section,
): Change[] {
  const prefix = `${target?.path}/`;
  const changes = status.changes.filter(
    (change) =>
      change.section === section &&
      (!target ||
        change.path === target.path ||
        (target.kind === 'directory' && change.path.startsWith(prefix))),
  );
  if (!changes.length)
    throw new Error(
      section === 'working'
        ? 'Il file o la cartella non presenta più modifiche da aggiungere allo staging.'
        : 'Il file o la cartella non è più presente nello staging.',
    );
  return changes;
}

function pathsForChanges(changes: Change[]): string[] {
  return [
    ...new Set(changes.flatMap((change) => [change.path, change.previousPath].filter(Boolean) as string[])),
  ];
}

export async function stage(repository: Repository, target?: ChangeTarget): Promise<void> {
  const status = await getStatus(repository);
  if (status.state === 'unavailable') throw new Error(status.error);
  const paths = pathsForChanges(changesForTarget(status, target, 'working'));
  try {
    await git(repository.path, ['add', '-A', '--', ...paths]);
  } catch (error) {
    throw mutationError(error, 'Non è stato possibile aggiungere la modifica allo staging.');
  }
}

export async function unstage(repository: Repository, target?: ChangeTarget): Promise<void> {
  const status = await getStatus(repository);
  if (status.state === 'unavailable') throw new Error(status.error);
  const paths = pathsForChanges(changesForTarget(status, target, 'staged'));
  try {
    let hasHead = true;
    try {
      await git(repository.path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
      hasHead = false;
    }
    if (hasHead) await git(repository.path, ['restore', '--staged', '--', ...paths]);
    else await git(repository.path, ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...paths]);
  } catch (error) {
    throw mutationError(error, 'Non è stato possibile rimuovere la modifica dallo staging.');
  }
}

export async function commitStaged(repository: Repository, message: string): Promise<void> {
  if (!message.trim() || message.length > 10_000 || message.includes('\0'))
    throw new Error('Inserisci un messaggio di commit valido.');
  const status = await getStatus(repository);
  if (status.state === 'unavailable') throw new Error(status.error);
  if (!status.changes.some((change) => change.section === 'staged'))
    throw new Error('Non ci sono modifiche nello staging da committare.');
  try {
    await git(repository.path, ['commit', '-m', message.trim()]);
  } catch (error) {
    throw mutationError(error, 'Il commit non è riuscito.');
  }
}

export class PreviewError extends Error {
  constructor(
    public reason: 'large' | 'binary' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
function assertSize(size: number) {
  if (size > MAX_FILE_BYTES)
    throw new PreviewError('large', 'File troppo grande: la diff è disponibile fino a 2 MiB per versione.');
}
export function decode(bytes: Buffer): string {
  if (bytes.includes(0)) throw new PreviewError('binary', 'File binario: anteprima non disponibile.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PreviewError('binary', 'File binario o codifica non UTF-8: anteprima non disponibile.');
  }
}
export async function readBlob(root: string, oid: string): Promise<Buffer> {
  const size = Number((await git(root, ['cat-file', '-s', oid])).toString().trim());
  assertSize(size);
  return git(root, ['cat-file', 'blob', oid], MAX_FILE_BYTES + 1024);
}

async function indexVersion(root: string, file: string): Promise<Buffer> {
  const entries = (await git(root, ['ls-files', '--stage', '-z', '--', file])).toString().split('\0');
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]*)$/.exec(entry);
    if (match?.[3] === file) {
      if (match[1] === '160000') return Buffer.from(`Subproject commit ${match[2]}\n`);
      return readBlob(root, match[2]);
    }
  }
  return Buffer.alloc(0);
}

async function headVersion(root: string, file: string): Promise<Buffer> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return Buffer.alloc(0);
    throw error;
  }
  const entries = (await git(root, ['ls-tree', '-z', 'HEAD', '--', file])).toString().split('\0');
  for (const entry of entries) {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]*)$/.exec(entry);
    if (match?.[4] === file)
      return match[2] === 'commit'
        ? Buffer.from(`Subproject commit ${match[3]}\n`)
        : readBlob(root, match[3]);
  }
  return Buffer.alloc(0);
}

export async function workingVersion(root: string, file: string): Promise<Buffer> {
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep)) throw new PreviewError('unavailable', 'Percorso non valido.');
  const parent = await realpath(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep))
    throw new PreviewError('unavailable', 'Percorso esterno al repository.');
  const info = await lstat(target);
  if (info.isSymbolicLink()) return Buffer.from(await readlink(target));
  if (!info.isFile()) throw new PreviewError('unavailable', 'Questo percorso non è un file di testo.');
  assertSize(info.size);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new PreviewError('unavailable', 'Questo percorso non è un file regolare.');
    assertSize(current.size);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    assertSize(offset);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function getDiff(repository: Repository, key: string): Promise<DiffResult> {
  try {
    const status = await getStatus(repository);
    if (status.state === 'unavailable')
      return { type: 'message', reason: 'unavailable', message: status.error! };
    const change = status.changes.find((item) => item.key === key);
    if (!change)
      return {
        type: 'message',
        reason: 'unavailable',
        message: 'Il file è cambiato o non presenta più modifiche. Aggiorna la lista.',
      };
    if (change.submodule) {
      const details = [
        change.submodule.commitChanged && 'Commit differente',
        change.submodule.modified && 'File interni modificati',
        change.submodule.untracked && 'File interni non tracciati',
      ].filter(Boolean);
      if (change.section === 'staged') {
        const [before, after] = await Promise.all([
          headVersion(repository.path, change.previousPath ?? change.path),
          indexVersion(repository.path, change.path),
        ]);
        details.unshift(
          `HEAD: ${before.toString().trim().replace('Subproject commit ', '') || 'assente'}\nStaging: ${after.toString().trim().replace('Subproject commit ', '') || 'assente'}`,
        );
      }
      return {
        type: 'message',
        reason: 'submodule',
        message: `Submodule\n${details.join('\n') || 'Riferimento modificato'}`,
      };
    }
    const attributes = (
      await git(repository.path, [
        'check-attr',
        ...(change.section === 'staged' ? ['--cached'] : []),
        '-z',
        'diff',
        '--',
        change.path,
      ])
    )
      .toString()
      .split('\0');
    if (attributes[2] === 'unset')
      throw new PreviewError('binary', 'File contrassegnato come binario da Git: anteprima non disponibile.');
    if (change.kind === 'conflict') {
      try {
        return {
          type: 'conflict',
          content: decode(await workingVersion(repository.path, change.path)),
          message: 'Conflitto non risolto · contenuto attuale del file, in sola lettura.',
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return {
            type: 'conflict',
            content: '',
            message: 'Conflitto non risolto · file assente nel working tree.',
          };
        throw error;
      }
    }
    const previous = change.previousPath ?? change.path;
    const [before, after] = await Promise.all([
      change.kind === 'untracked'
        ? Buffer.alloc(0)
        : change.section === 'staged'
          ? headVersion(repository.path, previous)
          : indexVersion(repository.path, previous),
      change.kind === 'deleted'
        ? Buffer.alloc(0)
        : change.section === 'staged'
          ? indexVersion(repository.path, change.path)
          : workingVersion(repository.path, change.path),
    ]);
    const original = decode(before);
    const modified = decode(after);
    return {
      type: 'text',
      original,
      modified,
      originalLabel: change.section === 'staged' ? 'Ultimo commit' : 'Staging',
      modifiedLabel: change.section === 'staged' ? 'Staging' : 'Working tree',
      ...(original === modified ? { note: 'Contenuto invariato: modifica di nome, tipo o permessi.' } : {}),
    };
  } catch (error) {
    return error instanceof PreviewError
      ? { type: 'message', reason: error.reason, message: error.message }
      : {
          type: 'message',
          reason: 'unavailable',
          message:
            'Impossibile leggere questa versione del file. Potrebbe essere cambiato: aggiorna la lista.',
        };
  }
}
