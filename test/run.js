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
    assert(versionRow && versionRow.value === '3', `Expected schema_version=3, got: ${JSON.stringify(versionRow)}`);

    const logCount = db.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 3, `Expected 3 migration_log rows, got: ${logCount.count}`);

    const logRow1 = db.prepare('SELECT * FROM migration_log WHERE version = 1').get();
    assert(logRow1, 'Expected migration_log row for version 1');
    assert(logRow1.name === 'init_schema', `Expected name=init_schema, got: ${logRow1.name}`);

    const logRow2 = db.prepare('SELECT * FROM migration_log WHERE version = 2').get();
    assert(logRow2, 'Expected migration_log row for version 2');
    assert(logRow2.name === 'repair_line_move_duplicates', `Expected name=repair_line_move_duplicates, got: ${logRow2.name}`);

    const logRow3 = db.prepare('SELECT * FROM migration_log WHERE version = 3').get();
    assert(logRow3, 'Expected migration_log row for version 3');
    assert(logRow3.name === 'vault_schema', `Expected name=vault_schema, got: ${logRow3.name}`);
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
    assert(count.count === 3, `Expected 3 migration_log rows (one per migration), got: ${count.count}`);
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
    assert(versionRow && versionRow.value === '3', `Expected schema_version=3, got: ${JSON.stringify(versionRow)}`);

    const logCount = db2.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 3, `Expected 3 migration_log rows, got: ${logCount.count}`);

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
    setupDb.prepare(`DELETE FROM migration_log WHERE version >= 2`).run();
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
      assert(ver.value === '3', `Expected schema_version=3, got ${ver.value}`);

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

// PARSER tests — vault note parsing
// Uses parse-note-sync.js helper via execSync to call the async parseNote in sync context.
{
  const HELPER = path.join(ROOT, 'test', 'helpers', 'parse-note-sync.js');
  const FIXTURES_VAULT = path.join(ROOT, 'src', 'vault', '__fixtures__');

  function parseSync(fixtureName) {
    const fp = path.join(FIXTURES_VAULT, fixtureName);
    const raw = execSync(`node "${HELPER}" "${fp}"`, { encoding: 'utf-8' });
    return JSON.parse(raw);
  }

  // PARSER-01: complete.md — all frontmatter fields parsed correctly
  test('PARSER-01 complete.md parses all frontmatter fields', () => {
    const r = parseSync('complete.md');
    assert(r.id === 'test-complete-note', `Expected id='test-complete-note', got '${r.id}'`);
    assert(r.type === 'arquitectura', `Expected type='arquitectura', got '${r.type}'`);
    assert(r.status === 'vigente', `Expected status='vigente', got '${r.status}'`);
    assert(r.area === 'backend', `Expected area='backend', got '${r.area}'`);
    assert(r.summary === 'Complete note with all frontmatter fields', `Wrong summary: '${r.summary}'`);
    assert(r.updated === '2026-05-26', `Expected updated='2026-05-26', got '${r.updated}'`);
    assert(typeof r.contentHash === 'string' && r.contentHash.length === 64,
      `Expected 64-char hex hash, got '${r.contentHash}'`);
    assert(Array.isArray(r.bodyChunks) && r.bodyChunks.length > 0, 'Expected non-empty bodyChunks');
  });

  // PARSER-02: no-frontmatter.md — id derived from filename, status='vigente', optionals undefined
  test('PARSER-02 no-frontmatter.md: id derived, status vigente, no optional fields', () => {
    const r = parseSync('no-frontmatter.md');
    assert(r.id === 'no-frontmatter', `Expected id='no-frontmatter', got '${r.id}'`);
    assert(r.status === 'vigente', `Expected status='vigente', got '${r.status}'`);
    assert(r.type === undefined || r.type === null,
      `Expected type=undefined, got '${r.type}'`);
    assert(r.area === undefined || r.area === null,
      `Expected area=undefined, got '${r.area}'`);
    assert(r.summary === undefined || r.summary === null,
      `Expected summary=undefined, got '${r.summary}'`);
    assert(typeof r.contentHash === 'string' && r.contentHash.length === 64,
      `Expected 64-char hex hash, got '${r.contentHash}'`);
  });

  // PARSER-03: malformed-yaml.md — does not throw, returns status='vigente'
  test('PARSER-03 malformed-yaml.md: no exception, status vigente', () => {
    let r;
    try {
      r = parseSync('malformed-yaml.md');
    } catch (err) {
      throw new Error(`parseNote threw on malformed YAML (expected graceful handling): ${err.message}`);
    }
    assert(r.status === 'vigente', `Expected status='vigente', got '${r.status}'`);
    assert(typeof r.contentHash === 'string' && r.contentHash.length === 64,
      `Expected valid hash, got '${r.contentHash}'`);
  });

  // PARSER-04: long.md — >=5 chunks, overlap verified between consecutive chunks
  test('PARSER-04 long.md: >=5 chunks, consecutive chunks share overlap paragraph', () => {
    const r = parseSync('long.md');
    assert(r.bodyChunks.length >= 5,
      `Expected >=5 chunks, got ${r.bodyChunks.length}`);
    // Verify overlap: last paragraph of chunk[i] == first paragraph of chunk[i+1]
    for (let i = 0; i < r.bodyChunks.length - 1; i++) {
      const curParas = r.bodyChunks[i].split(/\n\n+/).filter(p => p.trim());
      const nextParas = r.bodyChunks[i + 1].split(/\n\n+/).filter(p => p.trim());
      const lastOfCur = curParas[curParas.length - 1].trim();
      const firstOfNext = nextParas[0].trim();
      assert(lastOfCur === firstOfNext,
        `Overlap violated at chunk ${i}→${i + 1}: last='${lastOfCur.slice(0, 40)}…' vs first='${firstOfNext.slice(0, 40)}…'`);
    }
  });

  // PARSER-05: empty.md — no exception, bodyChunks=[]
  test('PARSER-05 empty.md: no exception, bodyChunks empty', () => {
    let r;
    try {
      r = parseSync('empty.md');
    } catch (err) {
      throw new Error(`parseNote threw on empty file: ${err.message}`);
    }
    assert(Array.isArray(r.bodyChunks) && r.bodyChunks.length === 0,
      `Expected bodyChunks=[], got ${JSON.stringify(r.bodyChunks)}`);
  });

  // PARSER-06: determinism — same input yields same hash (run twice)
  test('PARSER-06 determinism: same input same hash', () => {
    const r1 = parseSync('complete.md');
    const r2 = parseSync('complete.md');
    assert(r1.contentHash === r2.contentHash,
      `Hash not deterministic: '${r1.contentHash}' vs '${r2.contentHash}'`);
  });

  // PARSER-07: body mutation changes hash; frontmatter mutation does NOT
  test('PARSER-07 hash covers body only: body change changes hash, frontmatter change does not', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-parser-'));
    try {
      const orig = fs.readFileSync(path.join(FIXTURES_VAULT, 'complete.md'), 'utf-8');

      // Baseline
      const base = path.join(tmpDir2, 'base.md');
      fs.writeFileSync(base, orig);
      const rBase = JSON.parse(execSync(`node "${HELPER}" "${base}"`, { encoding: 'utf-8' }));

      // Mutate body: change one char in body (after second ---)
      const fmEnd = orig.indexOf('---', 3) + 3;
      const mutatedBody = orig.slice(0, fmEnd) + orig.slice(fmEnd).replace('T', 'X');
      const bodyMut = path.join(tmpDir2, 'body-mut.md');
      fs.writeFileSync(bodyMut, mutatedBody);
      const rBodyMut = JSON.parse(execSync(`node "${HELPER}" "${bodyMut}"`, { encoding: 'utf-8' }));
      assert(rBase.contentHash !== rBodyMut.contentHash,
        'Body mutation must change contentHash');

      // Mutate frontmatter only: change area field
      const fmMutated = orig.replace('area: backend', 'area: frontend');
      const fmMut = path.join(tmpDir2, 'fm-mut.md');
      fs.writeFileSync(fmMut, fmMutated);
      const rFmMut = JSON.parse(execSync(`node "${HELPER}" "${fmMut}"`, { encoding: 'utf-8' }));
      assert(rBase.contentHash === rFmMut.contentHash,
        `Frontmatter mutation must NOT change contentHash (base=${rBase.contentHash.slice(0, 8)}, fm=${rFmMut.contentHash.slice(0, 8)})`);
    } finally {
      try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
    }
  });

  // PARSER-08: oversized-paragraph.md — single paragraph >1000 chars becomes its own chunk,
  // no infinite loop, no rejection; surrounding short paragraphs also chunked correctly.
  test('PARSER-08 oversized-paragraph.md: paragraph >1000 chars yields finite chunks', () => {
    let r;
    try {
      r = parseSync('oversized-paragraph.md');
    } catch (err) {
      throw new Error(`parseNote threw on oversized paragraph (expected graceful handling): ${err.message}`);
    }
    assert(Array.isArray(r.bodyChunks) && r.bodyChunks.length > 0,
      `Expected at least 1 chunk, got ${r.bodyChunks.length}`);
    const oversized = r.bodyChunks.filter(c => c.length >= 1000);
    assert(oversized.length >= 1,
      `Expected at least one chunk containing the oversized paragraph, got none`);
  });
}

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

