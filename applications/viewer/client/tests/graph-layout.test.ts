import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from '../src/lib/graph-layout.ts';

const ids = ['pg', 'redis', 'auth', 'orders', 'web', 'lonely'];
const edges = [
  { source: 'pg', target: 'auth' },
  { source: 'redis', target: 'auth' },
  { source: 'auth', target: 'orders' },
  { source: 'pg', target: 'orders' }, // spans two layers: needs a lane in the middle column
  { source: 'orders', target: 'web' },
];

test('applications with no edges are set aside, not laid out', () => {
  assert.deepEqual(layoutGraph(ids, edges).isolated, ['lonely']);
});

test('layers follow the longest dependency path, roots on the left', () => {
  const layout = layoutGraph(ids, edges);
  const layerOf = (id: string) => layout.nodes.find((n) => n.id === id)!.layer;
  assert.equal(layerOf('pg'), 0);
  assert.equal(layerOf('auth'), 1);
  assert.equal(layerOf('orders'), 2);
  assert.equal(layerOf('web'), 3);
});

test('no two nodes overlap and every edge runs left to right', () => {
  const layout = layoutGraph(ids, edges);
  for (const a of layout.nodes) {
    for (const b of layout.nodes) {
      if (a.id >= b.id || a.x !== b.x) continue;
      assert.ok(Math.abs(a.y - b.y) >= NODE_HEIGHT, `${a.id} overlaps ${b.id}`);
    }
  }
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      assert.ok(edge.points[i]!.x >= edge.points[i - 1]!.x);
    }
  }
});

test('a long edge gets a lane in each column it crosses instead of passing behind nodes', () => {
  const layout = layoutGraph(ids, edges);
  const long = layout.edges.find((e) => e.source === 'pg' && e.target === 'orders')!;
  // source anchor, lane in (x, x+width) for the auth column, target anchor
  assert.equal(long.points.length, 4);
  const authColumn = layout.nodes.find((n) => n.id === 'auth')!;
  const [, laneIn, laneOut] = long.points;
  assert.equal(laneIn!.x, authColumn.x);
  assert.equal(laneOut!.x, authColumn.x + NODE_WIDTH);
  const clear = laneIn!.y < authColumn.y - 2 || laneIn!.y > authColumn.y + NODE_HEIGHT + 2;
  assert.ok(clear, 'the lane must sit outside the auth node');
});

test('a cycle does not hang the layout', () => {
  const layout = layoutGraph(
    ['a', 'b'],
    [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ],
  );
  assert.equal(layout.nodes.length, 2);
});
