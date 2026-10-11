import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommitGraph } from '../src/shared/commit-graph';

test('linear history and WIP keep a single lane connected to HEAD', () => {
  const graph = buildCommitGraph([
    { hash: 'wip', parents: ['head'] },
    { hash: 'head', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  assert.equal(graph.columns, 1);
  assert.deepEqual(
    graph.rows.map((row) => row.column),
    [0, 0, 0],
  );
  assert.equal(graph.rows[0].edges[0].start, 'node');
  assert.equal(graph.rows[1].edges[0].end, 'node');
  assert.equal(graph.rows[2].edges.length, 1);
});

test('merge parents occupy separate lanes and converge on the shared ancestor', () => {
  const graph = buildCommitGraph([
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  assert.equal(graph.columns, 2);
  assert.deepEqual(
    graph.rows.map((row) => row.column),
    [0, 0, 1, 0],
  );
  assert.deepEqual(
    graph.rows[0].edges.map((edge) => edge.to),
    [0, 1],
  );
  assert(graph.rows[2].edges.some((edge) => edge.start === 'node' && edge.from === 1 && edge.to === 0));
  assert.equal(graph.rows[3].color, graph.rows[0].color);
});

test('WIP stays connected to HEAD when another branch appears first; paging does not move existing nodes', () => {
  const firstPage = [
    { hash: 'wip', parents: ['head'] },
    { hash: 'remote', parents: ['remote-base'] },
    { hash: 'head', parents: ['base'] },
  ];
  const prefix = buildCommitGraph(firstPage);
  assert.deepEqual(
    prefix.rows.map((row) => row.column),
    [0, 1, 0],
  );
  const complete = buildCommitGraph([
    ...firstPage,
    { hash: 'remote-base', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  assert.deepEqual(complete.rows.slice(0, firstPage.length), prefix.rows);
  assert(complete.rows[1].edges.some((edge) => edge.from === 0 && edge.to === 0));
});

test('octopus merges and independent roots preserve every parent without duplicate lanes', () => {
  const graph = buildCommitGraph([
    { hash: 'merge', parents: ['a', 'b', 'c'] },
    { hash: 'independent', parents: [] },
    { hash: 'a', parents: ['base'] },
    { hash: 'b', parents: ['base'] },
    { hash: 'c', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  assert.equal(graph.columns, 4);
  assert.deepEqual(
    graph.rows[0].edges.map((edge) => edge.to),
    [0, 1, 2],
  );
  assert.equal(graph.rows.at(-1)!.column, 0);
});
