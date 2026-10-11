export interface GraphCommit {
  hash: string;
  parents: string[];
}
export interface GraphEdge {
  from: number;
  to: number;
  color: number;
  start: 'top' | 'node';
  end: 'node' | 'bottom';
}
export interface GraphRow {
  hash: string;
  column: number;
  color: number;
  edges: GraphEdge[];
}
interface Lane {
  hash: string;
  color: number;
}

/** Allocate stable lanes in child-before-parent order, including unloaded parents. */
export function buildCommitGraph(commits: GraphCommit[]): { rows: GraphRow[]; columns: number } {
  const lanes: (Lane | undefined)[] = [];
  let nextColor = 0;
  let columns = 1;
  const freeColumn = () => {
    const free = lanes.findIndex((lane) => !lane);
    return free < 0 ? lanes.length : free;
  };
  const rows = commits.map((commit) => {
    let column = lanes.findIndex((lane) => lane?.hash === commit.hash);
    const incoming = lanes.slice();
    if (column < 0) {
      column = freeColumn();
      lanes[column] = { hash: commit.hash, color: nextColor++ };
    }
    const color = lanes[column]!.color;
    const edges: GraphEdge[] = [];
    incoming.forEach((lane, index) => {
      if (lane)
        edges.push({
          from: index,
          to: index,
          color: lane.color,
          start: 'top',
          end: index === column ? 'node' : 'bottom',
        });
    });
    lanes[column] = undefined;
    [...new Set(commit.parents)].forEach((hash, index) => {
      let target = lanes.findIndex((lane) => lane?.hash === hash);
      if (target < 0) {
        target = index === 0 ? column : freeColumn();
        lanes[target] = { hash, color: index === 0 ? color : nextColor++ };
      }
      edges.push({ from: column, to: target, color: lanes[target]!.color, start: 'node', end: 'bottom' });
    });
    columns = Math.max(columns, incoming.length, lanes.length, column + 1);
    while (lanes.length && !lanes.at(-1)) lanes.pop();
    return { hash: commit.hash, column, color, edges };
  });
  return { rows, columns };
}
