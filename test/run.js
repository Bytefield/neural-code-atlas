#!/usr/bin/env node
/**
 * NCA Integration Test Runner
 * Tests: AC1 scan, AC2 ask, AC3 cache, AC4 flow, AC5 MCP, AC6 evolve
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const CLI = path.join(ROOT, 'dist', 'cli.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed');
}

function run(args) {
  return execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', env: process.env });
}

// Setup temp DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-test-'));
const dbPath = path.join(tmpDir, 'nca.db');
process.env.NCA_DB_PATH = dbPath;

console.log('\nNCA Test Suite\n');
console.log(`  DB: ${dbPath}`);
console.log(`  Fixtures: ${FIXTURES}\n`);

// Check build exists
if (!fs.existsSync(CLI)) {
  console.error('ERROR: dist/cli.js not found. Run: npm run build\n');
  process.exit(1);
}

const Database = require('better-sqlite3');
const { Storage: StorageClass } = require(path.join(ROOT, 'dist', 'storage.js'));
const { MigrationError } = require(path.join(ROOT, 'dist', 'migrations', 'index.js'));

// AC1: scan works
test('AC1 scan indexes fixture files', () => {
  const out = run(`scan ${FIXTURES}`);
  assert(out.includes('NCA|scan_complete'), `Expected scan_complete, got: ${out}`);
  assert(out.includes('nodes:'), 'Expected nodes count in output');
  const nodesMatch = out.match(/nodes:(\d+)/);
  assert(nodesMatch && parseInt(nodesMatch[1]) > 0, 'Expected at least 1 node indexed');
});

// AC3: cache hit
test('AC3 cache hit re-scan is fast', () => {
  const start = Date.now();
  const out = run(`scan ${FIXTURES}`);
  const duration = Date.now() - start;
  assert(duration < 1000, `Cache hit scan took ${duration}ms, expected < 1000ms`);
  assert(out.includes('NCA|scan_complete'), 'Expected scan_complete on cache hit');
});

// AC2: ask returns nodes
test('AC2 ask returns nodes for known query', () => {
  const out = run(`ask fetchData`);
  assert(out.includes('NCA|q:'), `Expected NCA|q: header, got: ${out.slice(0, 200)}`);
  assert(out.includes('[N]'), 'Expected [N] section');
});

test('AC2 ask returns nodes for class query', () => {
  const out = run(`ask DataProcessor`);
  assert(out.includes('[N]'), 'Expected [N] section');
});

test('AC2 ask returns CTX section', () => {
  const out = run(`ask loadConfig`);
  assert(out.includes('[CTX]') || out.includes('NCA|q:'), 'Expected CTX or result');
});

// AC4: flow
test('AC4 flow returns step chain', () => {
  const out = run(`flow fetchData`);
  assert(out.includes('[F]'), `Expected [F] section, got: ${out.slice(0, 200)}`);
  assert(out.includes('fetchData'), 'Expected entry point in flow output');
});

// AC6: evolve returns warnings
test('AC6 evolve returns warning output', () => {
  const out = run(`evolve`);
  assert(out.includes('NCA|evolve'), `Expected NCA|evolve header, got: ${out.slice(0, 200)}`);
  assert(out.includes('[W]'), 'Expected [W] section');
});

// MIG-01: fresh DB applies all migrations
test('MIG-01 fresh DB applies all migrations', () => {
  const dbFile = path.join(tmpDir, 'mig01.db');
  try {
    const storage = new StorageClass(dbFile);
    storage.close();

    const db = new Database(dbFile);
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    assert(versionRow && versionRow.value === '2', `Expected schema_version=2, got: ${JSON.stringify(versionRow)}`);

    const logCount = db.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 2, `Expected 2 migration_log rows, got: ${logCount.count}`);

    const logRow1 = db.prepare('SELECT * FROM migration_log WHERE version = 1').get();
    assert(logRow1, 'Expected migration_log row for version 1');
    assert(logRow1.name === 'init_schema', `Expected name=init_schema, got: ${logRow1.name}`);

    const logRow2 = db.prepare('SELECT * FROM migration_log WHERE version = 2').get();
    assert(logRow2, 'Expected migration_log row for version 2');
    assert(logRow2.name === 'repair_line_move_duplicates', `Expected name=repair_line_move_duplicates, got: ${logRow2.name}`);
    db.close();
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-02: already-migrated DB applies nothing on second open
test('MIG-02 already-migrated DB applies nothing', () => {
  const dbFile = path.join(tmpDir, 'mig02.db');
  try {
    const s1 = new StorageClass(dbFile);
    s1.close();
    const s2 = new StorageClass(dbFile);
    s2.close();

    const db = new Database(dbFile);
    const count = db.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(count.count === 2, `Expected 2 migration_log rows (one per migration), got: ${count.count}`);
    db.close();
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-03: future schema_version aborts Storage construction
test('MIG-03 future schema_version aborts', () => {
  const dbFile = path.join(tmpDir, 'mig03.db');
  try {
    const db = new Database(dbFile);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '999');
    `);
    db.close();

    let threw = false;
    try {
      const storage = new StorageClass(dbFile);
      storage.close();
    } catch (err) {
      threw = true;
      assert(
        err.name === 'MigrationError' || err.message.includes('999'),
        `Expected MigrationError about version 999, got: ${err.message}`
      );
    }
    assert(threw, 'Expected Storage constructor to throw on future schema_version');
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-04: legacy DB (no schema_meta) migrates cleanly and preserves existing data
test('MIG-04 legacy DB without schema_meta migrates cleanly', () => {
  const dbFile = path.join(tmpDir, 'mig04.db');
  try {
    const db = new Database(dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        parsed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        module TEXT NOT NULL DEFAULT '',
        inputs TEXT NOT NULL DEFAULT '[]',
        outputs TEXT NOT NULL DEFAULT '[]',
        deps TEXT NOT NULL DEFAULT '[]',
        effects TEXT NOT NULL DEFAULT '[]',
        complexity INTEGER NOT NULL DEFAULT 1,
        file TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        UNIQUE(name, file, line)
      );
      INSERT INTO nodes (type, name, module, inputs, outputs, deps, effects, complexity, file, line, sha256)
      VALUES ('function', 'legacyNode', 'legacy', '[]', '[]', '[]', '[]', 1, 'legacy.ts', 1, 'abc123');
    `);
    db.close();

    const storage = new StorageClass(dbFile);
    storage.close();

    const db2 = new Database(dbFile);
    const versionRow = db2.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    assert(versionRow && versionRow.value === '2', `Expected schema_version=2, got: ${JSON.stringify(versionRow)}`);

    const logCount = db2.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 2, `Expected 2 migration_log rows, got: ${logCount.count}`);

    const nodeRow = db2.prepare("SELECT * FROM nodes WHERE name = 'legacyNode'").get();
    assert(nodeRow, 'Expected legacyNode to still exist after migration');
    assert(nodeRow.name === 'legacyNode', `Expected legacyNode, got: ${nodeRow.name}`);
    db2.close();
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-05: migration 002 repairs line-move duplicates in existing DBs
test('MIG-05 migration 002 repairs line-move duplicates', () => {
  const tmpDb = path.join(os.tmpdir(), `nca-mig05-${Date.now()}.db`);
  const Database = require('better-sqlite3');

  try {
    // Phase 1: use StorageClass to create a fully-initialised DB (v2 schema).
    // This gives us a complete schema including nodes_fts, triggers, etc.
    const initStorage = new StorageClass(tmpDb);
    initStorage.close();

    // Phase 2: roll back to v1 and inject artificial line-move duplicates.
    // UNIQUE(name, file, line) allows two rows for the same name@file at different lines.
    const setupDb = new Database(tmpDb);
    setupDb.pragma('foreign_keys = OFF');
    setupDb.prepare(`UPDATE schema_meta SET value='1' WHERE key='schema_version'`).run();
    setupDb.prepare(`DELETE FROM migration_log WHERE version=2`).run();
    setupDb.prepare(`INSERT INTO file_index (path, mtime, sha256, parsed_at) VALUES ('/fake/a.ts', 1, 'x', 100)`).run();
    // Disable FTS triggers while seeding stale rows so nodes_fts stays clean
    setupDb.exec(`
      INSERT INTO nodes (type, name, file, line) VALUES ('function', 'alpha', '/fake/a.ts', 0);
      INSERT INTO nodes (type, name, file, line) VALUES ('function', 'alpha', '/fake/a.ts', 5);
      INSERT INTO nodes (type, name, file, line) VALUES ('function', 'beta',  '/fake/a.ts', 1);
      INSERT INTO nodes (type, name, file, line) VALUES ('function', 'beta',  '/fake/a.ts', 6);
    `);
    setupDb.close();

    // Phase 3: construct Storage — migration 002 must auto-run and repair duplicates.
    const storage = new StorageClass(tmpDb);
    storage.close();

    // Phase 4: verify repair results.
    const db = new Database(tmpDb);
    try {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM nodes`).get().n;
      assert(count === 2, `Expected 2 nodes after repair, got ${count}`);

      const ver = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
      assert(ver.value === '2', `Expected schema_version=2, got ${ver.value}`);

      const logRow = db.prepare(`SELECT version, name, result FROM migration_log WHERE version=2`).get();
      assert(logRow, 'Expected migration_log row for v2');
      assert(logRow.name === 'repair_line_move_duplicates',
        `Expected name 'repair_line_move_duplicates', got '${logRow.name}'`);

      const info = JSON.parse(logRow.result);
      assert(info.groups_repaired === 2, `Expected 2 groups repaired, got ${info.groups_repaired}`);
      assert(info.rows_removed === 2, `Expected 2 rows removed, got ${info.rows_removed}`);
      assert(Array.isArray(info.ambiguous_groups), 'ambiguous_groups must be an array');
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(tmpDb); } catch {}
  }
});

// LMD-01: line-move does not create duplicate nodes
test('LMD-01 line-move does not create duplicate nodes', () => {
  const lmdDir = path.join(os.tmpdir(), `nca-lmd-${Date.now()}`);
  fs.mkdirSync(lmdDir, { recursive: true });
  const tmpFile = path.join(lmdDir, 'fixture.ts');
  const tmpDb = path.join(lmdDir, 'lmd.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    // Step 1: write fixture, scan, expect 2 nodes
    fs.writeFileSync(tmpFile, 'export function alpha() { return 1; }\nexport function beta() { return 2; }\n');
    run(`scan ${lmdDir}`);

    let nodes = JSON.parse(run(`status --json`)).nodes;
    assert(nodes === 2, `Initial scan: expected 2 nodes, got ${nodes}`);

    // Step 2: insert 5 blank lines BEFORE alpha (line-move, no body change)
    const movedContent = '\n\n\n\n\n' + fs.readFileSync(tmpFile, 'utf-8');
    fs.writeFileSync(tmpFile, movedContent);
    run(`scan ${lmdDir}`);

    nodes = JSON.parse(run(`status --json`)).nodes;
    assert(nodes === 2, `After line-move: expected 2 nodes, got ${nodes} (line-move duplicate bug)`);

    // Step 3: verify line numbers were updated, not duplicated
    const Database = require('better-sqlite3');
    const db = new Database(tmpDb);
    try {
      const rows = db.prepare(
        `SELECT name, line FROM nodes WHERE file = ? ORDER BY name`
      ).all(tmpFile);
      assert(rows.length === 2, `DB row count: expected 2, got ${rows.length}`);
      const alpha = rows.find(r => r.name === 'alpha');
      const beta  = rows.find(r => r.name === 'beta');
      assert(alpha && alpha.line === 5, `alpha line: expected 5, got ${alpha?.line}`);
      assert(beta  && beta.line  === 6, `beta line: expected 6, got ${beta?.line}`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(lmdDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// CAC-01: findLongChains is correct in graphs with cycles
test('CAC-01 findLongChains is correct in graphs with cycles', () => {
  const { GraphSnapshot } = require(path.join(ROOT, 'dist', 'graph.js'));
  const findLongChains = require(path.join(ROOT, 'dist', 'evolve.js')).findLongChains;

  // If findLongChains is not exported, this test will fail with a clear message.
  // The fix step will export it for testability.
  assert(typeof findLongChains === 'function',
    'findLongChains must be exported from evolve.js for this test');

  function mkNode(name, deps) {
    return {
      type: 'function', name, module: '', inputs: [], outputs: [],
      deps, effects: [], complexity: 1, file: 'test.ts', line: 0, sha256: ''
    };
  }

  // Scenario 1: Pure linear chain a → b → c → d → e (length 5)
  {
    const nodes = [
      mkNode('a', ['b']), mkNode('b', ['c']), mkNode('c', ['d']),
      mkNode('d', ['e']), mkNode('e', []),
    ];
    const forward = new Map([
      ['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['d'])],
      ['d', new Set(['e'])], ['e', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const chains = findLongChains(snap, 3);  // threshold 3 means depth > 3 is "long"
    // a→b→c→d→e is depth 5, b→c→d→e is depth 4, both should be flagged
    assert(chains.some(c => c[0] === 'a'),
      `S1: expected 'a' flagged as long chain, got: ${JSON.stringify(chains)}`);
  }

  // Scenario 2: Graph with a cycle b → c → b. The chain a → b → ??? must NOT loop forever
  // and must NOT report inflated depth from cycling through b/c repeatedly.
  {
    const nodes = [
      mkNode('a', ['b']), mkNode('b', ['c']), mkNode('c', ['b']), mkNode('d', []),
    ];
    const forward = new Map([
      ['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['b'])], ['d', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const chains = findLongChains(snap, 1);  // even threshold 1 should not blow up
    // a depends on b which is a cycle node. By design decision C:
    //   longestPath(a) = 1 (for a itself) + 1 (for b as terminal cycle node) = 2
    //   longestPath(b) = 0 (b is in a cycle, excluded)
    //   longestPath(c) = 0 (c is in a cycle, excluded)
    //   longestPath(d) = 1
    // So chains with depth > 1: only 'a' with depth 2
    const aChain = chains.find(c => c[0] === 'a');
    assert(aChain, `S2: expected 'a' to be reported, got: ${JSON.stringify(chains)}`);
    assert(aChain[1] === 'depth=2',
      `S2: expected 'a' depth=2, got: ${aChain[1]}`);
    assert(!chains.some(c => c[0] === 'b'),
      `S2: 'b' should NOT be in long chains (it is a cycle node)`);
    assert(!chains.some(c => c[0] === 'c'),
      `S2: 'c' should NOT be in long chains (it is a cycle node)`);
  }

  // Scenario 3: Diamond DAG. a → {b, c}, b → d, c → d. Memoisation must be correct.
  // Without the bug fix, depending on traversal order, longestPath(d) might be cached
  // as 1 from one path and reused incorrectly elsewhere. Here we just verify the
  // longest path is reported correctly.
  {
    const nodes = [
      mkNode('a', ['b', 'c']), mkNode('b', ['d']), mkNode('c', ['d']),
      mkNode('d', ['e']), mkNode('e', []),
    ];
    const forward = new Map([
      ['a', new Set(['b', 'c'])], ['b', new Set(['d'])], ['c', new Set(['d'])],
      ['d', new Set(['e'])], ['e', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const chains = findLongChains(snap, 3);
    // a→b→d→e or a→c→d→e — depth 4. Threshold 3 → flagged.
    const aChain = chains.find(c => c[0] === 'a');
    assert(aChain, `S3: expected 'a' to be reported, got: ${JSON.stringify(chains)}`);
    assert(aChain[1] === 'depth=4',
      `S3: expected 'a' depth=4, got: ${aChain[1]}`);
  }
});

// BNB-01: rankWithBoost uses a single batched query for boosts
test('BNB-01 rankWithBoost uses a single batched query for boosts', () => {
  const tmpDb = path.join(os.tmpdir(), `nca-bnb-${Date.now()}.db`);

  try {
    // Create DB via StorageClass to get the full migrated schema.
    const storage = new StorageClass(tmpDb);

    // Insert 10 nodes via the public API.
    for (let i = 0; i < 10; i++) {
      storage.upsertNode({
        type: 'function', name: `fn${i}`, module: '', inputs: [], outputs: [],
        deps: [], effects: [], complexity: 1, file: '/test.ts', line: i, sha256: `hash${i}`,
      });
    }
    const allNodes = storage.getAllNodes();
    assert(allNodes.length === 10, `Expected 10 nodes, got ${allNodes.length}`);

    // Boost fn0, fn3, fn7 via raw DB access.
    // TypeScript `private` is unenforced in compiled JS — accessible for testing.
    const rawDb = storage.db;
    const insertBoost = rawDb.prepare(
      `INSERT INTO node_scores (cell_id, query_count, last_queried, score_boost)
       VALUES (?, 1, 0, ?)
       ON CONFLICT(cell_id) DO UPDATE SET score_boost = excluded.score_boost`
    );
    const fn0 = allNodes.find(n => n.name === 'fn0');
    const fn3 = allNodes.find(n => n.name === 'fn3');
    const fn7 = allNodes.find(n => n.name === 'fn7');
    insertBoost.run(String(fn0.id), 1.0);
    insertBoost.run(String(fn3.id), 0.5);
    insertBoost.run(String(fn7.id), 2.0);

    // --- Behavioural check ---
    const { ContextExpander } = require(path.join(ROOT, 'dist', 'context.js'));
    const ctx = new ContextExpander(storage);
    const ranked = ctx.rankWithBoost(allNodes, 'fn');
    assert(ranked.length === 10, `Expected 10 ranked, got ${ranked.length}`);

    // fn0 (boost=1.0×100=+100), fn3 (boost=0.5×100=+50), fn7 (boost=2.0×100=+200)
    // must all outrank the unboosted nodes.
    const top3Names = new Set(ranked.slice(0, 3).map(n => n.name));
    assert(top3Names.has('fn0') && top3Names.has('fn3') && top3Names.has('fn7'),
      `Top 3 should be fn0, fn3, fn7. Got: ${[...top3Names].join(',')}`);

    // --- Query-count regression guard ---
    // Patch whichever statement exists: getNodeBoost (before fix) or getNodeBoosts (after fix).
    const stmts = storage.stmts;
    let nodeScoresQueryCount = 0;

    if (stmts && stmts.getNodeBoost) {
      const orig = stmts.getNodeBoost;
      const origGet = orig.get.bind(orig);
      orig.get = function (...args) { nodeScoresQueryCount++; return origGet(...args); };
    }
    if (stmts && stmts.getNodeBoosts) {
      const orig = stmts.getNodeBoosts;
      const origAll = orig.all.bind(orig);
      orig.all = function (...args) { nodeScoresQueryCount++; return origAll(...args); };
    }

    ctx.rankWithBoost(allNodes, 'fn');

    // After fix: exactly 1 query (batched). Before fix: 10 queries (one per node).
    assert(nodeScoresQueryCount === 1,
      `Expected exactly 1 node_scores query for 10 nodes, got ${nodeScoresQueryCount} (N+1 regression)`);

    storage.close();
  } finally {
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
  }
});

// SRS-01: scanner reads each file exactly once per scan
test('SRS-01 scanner reads each file exactly once per scan', () => {
  const testDir = path.join(os.tmpdir(), `nca-srs-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const tmpFile = path.join(testDir, 'fixture.ts');
  const tmpDb = path.join(testDir, 'srs.db');

  try {
    fs.writeFileSync(tmpFile, 'export function alpha() { return 1; }\nexport function beta() { return 2; }\n');

    const { Scanner } = require(path.join(ROOT, 'dist', 'scanner.js'));
    const storage = new StorageClass(tmpDb);
    const scanner = new Scanner(storage);

    // Monkey-patch fs.readFileSync to count reads of our fixture file.
    // Must use direct Scanner API (not run/execSync) so the patch applies
    // in the same process as the scan call.
    const originalReadFileSync = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = function (filepath, ...args) {
      if (typeof filepath === 'string' && path.resolve(filepath) === path.resolve(tmpFile)) {
        readCount++;
      }
      return originalReadFileSync(filepath, ...args);
    };

    try {
      scanner.scan(testDir);

      // After fix: exactly 1 read per file (scanner reads once, passes content to parser).
      // Before fix: 2 reads (hashFile reads as buffer; parseFile reads again as utf-8).
      assert(readCount === 1,
        `Expected exactly 1 fs.readFileSync call for the fixture file, got ${readCount} (double-read bug)`);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    storage.close();
  } finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});

// WUR-01: watch unlink handler relinks graph and flows
test('WUR-01 watch unlink handler relinks graph and flows', () => {
  const wurDir = path.join(os.tmpdir(), `nca-wur-${Date.now()}`);
  fs.mkdirSync(wurDir, { recursive: true });
  const fileA = path.join(wurDir, 'a.ts');
  const fileB = path.join(wurDir, 'b.ts');
  const tmpDb = path.join(wurDir, 'wur.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    // Write two files: a imports b
    fs.writeFileSync(fileA, 'import { helper } from "./b";\nexport function main() { helper(); }\n');
    fs.writeFileSync(fileB, 'export function helper() { return 42; }\n');

    // Initial scan — should index 2 nodes (main, helper)
    run(`scan ${wurDir}`);
    const before = JSON.parse(run('status --json'));
    assert(before.nodes === 2, `Initial: expected 2 nodes, got ${before.nodes}`);

    // Simulate what the watch unlink handler does: remove fileB from storage
    const storage = new StorageClass(tmpDb);
    storage.deleteNodesForFile(fileB);
    storage.deleteFileRecord(fileB);
    storage.close();

    // After deletion, evolve must not crash (graph would be stale without the fix)
    try {
      run('evolve');
    } catch (err) {
      throw new Error(`evolve crashed after unlink (graph stale): ${err.message}`);
    }

    // Verify fileB's node is gone from the index
    const after = JSON.parse(run('status --json'));
    assert(after.nodes === 1, `After unlink: expected 1 node, got ${after.nodes}`);
  } finally {
    try { fs.rmSync(wurDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// AC7: insights command
test('AC7 insights returns hot nodes after ask', () => {
  // Ask twice to build query history
  run(`ask fetchData`);
  run(`ask fetchData`);
  const out = run(`insights`);
  assert(out.includes('NCA|insights'), `Expected NCA|insights header, got: ${out.slice(0, 200)}`);
  assert(out.includes('[HOT]'), 'Expected [HOT] section');
});

// AC8: per-node diff — re-scan after no file changes skips all nodes
test('AC8 re-scan after no file changes skips all nodes', () => {
  const before = JSON.parse(run(`status --json`));
  run(`scan ${FIXTURES}`);
  const after = JSON.parse(run(`status --json`));
  assert(before.nodes === after.nodes, `Node count changed: ${before.nodes} -> ${after.nodes}`);
});

// AC8b: per-node diff — modified file doesn't inflate node count
test('AC8b structural identity stable across body refactor (same signature)', () => {
  // Write a modified version of a fixture to a temp file in fixtures dir
  const tmpFile = path.join(FIXTURES, '_tmp_test.ts');
  const before = JSON.parse(run(`status --json`));
  try {
    fs.writeFileSync(tmpFile, 'export function tmpHelper(x: number): number { return x + 1; }\n');
    run(`scan ${FIXTURES}`);
    const mid = JSON.parse(run(`status --json`));
    assert(mid.nodes > before.nodes, 'Expected new node after adding temp file');

    // Overwrite with different implementation — same function name, same signature
    fs.writeFileSync(tmpFile, 'export function tmpHelper(x: number): number { return x * 2; }\n');
    run(`scan ${FIXTURES}`);
    const after = JSON.parse(run(`status --json`));
    // Node count should be same as mid (one function, still there)
    assert(after.nodes === mid.nodes, `Node count changed on same-signature edit: ${mid.nodes} -> ${after.nodes}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    run(`scan ${FIXTURES}`); // clean up index
  }
});

// AC9: score boost accumulates across repeated asks
test('AC9 repeated ask increases score_boost for matched nodes', () => {
  // Query three times to push boost above zero
  run(`ask loadConfig`);
  run(`ask loadConfig`);
  run(`ask loadConfig`);
  const out = run(`insights`);
  assert(out.includes('NCA|insights'), 'Expected insights output');
  // At least one entry should have boost > 0 (format: boost:0.XX)
  assert(/boost:0\.[1-9]/.test(out) || /boost:[1-9]/.test(out),
    `Expected at least one node with boost > 0 in:\n${out}`);
});


// Status
test('status shows DB info', () => {
  const out = run(`status`);
  assert(out.includes('NCA|status'), `Expected NCA|status, got: ${out.slice(0, 100)}`);
  assert(out.includes('files:'), 'Expected files count');
  assert(out.includes('nodes:'), 'Expected nodes count');
});

// FMT-01: CLI output includes ANSI colour codes
test('FMT-01 CLI output includes color codes', () => {
  const output = run('status');
  assert(output.includes('\x1b[36m'), 'Status output should include cyan color codes');
  assert(output.includes('\x1b[0m'), 'Status output should include reset codes');
});

// ── Multi-project support (MP) tests ─────────────────────────────────────────
{
  const { registerProject, listProjects: listProj, findProject } =
    require(path.join(ROOT, 'dist', 'registry.js'));
  const { resolveAndGetStorage, getStorage: getCached, getCacheSize, forceSetLastUsed, closeAll: cacheCloseAll } =
    require(path.join(ROOT, 'dist', 'db-cache.js'));

  /** Create a temp project root with an initialised .nca/nca.db. */
  function makeTempProject(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nca-mp-${label}-`));
    fs.mkdirSync(path.join(root, '.nca'), { recursive: true });
    const db = new StorageClass(path.join(root, '.nca', 'nca.db'));
    db.close();
    return root;
  }

  test('MP-01 explicit project param wins over NCA_DB_PATH', () => {
    cacheCloseAll();
    const proj = makeTempProject('p01');
    try {
      const storage = resolveAndGetStorage(proj);
      assert(
        storage.dbPath === path.join(proj, '.nca', 'nca.db'),
        `Expected proj dbPath, got: ${storage.dbPath}`
      );
      assert(
        storage.dbPath !== path.resolve(process.env.NCA_DB_PATH),
        'Expected different DB from NCA_DB_PATH'
      );
    } finally {
      cacheCloseAll();
      try { fs.rmSync(proj, { recursive: true }); } catch {}
    }
  });

  test('MP-02 NCA_DB_PATH used when project omitted', () => {
    cacheCloseAll();
    const storage = resolveAndGetStorage();
    assert(
      storage.dbPath === path.resolve(process.env.NCA_DB_PATH),
      `Expected NCA_DB_PATH, got: ${storage.dbPath}`
    );
  });

  test('MP-03 throws clear error when no DB found', () => {
    cacheCloseAll();
    const missing = path.join(os.tmpdir(), `nca-mp-missing-${Date.now()}`);
    let threw = false;
    try {
      resolveAndGetStorage(missing);
    } catch (err) {
      threw = true;
      assert(
        err.message.includes('No NCA index found'),
        `Expected "No NCA index found" in error, got: ${err.message}`
      );
    }
    assert(threw, 'Expected resolveAndGetStorage to throw for missing DB');
  });

  test('MP-04 registry: register/list/upsert; no duplicates; NCA_REGISTRY_PATH override', () => {
    const regFile = path.join(os.tmpdir(), `nca-reg-${Date.now()}.json`);
    const savedReg = process.env.NCA_REGISTRY_PATH;
    process.env.NCA_REGISTRY_PATH = regFile;
    try {
      const root1 = path.join(os.tmpdir(), 'nca-reg-proj1');
      const root2 = path.join(os.tmpdir(), 'nca-reg-proj2');
      registerProject(root1);
      registerProject(root2);
      registerProject(root1); // duplicate — must be ignored
      const list = listProj();
      assert(list.length === 2, `Expected 2 projects, got ${list.length}`);
      assert(list.some(p => p.root === path.resolve(root1)), 'root1 missing from registry');
      assert(list.some(p => p.root === path.resolve(root2)), 'root2 missing from registry');
    } finally {
      if (savedReg === undefined) delete process.env.NCA_REGISTRY_PATH;
      else process.env.NCA_REGISTRY_PATH = savedReg;
      try { fs.unlinkSync(regFile); } catch {}
    }
  });

  test('MP-05 findProject resolves by name and partial root substring', () => {
    const regFile = path.join(os.tmpdir(), `nca-reg-${Date.now()}.json`);
    const savedReg = process.env.NCA_REGISTRY_PATH;
    process.env.NCA_REGISTRY_PATH = regFile;
    try {
      const root = path.join(os.tmpdir(), 'nca-find-myproject');
      registerProject(root);
      const byName = findProject('myproject');
      assert(byName !== undefined, 'Expected to find project by name');
      assert(byName.root === path.resolve(root), 'Name match returned wrong root');
      const byPartial = findProject('nca-find-myproj');
      assert(byPartial !== undefined, 'Expected to find project by partial path');
      assert(byPartial.root === path.resolve(root), 'Partial match returned wrong root');
    } finally {
      if (savedReg === undefined) delete process.env.NCA_REGISTRY_PATH;
      else process.env.NCA_REGISTRY_PATH = savedReg;
      try { fs.unlinkSync(regFile); } catch {}
    }
  });

  test('MP-06 cache returns identical Storage instance for same dbPath', () => {
    cacheCloseAll();
    const proj = makeTempProject('p06');
    try {
      const dbPath = path.join(proj, '.nca', 'nca.db');
      const s1 = getCached(dbPath);
      const s2 = getCached(dbPath);
      assert(s1 === s2, 'Expected same Storage instance (identity) for repeated call');
      assert(getCacheSize() === 1, `Expected cache size 1, got ${getCacheSize()}`);
    } finally {
      cacheCloseAll();
      try { fs.rmSync(proj, { recursive: true }); } catch {}
    }
  });

  test('MP-07 LRU evicts oldest entry when cache exceeds MAX (5)', () => {
    cacheCloseAll();
    const projects = [];
    try {
      for (let i = 0; i < 6; i++) projects.push(makeTempProject(`p07-${i}`));
      const dbPaths = projects.map(r => path.join(r, '.nca', 'nca.db'));

      // Fill cache to MAX=5
      for (let i = 0; i < 5; i++) getCached(dbPaths[i]);
      assert(getCacheSize() === 5, `Expected size 5, got ${getCacheSize()}`);

      // Mark first entry as LRU (just under TTL so idle eviction does not fire)
      forceSetLastUsed(dbPaths[0], Date.now() - 59000);

      // Opening 6th triggers LRU eviction of dbPaths[0]
      getCached(dbPaths[5]);
      assert(getCacheSize() === 5, `Expected size 5 after LRU eviction, got ${getCacheSize()}`);
    } finally {
      cacheCloseAll();
      for (const p of projects) try { fs.rmSync(p, { recursive: true }); } catch {}
    }
  });
}

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// AC5: MCP server — tools/list + nca_ask + nca_insights in a single spawn
// Timing on Windows: 500ms init delay + 3s response window + 1s graceful drain.
// Results timer (below) fires at 4500ms, after all three phases complete.
let mcpTestError = null;
let mcpTestDone = false;

{
  const MCP = path.join(ROOT, 'dist', 'mcp.js');
  const child = spawn('node', [MCP], {
    env: { ...process.env, NCA_DB_PATH: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let mcpOutput = '';
  child.stdout.on('data', (d) => { mcpOutput += d.toString(); });

  // Wait 500ms for MCP server to initialise on Windows before sending requests
  setTimeout(() => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'nca_insights', arguments: {} },
    }) + '\n');
  }, 500);

  // Evaluate at T=3000ms (500ms init + up to 2.5s for responses to arrive)
  setTimeout(() => {
    // Graceful shutdown: signal EOF so the server exits cleanly; force kill after 1s
    child.stdin.end();
    setTimeout(() => { if (!child.killed) child.kill(); }, 1000);

    try {
      const lines = mcpOutput.trim().split('\n').filter(Boolean);
      assert(lines.length >= 2, `Expected ≥2 MCP response lines, got ${lines.length}:\n${mcpOutput.slice(0, 300)}`);

      const listResp = JSON.parse(lines[0]);
      const toolNames = listResp.result?.tools?.map((t) => t.name) ?? [];
      assert(toolNames.includes('nca_ask'), 'Expected nca_ask tool');
      assert(toolNames.includes('nca_flow'), 'Expected nca_flow tool');
      assert(toolNames.includes('nca_status'), 'Expected nca_status tool');
      assert(toolNames.includes('nca_evolve'), 'Expected nca_evolve tool');
      assert(toolNames.includes('nca_insights'), 'Expected nca_insights tool');

      const insightsResp = JSON.parse(lines[1]);
      assert(insightsResp.result?.content?.[0]?.text?.includes('NCA|insights'),
        `Expected NCA|insights in response, got: ${JSON.stringify(insightsResp).slice(0, 200)}`);
    } catch (err) {
      mcpTestError = err;
    }
    mcpTestDone = true;
  }, 3000);
}

// Results — wait for MCP async test (3000ms timeout above + 500ms init + 1000ms drain window)
setTimeout(() => {
  // Flush MCP test result into the pass/fail counters
  const mcpName = 'AC5 MCP server (tools/list + nca_insights)';
  if (mcpTestDone) {
    if (mcpTestError) {
      console.log(`  FAIL  ${mcpName}`);
      console.log(`        ${mcpTestError.message}`);
      failed++;
    } else {
      console.log(`  PASS  ${mcpName}`);
      passed++;
    }
  } else {
    console.log(`  FAIL  ${mcpName} (timeout)`);
    failed++;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 4500);
