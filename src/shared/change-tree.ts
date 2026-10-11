import type { Change, LineStats } from './types';
export type ChangeNode =
  | { type: 'file'; name: string; path: string; change: Change; lines: LineStats }
  | {
      type: 'directory';
      name: string;
      path: string;
      children: ChangeNode[];
      first: Change;
      lines: LineStats;
    };
export function sumLines(values: LineStats[]): LineStats {
  return values.reduce(
    (sum, value) => ({
      added: sum.added + value.added,
      deleted: sum.deleted + value.deleted,
      unavailable: sum.unavailable + value.unavailable,
    }),
    { added: 0, deleted: 0, unavailable: 0 },
  );
}
export function buildChangeTree(changes: Change[]): ChangeNode[] {
  function build(items: Change[], prefix: string): ChangeNode[] {
    const folders = new Map<string, Change[]>();
    const files: ChangeNode[] = [];
    for (const change of items) {
      const remaining = change.path.slice(prefix.length);
      const slash = remaining.indexOf('/');
      if (slash < 0)
        files.push({
          type: 'file',
          name: remaining,
          path: change.path,
          change,
          lines: change.lines ?? { added: 0, deleted: 0, unavailable: 1 },
        });
      else {
        const folder = remaining.slice(0, slash);
        const children = folders.get(folder) ?? [];
        children.push(change);
        folders.set(folder, children);
      }
    }
    const dirs: ChangeNode[] = [...folders].map(([name, items]) => {
      const path = prefix + name;
      const children = build(items, path + '/');
      const first = children[0].type === 'file' ? children[0].change : children[0].first;
      if (children.length === 1 && children[0].type === 'directory')
        return { ...children[0], name: name + '/' + children[0].name };
      return {
        type: 'directory',
        name,
        path,
        children,
        first,
        lines: sumLines(children.map((c) => c.lines)),
      };
    });
    const compare = (a: ChangeNode, b: ChangeNode) =>
      a.name.localeCompare(b.name, undefined, { numeric: true });
    return [...dirs.sort(compare), ...files.sort(compare)];
  }
  return build(changes, '');
}
