# Incremental Graph Updates — Future Architecture

## Context

As of v1.0 (bug fixes 1-7 complete), NCA uses a **rebuild-on-change** approach:
- When a file changes or is deleted, we call `Linker.link(storage)` which rebuilds
  the entire dependency graph from scratch by calling `getAllNodes()`.
- Complexity: O(V + E) where V = nodes, E = edges.
- Current scale: ~150 nodes, takes <5ms. Not a bottleneck.

This is **correct** and **simple**, but does not scale to large codebases (10,000+ nodes).

## When to migrate to incremental

Consider incremental updates when:
1. NCA indexes >2,000 nodes and watch mode feels laggy
2. NCA is published as OSS and users report performance issues
3. You're adding multi-repo support (multiple projects = more nodes)

Until then, **rebuild-on-change is fine**. Don't optimise prematurely.

---

## Incremental architecture (Option D)

### Goal

After a file deletion, only recompute edges for nodes that **depended on** the
deleted nodes. Complexity: O(k) where k = affected nodes, not O(V + E).

### Required changes

#### 1. Persist the dependency graph

**New table** (migration 003):

```sql
CREATE TABLE node_edges (
  source_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_name)
);

CREATE INDEX idx_edges_target ON node_edges(target_name);
```

**Why `target_name` and not `target_id`?**
- Dependencies are unresolved names from the AST (e.g., `import { foo } from './bar'`)
- A dependency might not exist yet (forward reference, circular deps)
- Storing names allows edges to exist before target nodes are created

#### 2. Update Linker to persist edges

**Current**: `Linker.link(storage)` builds graph in memory, discards it.

**New**: `Linker.link(storage)` also writes to `node_edges`:

```typescript
static link(storage: Storage): Map<string, Set<string>> {
  const nodes = storage.getAllNodes();
  const graph = new Map<string, Set<string>>();

  // Build graph in memory (existing logic)
  for (const node of nodes) {
    graph.set(node.name, new Set(node.deps));
  }

  // NEW: Persist to DB
  storage.db.exec('DELETE FROM node_edges');  // Clear old edges
  const insertEdge = storage.db.prepare(
    'INSERT INTO node_edges (source_id, target_name) VALUES (?, ?)'
  );
  const tx = storage.db.transaction(() => {
    for (const node of nodes) {
      for (const dep of node.deps) {
        insertEdge.run(node.id, dep);
      }
    }
  });
  tx();

  return graph;
}
```

#### 3. Incremental unlink handler

**Before fix** (bug 6):
```typescript
watcher.on('unlink', (filepath) => {
  storage.deleteFile(filepath);  // Deletes nodes, leaves graph stale
});
```

**Current fix** (Option A — simple symmetry):
```typescript
// On deletion or change, relink and redetect once per debounced flush
if (deleted.length > 0 || changed.length > 0) {
  new Linker(storage).link(rootPath);   // O(V + E) — rebuilds entire graph
  new FlowDetector(storage).detectAll(); // O(V^2) worst case
}
```

**Future** (Option D — incremental):
```typescript
watcher.on('unlink', (filepath) => {
  // 1. Find names of deleted nodes
  const deletedNames = storage.db.prepare(
    'SELECT DISTINCT name FROM nodes WHERE file = ?'
  ).all(filepath).map(r => r.name);

  // 2. Find nodes that depended on them
  const affectedIds = storage.db.prepare(`
    SELECT DISTINCT source_id FROM node_edges
    WHERE target_name IN (${deletedNames.map(() => '?').join(',')})
  `).all(...deletedNames).map(r => r.source_id);

  // 3. Delete the file (CASCADE deletes edges automatically via FK)
  storage.deleteFile(filepath);

  // 4. Clean up orphaned edges (edges pointing to deleted names)
  storage.db.prepare(`
    DELETE FROM node_edges
    WHERE target_name IN (${deletedNames.map(() => '?').join(',')})
  `).run(...deletedNames);

  // 5. Incremental flow detection (only affected nodes)
  FlowDetector.redetectAffected(storage, affectedIds);
});
```

**Complexity**: O(k) where k = number of affected nodes.

#### 4. Incremental FlowDetector

**New method**:

```typescript
static redetectAffected(storage: Storage, affectedIds: number[]): void {
  // Delete old flow entries for affected nodes
  storage.db.prepare(`
    DELETE FROM flows WHERE node_id IN (${affectedIds.map(() => '?').join(',')})
  `).run(...affectedIds);

  // Redetect flows only for affected nodes
  const affectedNodes = storage.db.prepare(`
    SELECT * FROM nodes WHERE id IN (${affectedIds.map(() => '?').join(',')})
  `).all(...affectedIds);

  for (const node of affectedNodes) {
    const flows = this.detectFlowsForNode(node);  // existing logic
    for (const flow of flows) {
      storage.insertFlow(node.id, flow);
    }
  }
}
```

### Estimated effort

- Migration 003 (table): 20 lines SQL
- Linker persist logic: 30 lines
- Scanner incremental unlink: 25 lines
- FlowDetector.redetectAffected: 40 lines
- Tests (EDGE-01..04): 150 lines

**Total**: ~265 lines code + tests, 3-4 hours implementation + 1-2 hours testing.

### When NOT to do this

- Your codebase stays <2,000 nodes
- Watch mode is fast enough (subjective: <100ms per change feels instant)
- You're not publishing NCA as a product

Premature optimisation is real. The current O(V + E) approach is **correct** and
simple. Only migrate to incremental when you have a measured performance problem.

---

## Decision log

- **2026-05-06**: Chose Option A (simple symmetry) for bug 6 fix. NCA indexes 149
  nodes, rebuild takes <5ms. Incremental architecture documented here for future.