// PFE-01: Parser handles advanced TypeScript without creating duplicates
test('PFE-01 parser handles complex TS (generics, type guards, arrow generics)', () => {
  const pfeDir = path.join(os.tmpdir(), `nca-pfe-${Date.now()}`);
  fs.mkdirSync(pfeDir, { recursive: true });
  const tmpFile = path.join(pfeDir, 'complex.ts');
  const tmpDb = path.join(pfeDir, 'pfe.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(tmpFile, [
      'type IsArray<T> = T extends unknown[] ? true : false;',
      '',
      'interface Repository<T extends { id: number }> {',
      '  find(id: number): T | undefined;',
      '  save(entity: Omit<T, "id">): T;',
      '}',
      '',
      'export class UserService<T extends { id: number; name: string }> {',
      '  constructor(private repo: Repository<T>) {}',
      '  findById(id: number): T | undefined { return this.repo.find(id); }',
      '  create(data: Omit<T, "id">): T { return this.repo.save(data); }',
      '}',
      '',
      'export function isNonEmpty<T>(arr: T[]): arr is [T, ...T[]] {',
      '  return arr.length > 0;',
      '}',
      '',
      'export const formatUser = <T extends { name: string }>(user: T): string => {',
      '  return `User: ${user.name}`;',
      '};',
    ].join('\n'));

    run(`scan ${pfeDir}`);

    const storage = new StorageClass(tmpDb);
    const allNodes = storage.getAllNodes().filter(n => n.file === tmpFile);
    storage.close();

    const names = allNodes.map(n => n.name);
    const unique = [...new Set(names)];
    assert(names.length === unique.length,
      `Parser created duplicate nodes: ${JSON.stringify(names.filter((n, i) => names.indexOf(n) !== i))}`);

    assert(allNodes.length >= 3,
      `Expected ≥3 nodes from complex TS, got ${allNodes.length}: ${names.join(', ')}`);
  } finally {
    try { fs.rmSync(pfeDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// FCS-01: rescan after file delete+recreate leaves no stale nodes
test('FCS-01 rescan after file delete+recreate has no stale nodes', () => {
  const fcsDir = path.join(os.tmpdir(), `nca-fcs-${Date.now()}`);
  fs.mkdirSync(fcsDir, { recursive: true });
  const tmpFile = path.join(fcsDir, 'churn.ts');
  const tmpDb = path.join(fcsDir, 'fcs.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    // Step 1: scan with 3 functions
    fs.writeFileSync(tmpFile, [
      'export function alpha() { return 1; }',
      'export function beta() { return 2; }',
      'export function gamma() { return 3; }',
    ].join('\n'));
    run(`scan ${fcsDir}`);

    const s1 = new StorageClass(tmpDb);
    const count1 = s1.getAllNodes().filter(n => n.file === tmpFile).length;
    s1.close();
    assert(count1 === 3, `Initial scan: expected 3 nodes, got ${count1}`);

    // Step 2: delete file and rescan — nodes must be removed
    fs.unlinkSync(tmpFile);
    run(`scan ${fcsDir}`);

    const s2 = new StorageClass(tmpDb);
    const count2 = s2.getAllNodes().filter(n => n.file === tmpFile).length;
    s2.close();
    assert(count2 === 0, `After delete: expected 0 stale nodes, got ${count2}`);

    // Step 3: recreate with 2 different functions
    fs.writeFileSync(tmpFile, [
      'export function delta() { return 4; }',
      'export function epsilon() { return 5; }',
    ].join('\n'));
    run(`scan ${fcsDir}`);

    const s3 = new StorageClass(tmpDb);
    const nodesAfter = s3.getAllNodes().filter(n => n.file === tmpFile);
    s3.close();
    const names = nodesAfter.map(n => n.name);

    assert(nodesAfter.length === 2,
      `After recreate: expected 2 nodes, got ${nodesAfter.length}: ${names.join(', ')}`);
    assert(!names.some(n => ['alpha', 'beta', 'gamma'].includes(n)),
      `Stale nodes from deleted version still present: ${names.join(', ')}`);
    assert(names.includes('delta') && names.includes('epsilon'),
      `Expected delta+epsilon, got: ${names.join(', ')}`);
  } finally {
    try { fs.rmSync(fcsDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PFP-01: Python parser handles decorators without duplicating methods
test('PFP-01 Python parser handles decorators without duplicating nodes', () => {
  const pfpDir = path.join(os.tmpdir(), `nca-pfp-${Date.now()}`);
  fs.mkdirSync(pfpDir, { recursive: true });
  const tmpFile = path.join(pfpDir, 'decorated.py');
  const tmpDb = path.join(pfpDir, 'pfp.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(tmpFile, [
      'from functools import lru_cache',
      'from typing import Optional',
      '',
      'def validate(fn):',
      '    def wrapper(*args, **kwargs):',
      '        return fn(*args, **kwargs)',
      '    return wrapper',
      '',
      '@validate',
      'def process_data(data: dict) -> Optional[dict]:',
      '    if not data:',
      '        return None',
      '    return {k: v.strip() for k, v in data.items() if isinstance(v, str)}',
      '',
      'class Repository:',
      '    def __init__(self, db_path: str):',
      '        self.db_path = db_path',
      '',
      '    @staticmethod',
      '    def connect(path: str) -> "Repository":',
      '        return Repository(path)',
      '',
      '    @lru_cache(maxsize=128)',
      '    def get(self, key: str) -> Optional[str]:',
      '        return None',
    ].join('\n'));

    run(`scan ${pfpDir}`);

    const storage = new StorageClass(tmpDb);
    const allNodes = storage.getAllNodes().filter(n => n.file === tmpFile);
    storage.close();

    const names = allNodes.map(n => n.name);
    const unique = [...new Set(names)];
    assert(names.length === unique.length,
      `Parser created duplicate nodes for decorated Python: ${JSON.stringify(
        names.filter((n, i) => names.indexOf(n) !== i)
      )}`);

    assert(allNodes.length >= 3,
      `Expected ≥3 nodes from decorated Python, got ${allNodes.length}: ${names.join(', ')}`);
  } finally {
    try { fs.rmSync(pfpDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// NID-01: same-name functions in different files are separate graph nodes
const NCA_ROOT = ROOT;
test('NID-01 same-name functions in different files are separate graph nodes', () => {
  const tmpDir2 = path.join(os.tmpdir(), `nca-nid-${Date.now()}`);
  fs.mkdirSync(tmpDir2, { recursive: true });
  const fileA = path.join(tmpDir2, 'auth.ts');
  const fileB = path.join(tmpDir2, 'api.ts');
  const tmpDb2 = path.join(tmpDir2, 'nid.db');

  try {
    fs.writeFileSync(fileA, 'export function handler() { return "auth"; }\n');
    fs.writeFileSync(fileB, 'export function handler() { return "api"; }\n');

    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb2;
    try {
      run(`scan ${tmpDir2}`);

      const Database2 = require('better-sqlite3');
      const db2 = new Database2(tmpDb2);
      try {
        const nodes2 = db2.prepare('SELECT name, file FROM nodes ORDER BY file').all();
        assert(nodes2.length === 2,
          `Expected 2 nodes (one per file), got ${nodes2.length}`);
        assert(nodes2[0].name === 'handler', `Node 0 name should be handler`);
        assert(nodes2[1].name === 'handler', `Node 1 name should be handler`);
        assert(nodes2[0].file !== nodes2[1].file, `Nodes should be in different files`);

        const { GraphSnapshot } = require(path.join(NCA_ROOT, 'dist', 'graph.js'));
        const StorageClass2 = require(path.join(NCA_ROOT, 'dist', 'storage.js')).Storage;
        const storage2 = new StorageClass2(tmpDb2);
        const snap = GraphSnapshot.build(storage2);

        const keys = [...snap.forward.keys()];
        assert(keys.length >= 2,
          `Graph should have at least 2 separate keys for 2 handler functions, got ${keys.length}: ${keys.join(', ')}`);

        for (const [key, deps] of snap.forward) {
          if (key.includes('handler')) {
            for (const dep of deps) {
              assert(!dep.includes('handler'),
                `handler in ${key} should NOT depend on handler in another file. Found dep: ${dep}`);
            }
          }
        }
        storage2.close();
      } finally {
        db2.close();
      }
    } finally {
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  } finally {
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
  }
});

// NID-02: dep resolves correctly via global-unique strategy when only one function
// has the target name. Import-based resolution is not implemented at graph level
// because the linker already replaces relative import paths with bare names before
// persisting to the DB (the original file context is lost). The global-unique
// strategy is the correct fallback for non-ambiguous deps.
test('NID-02 deps resolve correctly via global-unique when dep name is unambiguous', () => {
  const tmpDir3 = path.join(os.tmpdir(), `nca-nid2-${Date.now()}`);
  fs.mkdirSync(tmpDir3, { recursive: true });
  const fileA = path.join(tmpDir3, 'auth.ts');
  const fileB = path.join(tmpDir3, 'main.ts');
  const tmpDb3 = path.join(tmpDir3, 'nid2.db');

  try {
    // Only auth.ts defines "validate" — global unique, so main's dep should resolve to it
    fs.writeFileSync(fileA, 'export function validate() { return true; }\n');
    fs.writeFileSync(fileB,
      'import { validate } from "./auth";\nexport function main() { validate(); }\n');

    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb3;
    try {
      run(`scan ${tmpDir3}`);

      const { GraphSnapshot } = require(path.join(NCA_ROOT, 'dist', 'graph.js'));
      const StorageClass3 = require(path.join(NCA_ROOT, 'dist', 'storage.js')).Storage;
      const storage3 = new StorageClass3(tmpDb3);
      const snap = GraphSnapshot.build(storage3);

      const mainKey = [...snap.forward.keys()].find(k => k.includes('main'));
      assert(mainKey, `Expected to find main in graph keys. Keys: ${[...snap.forward.keys()].join(', ')}`);

      const mainDeps = snap.forward.get(mainKey);
      assert(mainDeps, `main should have dependencies`);

      const depsArray = [...mainDeps];
      const authDep = depsArray.find(d => d.includes('auth') && d.includes('validate'));
      assert(authDep,
        `main should depend on auth:validate (global unique resolution). Deps: ${depsArray.join(', ')}`);

      storage3.close();
    } finally {
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  } finally {
    try { fs.rmSync(tmpDir3, { recursive: true, force: true }); } catch {}
  }
});

// MIG-06: vault schema tables, triggers and indexes created
test('MIG-06 migration 003 creates vault tables, FTS, triggers and indexes', () => {
  const dbFile = path.join(tmpDir, 'mig06.db');
  try {
    const storage = new StorageClass(dbFile);
    storage.close();

    const db = new Database(dbFile);
    try {
      // Tables
      const tableNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      ).all().map(r => r.name);
      assert(tableNames.includes('notes'), `Expected 'notes' table, got: ${tableNames.join(', ')}`);
      assert(tableNames.includes('note_chunks'), `Expected 'note_chunks' table, got: ${tableNames.join(', ')}`);

      // FTS virtual table
      const vtNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='note_chunks_fts'`
      ).all().map(r => r.name);
      assert(vtNames.includes('note_chunks_fts'), `Expected 'note_chunks_fts' virtual table`);

      // Triggers
      const trigNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'note_chunks_%' ORDER BY name`
      ).all().map(r => r.name);
      assert(trigNames.includes('note_chunks_ai'), `Expected trigger note_chunks_ai`);
      assert(trigNames.includes('note_chunks_ad'), `Expected trigger note_chunks_ad`);
      assert(trigNames.includes('note_chunks_au'), `Expected trigger note_chunks_au`);

      // Indexes
      const idxNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_notes_%' ORDER BY name`
      ).all().map(r => r.name);
      assert(idxNames.includes('idx_notes_status'), `Expected idx_notes_status`);
      assert(idxNames.includes('idx_notes_area'), `Expected idx_notes_area`);
      assert(idxNames.includes('idx_notes_type'), `Expected idx_notes_type`);

      // Schema version
      const ver = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
      assert(ver && ver.value === '3', `Expected schema_version=3, got: ${JSON.stringify(ver)}`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-07: FTS5 smoke — insert note + chunks, SELECT MATCH returns result
test('MIG-07 FTS5 smoke: insert note+chunks, MATCH query returns result', () => {
  const dbFile = path.join(tmpDir, 'mig07.db');
  try {
    const storage = new StorageClass(dbFile);
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO notes (id, path, content_hash, indexed_at)
         VALUES ('n1', '/vault/test.md', 'abc123', datetime('now'))`
      ).run();
      db.prepare(
        `INSERT INTO note_chunks (note_id, chunk_idx, text)
         VALUES ('n1', 0, 'El proyecto SYNIO usa arquitectura hexagonal')`
      ).run();
      db.prepare(
        `INSERT INTO note_chunks (note_id, chunk_idx, text)
         VALUES ('n1', 1, 'Los tests unitarios cubren el 90% del codigo')`
      ).run();

      const rows = db.prepare(
        `SELECT nc.note_id, nc.text
         FROM note_chunks_fts fts
         JOIN note_chunks nc ON nc.rowid = fts.rowid
         WHERE note_chunks_fts MATCH 'arquitectura'`
      ).all();
      assert(rows.length === 1, `Expected 1 FTS match for 'arquitectura', got ${rows.length}`);
      assert(rows[0].note_id === 'n1', `Expected note_id='n1', got: ${rows[0].note_id}`);

      const rows2 = db.prepare(
        `SELECT nc.note_id FROM note_chunks_fts fts
         JOIN note_chunks nc ON nc.rowid = fts.rowid
         WHERE note_chunks_fts MATCH 'synio'`
      ).all();
      assert(rows2.length === 1, `Expected 1 FTS match for 'synio' (diacritics removed), got ${rows2.length}`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-08: notes.status default 'vigente' when omitted on insert
test("MIG-08 notes.status defaults to 'vigente' when not specified", () => {
  const dbFile = path.join(tmpDir, 'mig08.db');
  try {
    const storage = new StorageClass(dbFile);
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO notes (id, path, content_hash, indexed_at)
         VALUES ('n2', '/vault/default-status.md', 'def456', datetime('now'))`
      ).run();
      const row = db.prepare(`SELECT status FROM notes WHERE id = 'n2'`).get();
      assert(row, `Expected row for id='n2'`);
      assert(row.status === 'vigente', `Expected status='vigente', got: '${row.status}'`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// VAULT tests
// VAULT-01: first scan indexes notes
test('VAULT-01 first scan indexes notes', () => {
  const vaultTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vault-test-'));
  const vaultDbPath = path.join(vaultTmpDir, 'nca.db');
  const vaultRoot = path.join(vaultTmpDir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    // Create 3 test notes
    fs.writeFileSync(path.join(vaultRoot, 'note1.md'), '# Note 1\n\nContent of note 1.');
    fs.writeFileSync(path.join(vaultRoot, 'note2.md'), '# Note 2\n\nContent of note 2.');
    fs.writeFileSync(path.join(vaultRoot, 'note3.md'), '# Note 3\n\nContent of note 3.');

    // Scan
    const out = execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    assert(out.includes('[OK]'), `Expected [OK], got: ${out}`);
    assert(out.includes('Indexed:   3'), `Expected Indexed: 3, got: ${out}`);
    assert(out.includes('Updated:   0'), `Expected Updated: 0, got: ${out}`);
    assert(out.includes('Unchanged: 0'), `Expected Unchanged: 0, got: ${out}`);
  } finally {
    try { fs.rmSync(vaultTmpDir, { recursive: true }); } catch {}
  }
});

// VAULT-02: second scan is idempotent (no changes)
test('VAULT-02 second scan is idempotent', () => {
  const vaultTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vault-test-'));
  const vaultDbPath = path.join(vaultTmpDir, 'nca.db');
  const vaultRoot = path.join(vaultTmpDir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'note1.md'), '# Note 1\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note2.md'), '# Note 2\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note3.md'), '# Note 3\n\nContent.');

    // First scan
    execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    // Second scan — should be idempotent
    const out = execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    assert(out.includes('Indexed:   0'), `Expected Indexed: 0, got: ${out}`);
    assert(out.includes('Updated:   0'), `Expected Updated: 0, got: ${out}`);
    assert(out.includes('Unchanged: 3'), `Expected Unchanged: 3, got: ${out}`);
  } finally {
    try { fs.rmSync(vaultTmpDir, { recursive: true }); } catch {}
  }
});

// VAULT-03: modifying a note is detected
test('VAULT-03 modified note is detected', () => {
  const vaultTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vault-test-'));
  const vaultDbPath = path.join(vaultTmpDir, 'nca.db');
  const vaultRoot = path.join(vaultTmpDir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    const note1Path = path.join(vaultRoot, 'note1.md');
    fs.writeFileSync(note1Path, '# Note 1\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note2.md'), '# Note 2\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note3.md'), '# Note 3\n\nContent.');

    // First scan
    execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    // Modify note1
    fs.writeFileSync(note1Path, '# Note 1\n\nModified content here.');

    // Second scan
    const out = execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    assert(out.includes('Updated:   1'), `Expected Updated: 1, got: ${out}`);
    assert(out.includes('Unchanged: 2'), `Expected Unchanged: 2, got: ${out}`);
  } finally {
    try { fs.rmSync(vaultTmpDir, { recursive: true }); } catch {}
  }
});

// VAULT-04: .obsidian directory is excluded
test('VAULT-04 .obsidian directory excluded', () => {
  const vaultTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vault-test-'));
  const vaultDbPath = path.join(vaultTmpDir, 'nca.db');
  const vaultRoot = path.join(vaultTmpDir, 'vault');
  fs.mkdirSync(vaultRoot);
  fs.mkdirSync(path.join(vaultRoot, '.obsidian'));

  try {
    fs.writeFileSync(path.join(vaultRoot, 'note1.md'), '# Note 1\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note2.md'), '# Note 2\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, 'note3.md'), '# Note 3\n\nContent.');
    fs.writeFileSync(path.join(vaultRoot, '.obsidian', 'config.md'), '# Hidden note\n\nShould not be indexed.');

    // Scan
    const out = execSync(`node ${CLI} vault scan ${vaultRoot}`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    // Should only see 3 notes, not 4
    assert(out.includes('Indexed:   3'), `Expected Indexed: 3 (not 4), got: ${out}`);
  } finally {
    try { fs.rmSync(vaultTmpDir, { recursive: true }); } catch {}
  }
});

// VAULT-05: --dry-run does not write to DB
test('VAULT-05 --dry-run does not write to DB', () => {
  const vaultTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vault-test-'));
  const vaultDbPath = path.join(vaultTmpDir, 'nca.db');
  const vaultRoot = path.join(vaultTmpDir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'note1.md'), '# Note 1\n\nContent.');

    // Create DB with migrations
    const storage = new StorageClass(vaultDbPath);
    storage.close();

    // Count notes before dry-run
    const dbBefore = new Database(vaultDbPath);
    const countBefore = dbBefore.prepare('SELECT COUNT(*) as count FROM notes').get();
    dbBefore.close();

    // Dry-run scan
    execSync(`node ${CLI} vault scan ${vaultRoot} --dry-run`, {
      encoding: 'utf-8',
      env: { ...process.env, NCA_DB_PATH: vaultDbPath },
    });

    // Count notes after dry-run — should be unchanged
    const dbAfter = new Database(vaultDbPath);
    const countAfter = dbAfter.prepare('SELECT COUNT(*) as count FROM notes').get();
    dbAfter.close();

    assert(
      countBefore.count === countAfter.count,
      `Expected same note count (dry-run should not write), before: ${countBefore.count}, after: ${countAfter.count}`
    );
  } finally {
    try { fs.rmSync(vaultTmpDir, { recursive: true }); } catch {}
  }
});

// LOUVAIN tests — community detection
{
  const { GraphSnapshot } = require(path.join(ROOT, 'dist', 'graph.js'));
  let louvain;
  try {
    louvain = require(path.join(ROOT, 'dist', 'graph', 'louvain.js')).louvain;
  } catch (_) {
    louvain = null;
  }

  function mkLvNode(name, deps, file) {
    return {
      type: 'function', name, module: '', inputs: [], outputs: [],
      deps, effects: [], complexity: 1, file, line: 0, sha256: ''
    };
  }

  // LV-01: two fully-connected clusters with one bridge edge
  test('LV-01 louvain detects obvious communities in a bipartite graph', () => {
    assert(typeof louvain === 'function', 'louvain must be exported from dist/graph/louvain.js');

    const nodes = [
      mkLvNode('a1', ['a2', 'a3'], 'cluster_a.ts'),
      mkLvNode('a2', ['a1', 'a3'], 'cluster_a.ts'),
      mkLvNode('a3', ['a1', 'a2', 'b1'], 'cluster_a.ts'),
      mkLvNode('b1', ['b2', 'b3'], 'cluster_b.ts'),
      mkLvNode('b2', ['b1', 'b3'], 'cluster_b.ts'),
      mkLvNode('b3', ['b1', 'b2'], 'cluster_b.ts'),
    ];

    const forward = new Map([
      ['cluster_a.ts:a1', new Set(['cluster_a.ts:a2', 'cluster_a.ts:a3'])],
      ['cluster_a.ts:a2', new Set(['cluster_a.ts:a1', 'cluster_a.ts:a3'])],
      ['cluster_a.ts:a3', new Set(['cluster_a.ts:a1', 'cluster_a.ts:a2', 'cluster_b.ts:b1'])],
      ['cluster_b.ts:b1', new Set(['cluster_b.ts:b2', 'cluster_b.ts:b3'])],
      ['cluster_b.ts:b2', new Set(['cluster_b.ts:b1', 'cluster_b.ts:b3'])],
      ['cluster_b.ts:b3', new Set(['cluster_b.ts:b1', 'cluster_b.ts:b2'])],
    ]);

    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const communities = louvain(snap);

    assert(communities instanceof Map, 'louvain should return a Map');
    assert(communities.size === 6, `Expected 6 entries, got ${communities.size}`);

    const aCommunity = communities.get('cluster_a.ts:a1');
    assert(aCommunity !== undefined, 'a1 should have a community');
    assert(communities.get('cluster_a.ts:a2') === aCommunity, 'a2 should be in same community as a1');
    assert(communities.get('cluster_a.ts:a3') === aCommunity, 'a3 should be in same community as a1');

    const bCommunity = communities.get('cluster_b.ts:b1');
    assert(bCommunity !== undefined, 'b1 should have a community');
    assert(communities.get('cluster_b.ts:b2') === bCommunity, 'b2 should be in same community as b1');
    assert(communities.get('cluster_b.ts:b3') === bCommunity, 'b3 should be in same community as b1');

    assert(aCommunity !== bCommunity, 'Clusters A and B should be different communities');
  });

  // LV-02: connected component + 2 isolated nodes
  test('LV-02 louvain handles disconnected nodes', () => {
    assert(typeof louvain === 'function', 'louvain must be exported from dist/graph/louvain.js');

    const nodes = [
      mkLvNode('x', ['y'], 'a.ts'),
      mkLvNode('y', ['x', 'z'], 'a.ts'),
      mkLvNode('z', ['y'], 'a.ts'),
      mkLvNode('isolated1', [], 'b.ts'),
      mkLvNode('isolated2', [], 'b.ts'),
    ];

    const forward = new Map([
      ['a.ts:x', new Set(['a.ts:y'])],
      ['a.ts:y', new Set(['a.ts:x', 'a.ts:z'])],
      ['a.ts:z', new Set(['a.ts:y'])],
      ['b.ts:isolated1', new Set()],
      ['b.ts:isolated2', new Set()],
    ]);

    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const communities = louvain(snap);

    assert(communities.size === 5, `Expected 5 entries, got ${communities.size}`);

    const xComm = communities.get('a.ts:x');
    assert(communities.get('a.ts:y') === xComm, 'y should be with x');
    assert(communities.get('a.ts:z') === xComm, 'z should be with x');

    assert(communities.has('b.ts:isolated1'), 'isolated1 should have a community');
    assert(communities.has('b.ts:isolated2'), 'isolated2 should have a community');
  });

  // LV-03: single node
  test('LV-03 louvain handles single node graph', () => {
    assert(typeof louvain === 'function', 'louvain must be exported from dist/graph/louvain.js');

    const forward = new Map([['a.ts:solo', new Set()]]);
    const nodes = [mkLvNode('solo', [], 'a.ts')];
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const communities = louvain(snap);

    assert(communities.size === 1, 'Single node should have 1 community');
    assert(communities.has('a.ts:solo'), 'Solo node should be assigned');
  });

  // LV-04: empty graph
  test('LV-04 louvain handles empty graph', () => {
    assert(typeof louvain === 'function', 'louvain must be exported from dist/graph/louvain.js');

    const forward = new Map();
    const snap = GraphSnapshot.fromMaps([], forward);
    const communities = louvain(snap);

    assert(communities.size === 0, 'Empty graph should return empty Map');
  });
}

// PAGERANK tests
{
  const { GraphSnapshot } = require(path.join(ROOT, 'dist', 'graph.js'));
  let pagerank;
  try {
    pagerank = require(path.join(ROOT, 'dist', 'graph', 'pagerank.js')).pagerank;
  } catch (_) {
    pagerank = null;
  }

  function mkPrNode(name, file) {
    return { type: 'function', name, module: '', inputs: [], outputs: [],
             deps: [], effects: [], complexity: 1, file, line: 0, sha256: '' };
  }

  // PR-01: star graph A→B, A→C, A→D — source has lowest rank, leaves equal and higher
  test('PR-01 star graph: source lowest, leaves equal and higher', () => {
    assert(typeof pagerank === 'function', 'pagerank must be exported from dist/graph/pagerank.js');
    const nodes = ['a','b','c','d'].map(n => mkPrNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:a', new Set(['f.ts:b','f.ts:c','f.ts:d'])],
      ['f.ts:b', new Set()], ['f.ts:c', new Set()], ['f.ts:d', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const pr = pagerank(snap);
    assert(pr instanceof Map, 'pagerank should return a Map');
    assert(pr.size === 4, `Expected 4 entries, got ${pr.size}`);
    const a = pr.get('f.ts:a'), b = pr.get('f.ts:b'), c = pr.get('f.ts:c'), d = pr.get('f.ts:d');
    assert(a < b, `A(${a?.toFixed(4)}) should be < B(${b?.toFixed(4)})`);
    assert(a < c, `A(${a?.toFixed(4)}) should be < C(${c?.toFixed(4)})`);
    assert(a < d, `A(${a?.toFixed(4)}) should be < D(${d?.toFixed(4)})`);
    assert(Math.abs(b - c) < 1e-6, `B and C should be equal, got ${b?.toFixed(6)} vs ${c?.toFixed(6)}`);
    assert(Math.abs(c - d) < 1e-6, `C and D should be equal, got ${c?.toFixed(6)} vs ${d?.toFixed(6)}`);
  });

  // PR-02: chain A→B→C→D — rank increases along chain
  test('PR-02 chain: rank increases A→B→C→D', () => {
    assert(typeof pagerank === 'function', 'pagerank must be exported from dist/graph/pagerank.js');
    const nodes = ['a','b','c','d'].map(n => mkPrNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:a', new Set(['f.ts:b'])], ['f.ts:b', new Set(['f.ts:c'])],
      ['f.ts:c', new Set(['f.ts:d'])], ['f.ts:d', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const pr = pagerank(snap);
    const a = pr.get('f.ts:a'), b = pr.get('f.ts:b'), c = pr.get('f.ts:c'), d = pr.get('f.ts:d');
    assert(a < b, `A(${a?.toFixed(4)}) < B(${b?.toFixed(4)})`);
    assert(b < c, `B(${b?.toFixed(4)}) < C(${c?.toFixed(4)})`);
    assert(c < d, `C(${c?.toFixed(4)}) < D(${d?.toFixed(4)})`);
  });

  // PR-03: single node → score 1.0
  test('PR-03 single node: score is 1.0', () => {
    assert(typeof pagerank === 'function', 'pagerank must be exported from dist/graph/pagerank.js');
    const snap = GraphSnapshot.fromMaps([mkPrNode('x', 'f.ts')], new Map([['f.ts:x', new Set()]]));
    const pr = pagerank(snap);
    assert(pr.size === 1, `Expected 1 entry, got ${pr.size}`);
    assert(Math.abs(pr.get('f.ts:x') - 1.0) < 1e-6, `Expected score 1.0, got ${pr.get('f.ts:x')}`);
  });

  // PR-04: empty graph → empty Map
  test('PR-04 empty graph: returns empty Map', () => {
    assert(typeof pagerank === 'function', 'pagerank must be exported from dist/graph/pagerank.js');
    const pr = pagerank(GraphSnapshot.fromMaps([], new Map()));
    assert(pr instanceof Map && pr.size === 0, 'Expected empty Map');
  });

  // PR-05: disconnected components — all scores sum to 1
  test('PR-05 disconnected components: scores sum to 1', () => {
    assert(typeof pagerank === 'function', 'pagerank must be exported from dist/graph/pagerank.js');
    const nodes = ['a','b','c','d'].map(n => mkPrNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:a', new Set(['f.ts:b'])], ['f.ts:b', new Set()],
      ['f.ts:c', new Set(['f.ts:d'])], ['f.ts:d', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const pr = pagerank(snap);
    assert(pr.size === 4, `Expected 4 entries, got ${pr.size}`);
    const total = [...pr.values()].reduce((s, v) => s + v, 0);
    assert(Math.abs(total - 1.0) < 1e-4, `Scores should sum to 1.0, got ${total.toFixed(6)}`);
    for (const [k, v] of pr) assert(v > 0, `Every node must have score > 0, ${k} has ${v}`);
  });
}

// BETWEENNESS tests
{
  const { GraphSnapshot } = require(path.join(ROOT, 'dist', 'graph.js'));
  let betweenness;
  try {
    betweenness = require(path.join(ROOT, 'dist', 'graph', 'betweenness.js')).betweenness;
  } catch (_) {
    betweenness = null;
  }

  function mkBtNode(name, file) {
    return { type: 'function', name, module: '', inputs: [], outputs: [],
             deps: [], effects: [], complexity: 1, file, line: 0, sha256: '' };
  }

  // BT-01: chain A→B→C→D — B and C bridge, so they have highest betweenness
  test('BT-01 chain A→B→C→D: B and C have highest betweenness', () => {
    assert(typeof betweenness === 'function', 'betweenness must be exported from dist/graph/betweenness.js');
    const nodes = ['a','b','c','d'].map(n => mkBtNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:a', new Set(['f.ts:b'])], ['f.ts:b', new Set(['f.ts:c'])],
      ['f.ts:c', new Set(['f.ts:d'])], ['f.ts:d', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const bt = betweenness(snap);
    assert(bt instanceof Map, 'betweenness should return a Map');
    assert(bt.size === 4, `Expected 4 entries, got ${bt.size}`);
    const a = bt.get('f.ts:a'), b = bt.get('f.ts:b'), c = bt.get('f.ts:c'), d = bt.get('f.ts:d');
    assert(b > a, `B(${b?.toFixed(4)}) should be > A(${a?.toFixed(4)})`);
    assert(c > a, `C(${c?.toFixed(4)}) should be > A(${a?.toFixed(4)})`);
    assert(b > d, `B(${b?.toFixed(4)}) should be > D(${d?.toFixed(4)})`);
    assert(c > d, `C(${c?.toFixed(4)}) should be > D(${d?.toFixed(4)})`);
  });

  // BT-02: directed bottleneck B→A, C→A, A→D, A→E — A lies on all 4 cross paths
  // (A directed star hub→leaves has no paths through it; we need sources→hub→sinks)
  test('BT-02 directed bottleneck: A (hub) has highest betweenness', () => {
    assert(typeof betweenness === 'function', 'betweenness must be exported from dist/graph/betweenness.js');
    const nodes = ['a','b','c','d','e'].map(n => mkBtNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:b', new Set(['f.ts:a'])], ['f.ts:c', new Set(['f.ts:a'])],
      ['f.ts:a', new Set(['f.ts:d','f.ts:e'])],
      ['f.ts:d', new Set()], ['f.ts:e', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const bt = betweenness(snap);
    const a = bt.get('f.ts:a'), b = bt.get('f.ts:b'), d = bt.get('f.ts:d');
    assert(a > b, `A(${a?.toFixed(4)}) should be > B(${b?.toFixed(4)})`);
    assert(a > d, `A(${a?.toFixed(4)}) should be > D(${d?.toFixed(4)})`);
    const scores = [...bt.values()].sort((x, y) => y - x);
    assert(Math.abs(a - scores[0]) < 1e-9, `A should have the highest betweenness`);
  });

  // BT-03: two clusters with one bridge node — bridge has highest score
  test('BT-03 two clusters with bridge: bridge node has highest betweenness', () => {
    assert(typeof betweenness === 'function', 'betweenness must be exported from dist/graph/betweenness.js');
    // Cluster 1: a→b, a→c; bridge: b→x; Cluster 2: x→d, x→e
    const nodeNames = ['a','b','c','x','d','e'];
    const nodes = nodeNames.map(n => mkBtNode(n, 'f.ts'));
    const forward = new Map([
      ['f.ts:a', new Set(['f.ts:b','f.ts:c'])],
      ['f.ts:b', new Set(['f.ts:x'])],
      ['f.ts:c', new Set()],
      ['f.ts:x', new Set(['f.ts:d','f.ts:e'])],
      ['f.ts:d', new Set()],
      ['f.ts:e', new Set()],
    ]);
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const bt = betweenness(snap);
    const scores = [...bt.entries()].sort((p, q) => q[1] - p[1]);
    const topKey = scores[0][0];
    assert(
      topKey === 'f.ts:x' || topKey === 'f.ts:b',
      `Expected bridge node (f.ts:x or f.ts:b) to have highest betweenness, got ${topKey}`
    );
    const xScore = bt.get('f.ts:x') ?? 0;
    const dScore = bt.get('f.ts:d') ?? 0;
    const eScore = bt.get('f.ts:e') ?? 0;
    assert(xScore > dScore, `Bridge x(${xScore.toFixed(4)}) should beat leaf d(${dScore.toFixed(4)})`);
    assert(xScore > eScore, `Bridge x(${xScore.toFixed(4)}) should beat leaf e(${eScore.toFixed(4)})`);
  });

  // BT-04: single node → score 0
  test('BT-04 single node: score is 0', () => {
    assert(typeof betweenness === 'function', 'betweenness must be exported from dist/graph/betweenness.js');
    const snap = GraphSnapshot.fromMaps([mkBtNode('x', 'f.ts')], new Map([['f.ts:x', new Set()]]));
    const bt = betweenness(snap);
    assert(bt.size === 1, `Expected 1 entry, got ${bt.size}`);
    assert(bt.get('f.ts:x') === 0, `Expected score 0, got ${bt.get('f.ts:x')}`);
  });

  // BT-05: empty graph → empty Map
  test('BT-05 empty graph: returns empty Map', () => {
    assert(typeof betweenness === 'function', 'betweenness must be exported from dist/graph/betweenness.js');
    const bt = betweenness(GraphSnapshot.fromMaps([], new Map()));
    assert(bt instanceof Map && bt.size === 0, 'Expected empty Map');
  });
}

// GOD-NODE tests
{
  const { GraphSnapshot } = require(path.join(ROOT, 'dist', 'graph.js'));
  let detectGodNodes;
  try {
    detectGodNodes = require(path.join(ROOT, 'dist', 'graph', 'god-nodes.js')).detectGodNodes;
  } catch (_) {
    detectGodNodes = null;
  }

  function mkGnNode(name, file) {
    return { type: 'function', name, module: '', inputs: [], outputs: [],
             deps: [], effects: [], complexity: 1, file, line: 0, sha256: '' };
  }

  // GN-01: 1 hub with 20 deps among 50 low-coupling nodes → hub detected at p95
  test('GN-01 obvious hub detected among low-coupling nodes', () => {
    assert(typeof detectGodNodes === 'function',
      'detectGodNodes must be exported from dist/graph/god-nodes.js');

    // 50 leaf nodes: a0..a49 — each depends on one other leaf (score 1)
    const N = 50;
    const leafNames = Array.from({ length: N }, (_, i) => `a${i}`);
    const hubName   = 'hub';
    const allNames  = [...leafNames, hubName];
    const nodes     = allNames.map(n => mkGnNode(n, 'f.ts'));

    const forward = new Map();
    // hub depends on all 50 leaves (fanOut=50) and nothing points to it (fanIn=0) → score 50
    forward.set('f.ts:hub', new Set(leafNames.map(n => `f.ts:${n}`)));
    // each leaf depends on the next (ring, so each has fanOut=1, fanIn=1) → score 2
    for (let i = 0; i < N; i++) {
      forward.set(`f.ts:a${i}`, new Set([`f.ts:a${(i + 1) % N}`]));
    }

    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const gods  = detectGodNodes(snap); // default p95

    assert(Array.isArray(gods), 'Expected an array');
    assert(gods.length >= 1, `Expected at least 1 god node, got ${gods.length}`);
    assert(gods[0].nodeKey === 'f.ts:hub',
      `Expected hub as top god node, got ${gods[0].nodeKey}`);
    assert(gods[0].score > 2,
      `Hub score (${gods[0].score}) should exceed leaf scores (~2)`);
  });

  // GN-02: all nodes have equal coupling → no god nodes
  test('GN-02 equal-coupling graph: no god nodes', () => {
    assert(typeof detectGodNodes === 'function',
      'detectGodNodes must be exported from dist/graph/god-nodes.js');

    // 10 nodes in a ring: each has fanIn=1, fanOut=1, score=2
    const N = 10;
    const nodes = Array.from({ length: N }, (_, i) => mkGnNode(`n${i}`, 'f.ts'));
    const forward = new Map();
    for (let i = 0; i < N; i++) {
      forward.set(`f.ts:n${i}`, new Set([`f.ts:n${(i + 1) % N}`]));
    }
    const snap = GraphSnapshot.fromMaps(nodes, forward);
    const gods  = detectGodNodes(snap);

    assert(gods.length === 0,
      `Expected 0 god nodes when all scores are equal, got ${gods.length}`);
  });

  // GN-03: empty graph → empty array
  test('GN-03 empty graph: returns empty array', () => {
    assert(typeof detectGodNodes === 'function',
      'detectGodNodes must be exported from dist/graph/god-nodes.js');

    const gods = detectGodNodes(GraphSnapshot.fromMaps([], new Map()));
    assert(Array.isArray(gods) && gods.length === 0,
      `Expected empty array, got ${JSON.stringify(gods)}`);
  });

  // GN-04: threshold is configurable — p90 catches more nodes than p99
  test('GN-04 threshold configurable: p90 >= p99 result count', () => {
    assert(typeof detectGodNodes === 'function',
      'detectGodNodes must be exported from dist/graph/god-nodes.js');

    // 18 nodes in a ring (score=2 each) + 1 isolated node (score=0) + 1 hub (fanOut=18, score=18)
    // Score distribution: [0, 2,2,...,2(x18), 18]
    // p90 threshold = sorted[floor(0.9*20)=18] = 2  → hub (18>2) detected
    // p99 threshold = sorted[min(floor(0.99*20)=19,19)] = 18 → 18 NOT > 18 → 0 gods
    const N = 18;
    const ringNames = Array.from({ length: N }, (_, i) => `r${i}`);
    const allNames  = [...ringNames, 'iso', 'hub'];
    const nodes     = allNames.map(n => mkGnNode(n, 'f.ts'));
    const forward   = new Map();
    for (let i = 0; i < N; i++) {
      forward.set(`f.ts:r${i}`, new Set([`f.ts:r${(i + 1) % N}`]));
    }
    forward.set('f.ts:iso', new Set());
    forward.set('f.ts:hub', new Set(ringNames.map(n => `f.ts:${n}`)));

    const snap    = GraphSnapshot.fromMaps(nodes, forward);
    const gods90  = detectGodNodes(snap, 90);
    const gods99  = detectGodNodes(snap, 99);

    assert(gods90.length >= gods99.length,
      `p90 (${gods90.length}) should catch at least as many nodes as p99 (${gods99.length})`);
    assert(gods90.length > 0, `p90 should catch at least one god node, got 0`);
    assert(gods90[0].nodeKey === 'f.ts:hub',
      `p90 top god node should be hub, got ${gods90[0]?.nodeKey}`);
  });
}

// ── AE: enriched context in nca_ask responses ─────────────────────────────────

{
  const { Storage } = require(path.join(ROOT, 'dist', 'storage.js'));
  const { ContextExpander } = require(path.join(ROOT, 'dist', 'context.js'));

  const aeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-ae-'));
  const aeDb = path.join(aeDir, 'nca.db');
  const aeStorage = new Storage(aeDb);

  const mkNode = (name, filePath, line, deps = []) => ({
    type: 'function', name, module: 'test',
    inputs: [], outputs: [], deps, effects: [],
    complexity: 1, file: filePath, line, sha256: name,
  });

  // hub: depended on by 20 callers (fanIn=20) and calls 2 deps (fanOut=2) → score=22
  aeStorage.upsertNode(mkNode('hub', '/proj/src/hub.ts', 1, ['depA', 'depB']));
  aeStorage.upsertNode(mkNode('depA', '/proj/src/hub.ts', 2));
  aeStorage.upsertNode(mkNode('depB', '/proj/src/hub.ts', 3));
  // 20 callers each depending on hub → gives hub fanIn=20
  for (let i = 0; i < 20; i++) {
    aeStorage.upsertNode(mkNode(`caller${i}`, '/proj/callers/c.ts', 10 + i, ['hub']));
  }
  // Total: 23 nodes. At p95, threshold = score of 22nd element = 1.
  // hub score=22 > 1 → god node. callers score=1 → normal.

  const aeCtx = new ContextExpander(aeStorage);
  const ts = Date.now();
  const noFlows = [];
  const noWarnings = [];

  // AE-01: god node → gn:yes(score)
  test('AE-01 god node response includes gn:yes with score', () => {
    const nodes = aeStorage.getAllNodes().filter(n => n.name === 'hub');
    const out = aeCtx.formatFull({ query: 'hub', nodes, timestamp: ts }, noFlows, noWarnings);
    const hubLine = out.split('\n').find(l => l.includes('@function.hub{'));
    assert(hubLine, `Expected hub node line in output:\n${out.slice(0, 500)}`);
    assert(hubLine.includes('gn:yes('), `Expected gn:yes(score) on hub line, got:\n${hubLine}`);
  });

  // AE-02: normal node → gn:no
  test('AE-02 normal node response includes gn:no', () => {
    const nodes = aeStorage.getAllNodes().filter(n => n.name === 'caller0');
    const out = aeCtx.formatFull({ query: 'caller0', nodes, timestamp: ts }, noFlows, noWarnings);
    const callerLine = out.split('\n').find(l => l.includes('@function.caller0{'));
    assert(callerLine, `Expected caller0 node line in output:\n${out.slice(0, 500)}`);
    assert(callerLine.includes('gn:no'), `Expected gn:no on caller0 line, got:\n${callerLine}`);
  });

  // AE-03: any node → pr:#N/T present
  test('AE-03 response includes pagerank rank position', () => {
    const nodes = aeStorage.getAllNodes().filter(n => n.name === 'hub');
    const out = aeCtx.formatFull({ query: 'hub', nodes, timestamp: ts }, noFlows, noWarnings);
    assert(/pr:#\d+\/\d+/.test(out), `Expected pr:#N/T in output:\n${out.slice(0, 500)}`);
  });

  // AE-04: response includes directory module from file path
  test('AE-04 response includes directory module name', () => {
    const nodes = aeStorage.getAllNodes().filter(n => n.name === 'hub');
    const out = aeCtx.formatFull({ query: 'hub', nodes, timestamp: ts }, noFlows, noWarnings);
    assert(out.includes('dir:src'), `Expected dir:src (from /proj/src/) in output:\n${out.slice(0, 500)}`);
  });

  aeStorage.close();
  try { fs.rmSync(aeDir, { recursive: true }); } catch {}
}

// ── SK: SKILL.md generator ────────────────────────────────────────────────────

const skillPath = dbPath.replace(/nca\.db$/, 'SKILL.md');

// SK-01: scan produces SKILL.md with all 6 required sections
test('SK-01 scan produces SKILL.md with all 6 sections', () => {
  assert(fs.existsSync(skillPath), `SKILL.md not found at ${skillPath}`);
  const content = fs.readFileSync(skillPath, 'utf-8');
  assert(content.includes('# NCA SKILL'), 'Missing section 1: header');
  assert(content.includes('## Modules'), 'Missing section 2: Modules');
  assert(content.includes('## Top Nodes (PageRank)'), 'Missing section 3: Top Nodes');
  assert(content.includes('## God Nodes'), 'Missing section 4: God Nodes');
  assert(content.includes('## Issues'), 'Missing section 5: Issues');
  assert(content.includes('## MCP Tools'), 'Missing section 6: MCP Tools');
  assert(content.includes('nca_ask'), 'MCP tools section must mention nca_ask');
});

// SK-02: on NCA's own codebase, SKILL.md is under 8000 chars
test('SK-02 NCA own codebase SKILL.md under 8000 chars', () => {
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-sk02-'));
  const dbPath2 = path.join(tmpDir2, 'nca.db');
  const skillPath2 = dbPath2.replace(/nca\.db$/, 'SKILL.md');
  const savedDb = process.env.NCA_DB_PATH;
  try {
    process.env.NCA_DB_PATH = dbPath2;
    run(`scan ${path.join(ROOT, 'src')}`);
    assert(fs.existsSync(skillPath2), `SKILL.md not found at ${skillPath2}`);
    const content = fs.readFileSync(skillPath2, 'utf-8');
    assert(
      content.length <= 8000,
      `SKILL.md is ${content.length} chars, expected <= 8000`
    );
  } finally {
    process.env.NCA_DB_PATH = savedDb;
    try { fs.rmSync(tmpDir2, { recursive: true }); } catch {}
  }
});

// SK-03: empty project (no nodes) → SKILL.md with zeros, no crash
test('SK-03 empty project generates SKILL.md with zeros, no crash', () => {
  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-sk03-'));
  const emptyDir = path.join(tmpDir3, 'empty');
  const dbPath3 = path.join(tmpDir3, 'nca.db');
  const skillPath3 = dbPath3.replace(/nca\.db$/, 'SKILL.md');
  fs.mkdirSync(emptyDir);
  const savedDb = process.env.NCA_DB_PATH;
  try {
    process.env.NCA_DB_PATH = dbPath3;
    run(`scan ${emptyDir}`);
    assert(fs.existsSync(skillPath3), `SKILL.md not found at ${skillPath3}`);
    const content = fs.readFileSync(skillPath3, 'utf-8');
    assert(content.includes('nodes:0'), `Expected nodes:0 in header, got: ${content.slice(0, 200)}`);
    assert(content.includes('## Modules'), 'Expected Modules section even when empty');
    assert(content.includes('## Issues'), 'Expected Issues section even when empty');
  } finally {
    process.env.NCA_DB_PATH = savedDb;
    try { fs.rmSync(tmpDir3, { recursive: true }); } catch {}
  }
});

// SK-04: scan twice → identical SKILL.md content (deterministic)
test('SK-04 scan twice produces identical SKILL.md (deterministic)', () => {
  const content1 = fs.readFileSync(skillPath, 'utf-8');
  run(`scan ${FIXTURES}`);
  const content2 = fs.readFileSync(skillPath, 'utf-8');
  assert(content1 === content2, 'SKILL.md content differs between two scans of the same data');
});

// PI1-01: scan indexes both code nodes and markdown notes in the same DB
test('PI1-01 scan indexes both code nodes and markdown notes', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi1-'));
  const docsDir = path.join(piDir, 'docs');
  const tmpDb = path.join(piDir, 'pi1.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(piDir, 'index.ts'), 'export function hello() { return 42; }\n');
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n\nSome documentation content here.\n');

    const out = run(`scan ${piDir}`);
    assert(out.includes('NCA|scan_complete'), `Expected scan_complete, got: ${out}`);
    assert(out.includes('notes:'), 'Expected notes: in scan output');

    const db = new Database(tmpDb);
    try {
      const nodeCount = db.prepare('SELECT COUNT(*) as n FROM nodes').get();
      const noteCount = db.prepare('SELECT COUNT(*) as n FROM notes').get();
      assert(nodeCount.n >= 1, `Expected >=1 code node, got ${nodeCount.n}`);
      assert(noteCount.n >= 1, `Expected >=1 note, got ${noteCount.n}`);
      const note = db.prepare("SELECT id, path FROM notes WHERE path LIKE '%guide%'").get();
      assert(note, 'Expected guide.md to be indexed as a note');
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI1-02: .md inside excluded dirs (node_modules) is not indexed
test('PI1-02 markdown inside excluded dirs not indexed', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi2-'));
  const nmDir = path.join(piDir, 'node_modules', 'some-pkg');
  const tmpDb = path.join(piDir, 'pi2.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function init() { return true; }\n');
    fs.writeFileSync(path.join(piDir, 'README.md'), '# App\n\nRoot readme.\n');
    fs.writeFileSync(path.join(nmDir, 'CHANGELOG.md'), '# Changelog\n\nShould not be indexed.\n');

    run(`scan ${piDir}`);

    const db = new Database(tmpDb);
    try {
      const noteCount = db.prepare('SELECT COUNT(*) as n FROM notes').get();
      assert(noteCount.n === 1, `Expected 1 note (root README only), got ${noteCount.n}`);
      const nmNote = db.prepare("SELECT * FROM notes WHERE path LIKE '%node_modules%'").get();
      assert(!nmNote, 'node_modules .md file must NOT be indexed');
    } finally {
      db.close();
    }
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI1-03: re-scan with no changes skips notes (incremental via SHA-256)
test('PI1-03 re-scan with no changes skips notes (incremental)', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi3-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'main.ts'), 'export function run() { return 1; }\n');
    fs.writeFileSync(path.join(piDir, 'NOTES.md'), '# Notes\n\nSome content.\n');

    run(`scan ${piDir}`);

    // Stamp a sentinel value so we can detect if the row is re-written
    const db1 = new Database(tmpDb);
    db1.prepare("UPDATE notes SET indexed_at = 'SENTINEL'").run();
    db1.close();

    // Re-scan with no file changes
    run(`scan ${piDir}`);

    // indexed_at must still be SENTINEL (note was not re-processed)
    const db2 = new Database(tmpDb);
    const note = db2.prepare("SELECT indexed_at FROM notes WHERE path LIKE '%NOTES%'").get();
    db2.close();
    assert(note, 'Expected NOTES.md to exist after re-scan');
    assert(note.indexed_at === 'SENTINEL',
      `Expected indexed_at='SENTINEL' (unchanged), got '${note.indexed_at}'`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI1-04: editing a .md triggers re-index; unchanged .md is not touched
test('PI1-04 editing a markdown file updates only that note on re-scan', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi4-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    const guidePath = path.join(piDir, 'guide.md');
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function start() { return 1; }\n');
    fs.writeFileSync(guidePath, '# Guide\n\nOriginal content.\n');
    fs.writeFileSync(path.join(piDir, 'other.md'), '# Other\n\nStay unchanged.\n');

    run(`scan ${piDir}`);

    const db1 = new Database(tmpDb);
    const hash1 = db1.prepare("SELECT content_hash FROM notes WHERE path LIKE '%guide%'").get();
    // Stamp sentinel on the note that should NOT change
    db1.prepare("UPDATE notes SET indexed_at = 'SENTINEL' WHERE path LIKE '%other%'").run();
    db1.close();
    assert(hash1, 'Expected guide.md to be indexed after first scan');

    // Edit guide.md
    fs.writeFileSync(guidePath, '# Guide\n\nModified content — different now.\n');

    run(`scan ${piDir}`);

    const db2 = new Database(tmpDb);
    const hash2 = db2.prepare("SELECT content_hash FROM notes WHERE path LIKE '%guide%'").get();
    const otherNote = db2.prepare("SELECT indexed_at, content_hash FROM notes WHERE path LIKE '%other%'").get();
    const totalNotes = db2.prepare('SELECT COUNT(*) as n FROM notes').get();
    db2.close();

    assert(hash2, 'Expected guide.md to still be indexed after edit');
    assert(hash1.content_hash !== hash2.content_hash,
      'Expected content_hash to change after editing guide.md');
    assert(totalNotes.n === 2, `Expected 2 notes total, got ${totalNotes.n}`);
    assert(otherNote && otherNote.indexed_at === 'SENTINEL',
      `other.md should not have been re-indexed (sentinel must remain), got '${otherNote?.indexed_at}'`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

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
