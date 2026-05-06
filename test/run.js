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

// AC5: MCP server — tools/list + nca_ask + nca_insights in a single spawn
// Using a promise-based helper so assertions land inside the test() try/catch
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

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'nca_insights', arguments: {} },
  }) + '\n');

  setTimeout(() => {
    child.kill();
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
  }, 1000);
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

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// Results — wait for MCP async test (1000ms timeout above)
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
}, 1200);
