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

// MODE tests — NCA_MODE env reader
const { getMode } = require(path.join(ROOT, 'dist', 'hooks', 'lib', 'mode.js'));

test('MODE-01 undefined NCA_MODE returns on', () => {
  const prevValue = process.env.NCA_MODE;
  try {
    delete process.env.NCA_MODE;
    const mode = getMode();
    assert(mode === 'on', `Expected 'on' for undefined, got: ${mode}`);
  } finally {
    if (prevValue !== undefined) process.env.NCA_MODE = prevValue;
  }
});

test('MODE-02 NCA_MODE=on returns on', () => {
  const prevValue = process.env.NCA_MODE;
  try {
    process.env.NCA_MODE = 'on';
    const mode = getMode();
    assert(mode === 'on', `Expected 'on' for 'on', got: ${mode}`);
  } finally {
    if (prevValue !== undefined) process.env.NCA_MODE = prevValue;
    else delete process.env.NCA_MODE;
  }
});

test('MODE-03 NCA_MODE=off returns off', () => {
  const prevValue = process.env.NCA_MODE;
  try {
    process.env.NCA_MODE = 'off';
    const mode = getMode();
    assert(mode === 'off', `Expected 'off' for 'off', got: ${mode}`);
  } finally {
    if (prevValue !== undefined) process.env.NCA_MODE = prevValue;
    else delete process.env.NCA_MODE;
  }
});

test('MODE-04 NCA_MODE=OFF case-insensitive returns off', () => {
  const prevValue = process.env.NCA_MODE;
  try {
    process.env.NCA_MODE = 'OFF';
    const mode = getMode();
    assert(mode === 'off', `Expected 'off' for 'OFF', got: ${mode}`);
  } finally {
    if (prevValue !== undefined) process.env.NCA_MODE = prevValue;
    else delete process.env.NCA_MODE;
  }
});

test('MODE-05 NCA_MODE=whatever defaults to on', () => {
  const prevValue = process.env.NCA_MODE;
  try {
    process.env.NCA_MODE = 'whatever';
    const mode = getMode();
    assert(mode === 'on', `Expected 'on' for 'whatever', got: ${mode}`);
  } finally {
    if (prevValue !== undefined) process.env.NCA_MODE = prevValue;
    else delete process.env.NCA_MODE;
  }
});

// HOOK tests — PostToolUse structured logging
test('HOOK-01 first event creates session file correctly', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');

  try {
    const input = JSON.stringify({
      session_id: 'test-session-01',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/test/path.ts' },
      tool_response: { content: 'some content' },
    });

    const result = require('child_process').spawnSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
    });

    assert(result.status === 0, `Hook exited with status ${result.status}: ${result.stderr}`);

    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'test-session-01.json');
    assert(fs.existsSync(sessionPath), `Session file not created at ${sessionPath}`);

    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    assert(session.session_id === 'test-session-01', 'Incorrect session_id');
    assert(session.repo === path.basename(tempSessionDir), 'Incorrect repo name');
    assert(session.started_at, 'Missing started_at');
    assert(session.mode === 'on' || session.mode === 'off', 'Invalid mode');
    assert(session.events.length === 1, `Expected 1 event, got ${session.events.length}`);
    assert(session.events[0].tool === 'Read', 'Incorrect tool');
    assert(session.events[0].input_short === '/test/path.ts', 'Incorrect input_short');
    assert(session.events[0].outcome === 'ok', 'Incorrect outcome for successful Read');
    assert(session.events[0].blocked === false, 'blocked should always be false');
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});

test('HOOK-02 second event appends to session', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');

  try {
    // First event
    const input1 = JSON.stringify({
      session_id: 'test-session-02',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/test/path.ts' },
      tool_response: { content: 'data' },
    });

    require('child_process').spawnSync('node', [hookScript], {
      input: input1,
      encoding: 'utf-8',
    });

    // Second event
    const input2 = JSON.stringify({
      session_id: 'test-session-02',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/test/path.ts', old_string: 'x', new_string: 'y' },
      tool_response: { success: true },
    });

    require('child_process').spawnSync('node', [hookScript], {
      input: input2,
      encoding: 'utf-8',
    });

    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'test-session-02.json');
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));

    assert(session.events.length === 2, `Expected 2 events, got ${session.events.length}`);
    assert(session.events[0].tool === 'Read', 'First event should be Read');
    assert(session.events[1].tool === 'Edit', 'Second event should be Edit');
    assert(session.started_at, 'started_at should be set on first event');
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});

test('HOOK-03 nca_brief detection sets brief_called flag', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');

  try {
    const input = JSON.stringify({
      session_id: 'test-session-03',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'nca brief --light' },
      tool_response: null,
    });

    require('child_process').spawnSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
    });

    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'test-session-03.json');
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));

    assert(session.brief_called === true, 'brief_called should be true after nca_brief');
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});

test('HOOK-04 first_edit_at and files_read_before_first_edit tracked correctly', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');

  try {
    // First: Read events
    const input1 = JSON.stringify({
      session_id: 'test-session-04',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/file1.ts' },
      tool_response: { content: 'x' },
    });

    require('child_process').spawnSync('node', [hookScript], {
      input: input1,
      encoding: 'utf-8',
    });

    // Second: Read event
    const input2 = JSON.stringify({
      session_id: 'test-session-04',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/file2.ts' },
      tool_response: { content: 'y' },
    });

    require('child_process').spawnSync('node', [hookScript], {
      input: input2,
      encoding: 'utf-8',
    });

    // Third: Edit event (first edit)
    const input3 = JSON.stringify({
      session_id: 'test-session-04',
      cwd: tempSessionDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/file1.ts', old_string: 'x', new_string: 'xx' },
      tool_response: { success: true },
    });

    require('child_process').spawnSync('node', [hookScript], {
      input: input3,
      encoding: 'utf-8',
    });

    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'test-session-04.json');
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));

    assert(session.first_edit_at !== null, 'first_edit_at should be set');
    assert(session.files_read_before_first_edit === 2, `Expected 2 reads before edit, got ${session.files_read_before_first_edit}`);
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});

test('HOOK-05 invalid JSON input exits gracefully without crash', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');

  try {
    const result = require('child_process').spawnSync('node', [hookScript], {
      input: 'not-json-{broken}',
      encoding: 'utf-8',
    });

    assert(result.status === 0, `Hook should exit 0 on invalid JSON, got ${result.status}`);
    assert(!result.stderr || result.stderr === '', `Hook should not write stderr: ${result.stderr}`);

    // Session should NOT exist (corrupted input)
    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'unknown.json');
    assert(!fs.existsSync(sessionPath), 'Session should not exist for bad input');
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});

test('HOOK-06 reverts_detected compares file_path, not just any recent edit', () => {
  const tempSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-hook-test-'));
  const hookScript = path.join(ROOT, 'dist', 'hooks', 'post-tool-use.js');
  const spawnSync = require('child_process').spawnSync;

  const edit = (filePath) => JSON.stringify({
    session_id: 'test-session-06',
    cwd: tempSessionDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'x', new_string: 'xx' },
    tool_response: { success: true },
  });

  try {
    // Edit /a.ts, then /b.ts (different file), then /a.ts again (the revert).
    spawnSync('node', [hookScript], { input: edit('/a.ts'), encoding: 'utf-8' });
    spawnSync('node', [hookScript], { input: edit('/b.ts'), encoding: 'utf-8' });
    spawnSync('node', [hookScript], { input: edit('/a.ts'), encoding: 'utf-8' });

    const sessionPath = path.join(tempSessionDir, '.nca', 'sessions', 'test-session-06.json');
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));

    // Only the 3rd edit re-touches a file edited within the last 5 events.
    // Editing 3 distinct-then-repeated files must yield exactly 1 revert, not 3.
    assert(
      session.reverts_detected === 1,
      `Expected exactly 1 revert (only /a.ts re-edit), got ${session.reverts_detected}`
    );
  } finally {
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch {}
  }
});


// MIG-01: fresh DB applies all migrations
test('MIG-01 fresh DB applies all migrations', () => {
  const dbFile = path.join(tmpDir, 'mig01.db');
  try {
    const storage = new StorageClass(dbFile);
    storage.close();

    const db = new Database(dbFile);
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    assert(versionRow && versionRow.value === '4', `Expected schema_version=4, got: ${JSON.stringify(versionRow)}`);

    const logCount = db.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 4, `Expected 4 migration_log rows, got: ${logCount.count}`);

    const logRow1 = db.prepare('SELECT * FROM migration_log WHERE version = 1').get();
    assert(logRow1, 'Expected migration_log row for version 1');
    assert(logRow1.name === 'init_schema', `Expected name=init_schema, got: ${logRow1.name}`);

    const logRow2 = db.prepare('SELECT * FROM migration_log WHERE version = 2').get();
    assert(logRow2, 'Expected migration_log row for version 2');
    assert(logRow2.name === 'repair_line_move_duplicates', `Expected name=repair_line_move_duplicates, got: ${logRow2.name}`);

    const logRow3 = db.prepare('SELECT * FROM migration_log WHERE version = 3').get();
    assert(logRow3, 'Expected migration_log row for version 3');
    assert(logRow3.name === 'vault_schema', `Expected name=vault_schema, got: ${logRow3.name}`);

    const logRow4 = db.prepare('SELECT * FROM migration_log WHERE version = 4').get();
    assert(logRow4, 'Expected migration_log row for version 4');
    assert(logRow4.name === 'doc_code_edges', `Expected name=doc_code_edges, got: ${logRow4.name}`);
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
    assert(count.count === 4, `Expected 4 migration_log rows (one per migration), got: ${count.count}`);
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
    assert(versionRow && versionRow.value === '4', `Expected schema_version=4, got: ${JSON.stringify(versionRow)}`);

    const logCount = db2.prepare('SELECT COUNT(*) as count FROM migration_log').get();
    assert(logCount.count === 4, `Expected 4 migration_log rows, got: ${logCount.count}`);

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
      assert(ver.value === '4', `Expected schema_version=4, got ${ver.value}`);

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
    assert(typeof r.id === 'string' && r.id.length === 16 && /^[a-f0-9]{16}$/.test(r.id),
      `Expected 16-char hex id, got '${r.id}'`);
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
      assert(ver && ver.value === '4', `Expected schema_version=4, got: ${JSON.stringify(ver)}`);
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

// MIG-09: upgrade v2→v4 applies migrations 003 and 004
test('MIG-09 upgrade v2→v4 applies migrations 003 and 004', () => {
  const dbFile = path.join(tmpDir, 'mig09.db');
  try {
    // Step 1: create a fully-migrated v4 DB
    const s1 = new StorageClass(dbFile);
    s1.close();

    // Step 2: simulate a v2 DB — remove vault schema and reset metadata
    const setupDb = new Database(dbFile);
    setupDb.pragma('foreign_keys = OFF');
    setupDb.exec(`
      DROP TRIGGER IF EXISTS note_chunks_ai;
      DROP TRIGGER IF EXISTS note_chunks_ad;
      DROP TRIGGER IF EXISTS note_chunks_au;
      DROP INDEX IF EXISTS idx_notes_status;
      DROP INDEX IF EXISTS idx_notes_area;
      DROP INDEX IF EXISTS idx_notes_type;
      DROP INDEX IF EXISTS idx_doc_code_edges_note;
      DROP INDEX IF EXISTS idx_doc_code_edges_symbol;
      DROP INDEX IF EXISTS idx_doc_code_edges_node;
      DROP TABLE IF EXISTS doc_code_edges;
      DROP TABLE IF EXISTS note_chunks_fts;
      DROP TABLE IF EXISTS note_chunks;
      DROP TABLE IF EXISTS notes;
    `);
    setupDb.prepare(`UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'`).run();
    setupDb.prepare(`DELETE FROM migration_log WHERE version >= 3`).run();

    const logBefore = setupDb.prepare('SELECT COUNT(*) AS n FROM migration_log').get();
    assert(logBefore.n === 2, `Pre-condition: expected 2 log rows, got ${logBefore.n}`);
    const verBefore = setupDb.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
    assert(verBefore && verBefore.value === '2', `Pre-condition: expected schema_version=2, got ${JSON.stringify(verBefore)}`);
    setupDb.close();

    // Step 3: re-open via Storage — should apply migrations 003 and 004
    const s2 = new StorageClass(dbFile);
    s2.close();

    // Step 4: verify migrations were applied
    const db = new Database(dbFile);
    try {
      const ver = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
      assert(ver && ver.value === '4', `Expected schema_version=4, got: ${JSON.stringify(ver)}`);

      const logs = db.prepare('SELECT version, name FROM migration_log ORDER BY version').all();
      assert(logs.length === 4, `Expected 4 migration_log rows, got: ${logs.length}`);
      assert(logs[2].name === 'vault_schema', `Expected v3 name=vault_schema, got: ${logs[2].name}`);
      assert(logs[3].name === 'doc_code_edges', `Expected v4 name=doc_code_edges, got: ${logs[3].name}`);

      const tblNames = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'note_chunks', 'doc_code_edges') ORDER BY name`
      ).all().map(r => r.name);
      assert(tblNames.includes('note_chunks'), `Expected 'note_chunks' table to exist`);
      assert(tblNames.includes('notes'), `Expected 'notes' table to exist`);
      assert(tblNames.includes('doc_code_edges'), `Expected 'doc_code_edges' table to exist`);

      const fts = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_chunks_fts'`
      ).get();
      assert(fts, `Expected 'note_chunks_fts' virtual table to exist`);
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

// MIG-10: invalid schema_version (NaN and negative) aborts with MigrationError
test('MIG-10 invalid schema_version (NaN and negative) aborts with MigrationError', () => {
  // Case A: non-numeric value → parseInt returns NaN → index.ts:50-55
  const dbNaN = path.join(tmpDir, 'mig10-nan.db');
  try {
    const db = new Database(dbNaN);
    db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', 'not_a_number')`).run();
    db.close();

    let threw = false;
    try {
      const s = new StorageClass(dbNaN);
      s.close();
    } catch (err) {
      threw = true;
      assert(err.name === 'MigrationError', `Expected MigrationError, got: ${err.name}`);
      assert(
        err.message.includes('not_a_number'),
        `Expected message to include the bad value, got: ${err.message}`
      );
    }
    assert(threw, 'Expected Storage to throw on NaN schema_version');
  } finally {
    try { fs.unlinkSync(dbNaN); } catch {}
  }

  // Case B: negative integer → parsed < 0 → index.ts:50-55
  const dbNeg = path.join(tmpDir, 'mig10-neg.db');
  try {
    const db = new Database(dbNeg);
    db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '-1')`).run();
    db.close();

    let threw = false;
    try {
      const s = new StorageClass(dbNeg);
      s.close();
    } catch (err) {
      threw = true;
      assert(err.name === 'MigrationError', `Expected MigrationError, got: ${err.name}`);
      assert(
        err.message.includes('-1'),
        `Expected message to include '-1', got: ${err.message}`
      );
    }
    assert(threw, 'Expected Storage to throw on negative schema_version');
  } finally {
    try { fs.unlinkSync(dbNeg); } catch {}
  }
});

// MIG-11: failed migration rolls back — DB stays at N-1, MigrationError is thrown
test('MIG-11 failed migration rolls back: DB stays at N-1 and MigrationError is thrown', () => {
  const dbFile = path.join(tmpDir, 'mig11.db');
  try {
    // Pre-create schema_meta and migration_log WITHOUT the 'result' column.
    // runMigrations tries to INSERT (version, name, applied_at, result) into migration_log;
    // the missing column causes the INSERT to fail inside the transaction, exercising the
    // rollback path at index.ts:114-124.
    const db = new Database(dbFile);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE migration_log (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    db.close();

    let threw = false;
    let thrownError = null;
    try {
      const s = new StorageClass(dbFile);
      s.close();
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert(threw, 'Expected Storage constructor to throw when migration INSERT fails');
    assert(
      thrownError && thrownError.name === 'MigrationError',
      `Expected MigrationError, got: ${thrownError && thrownError.name}: ${thrownError && thrownError.message}`
    );
    assert(
      thrownError.version === 1,
      `Expected failed version=1 (migration001), got: ${thrownError && thrownError.version}`
    );

    // DB must be at N-1 = v0: transaction rolled back, nothing committed
    const verifyDb = new Database(dbFile);
    try {
      const ver = verifyDb.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
      assert(!ver, `Rollback: schema_version must not be set, got: ${JSON.stringify(ver)}`);

      const logCount = verifyDb.prepare('SELECT COUNT(*) AS n FROM migration_log').get();
      assert(logCount.n === 0, `Rollback: migration_log must be empty, got count=${logCount.n}`);

      // CREATE TABLE statements within the transaction must also have been rolled back
      const nodesTbl = verifyDb.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`
      ).get();
      assert(!nodesTbl, `Rollback: 'nodes' table must not exist after failed migration`);
    } finally {
      verifyDb.close();
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

// SK5-01: header includes notes:N
test('SK5-01 SKILL.md header includes notes count', () => {
  // fixtures dir has no .md files → notes:0 must appear in header
  const content = fs.readFileSync(skillPath, 'utf-8');
  const headerLine = content.split('\n').find(l => l.startsWith('nodes:'));
  assert(headerLine, 'Expected header line starting with nodes:');
  assert(headerLine.includes('notes:'), `Expected notes: in header line, got: ${headerLine}`);
});

// SK5-02: ## Docs section lists note titles and relative paths
test('SK5-02 SKILL.md has Docs section with note titles and relative paths', () => {
  const sk5Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-sk5-02-'));
  const ncaDir = path.join(sk5Dir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const skillPath5 = path.join(ncaDir, 'SKILL.md');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(sk5Dir, 'app.ts'), 'export function run() { return 1; }\n');
    fs.writeFileSync(path.join(sk5Dir, 'README.md'), '# Project\n\nMain readme.\n');
    fs.mkdirSync(path.join(sk5Dir, 'docs'));
    fs.writeFileSync(path.join(sk5Dir, 'docs', 'ARCHITECTURE.md'), '# Architecture\n\nSystem design decisions.\n');

    run(`scan ${sk5Dir}`);

    assert(fs.existsSync(skillPath5), `SKILL.md not found at ${skillPath5}`);
    const content = fs.readFileSync(skillPath5, 'utf-8');

    assert(content.includes('## Docs'), `Expected ## Docs section, got:\n${content}`);
    assert(content.includes('README.md'), `Expected README.md in Docs section, got:\n${content}`);
    assert(content.includes('docs/ARCHITECTURE.md'), `Expected docs/ARCHITECTURE.md in Docs, got:\n${content}`);
    assert(content.includes('— README'), `Expected title 'README' in Docs, got:\n${content}`);
    assert(content.includes('— ARCHITECTURE'), `Expected title 'ARCHITECTURE' in Docs, got:\n${content}`);

    // Docs entries must use relative paths — extract section and check
    const docsSection = content.split('## Docs')[1]?.split(/\n##/)[0] ?? '';
    assert(!docsSection.includes(sk5Dir), `Docs section must use relative paths, not absolute root ${sk5Dir}`);
  } finally {
    try { fs.rmSync(sk5Dir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// SK5-03: no notes indexed → ## Docs shows "(no docs indexed)"
test('SK5-03 no notes yields (no docs indexed) in Docs section', () => {
  // fixtures dir has no .md files; main skillPath was written by SK-04
  const content = fs.readFileSync(skillPath, 'utf-8');
  assert(content.includes('## Docs'), 'Expected ## Docs section even when no notes');
  assert(content.includes('(no docs indexed)'), `Expected "(no docs indexed)", got:\n${content}`);
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

// PI2-01: ask query matching a doc keyword → response includes [DOCS] section
test('PI2-01 ask query matching doc keyword returns notes section', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi2-01-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function init() { return 1; }\n');
    fs.writeFileSync(
      path.join(piDir, 'ARCHITECTURE.md'),
      '# Architecture\n\nThis project uses a modular architecture with clean separation of concerns.\n'
    );

    run(`scan ${piDir}`);

    const out = run(`ask architecture`);
    assert(out.includes('[DOCS]'), `Expected [DOCS] section in ask output, got:\n${out}`);
    assert(out.includes('ARCHITECTURE'), `Expected ARCHITECTURE.md title in notes, got:\n${out}`);
    assert(out.includes('excerpt:'), `Expected excerpt: field, got:\n${out}`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI2-02: ask query with no matching notes → notes field is [], no [DOCS] section
test('PI2-02 ask query with no matching notes has no [DOCS] section', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi2-02-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function greet() { return "hi"; }\n');
    fs.writeFileSync(path.join(piDir, 'README.md'), '# App\n\nSimple project.\n');

    run(`scan ${piDir}`);

    // Query a term that cannot appear in docs
    const out = run(`ask xyzzy_no_match_guaranteed_12345`);
    assert(!out.includes('[DOCS]'), `Expected NO [DOCS] section when no notes match, got:\n${out}`);

    // --json output: notes field must be an empty array
    const jsonOut = run(`ask --json xyzzy_no_match_guaranteed_12345`);
    const parsed = JSON.parse(jsonOut);
    assert(Array.isArray(parsed.notes), 'Expected notes to be an array in JSON output');
    assert(parsed.notes.length === 0, `Expected notes=[], got ${JSON.stringify(parsed.notes)}`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI2-03: [DOCS] section appears AFTER code results ([N], [CTX]), not before
test('PI2-03 notes section appears after code results', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi2-03-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'scanner.ts'), 'export function scan() { return []; }\n');
    fs.writeFileSync(
      path.join(piDir, 'SCANNING.md'),
      '# Scanning\n\nThe scanner module walks the directory tree.\n'
    );

    run(`scan ${piDir}`);

    const out = run(`ask scan`);
    const nPos = out.indexOf('[N]');
    const docsPos = out.indexOf('[DOCS]');

    assert(nPos !== -1, 'Expected [N] section');
    assert(docsPos !== -1, `Expected [DOCS] section, got:\n${out}`);
    assert(docsPos > nPos, `Expected [DOCS] after [N], but [N]=${nPos} [DOCS]=${docsPos}`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PI2-04: --json output includes notes array with title, file, excerpt fields
test('PI2-04 JSON output includes notes with title/file/excerpt', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pi2-04-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function start() { return 1; }\n');
    fs.writeFileSync(
      path.join(piDir, 'DECISIONS.md'),
      '# Decisions\n\nWe chose SQLite because it is embedded and requires no server.\n'
    );

    run(`scan ${piDir}`);

    const jsonOut = run(`ask --json decisions`);
    const parsed = JSON.parse(jsonOut);

    assert(Array.isArray(parsed.notes), 'Expected notes array in JSON output');
    assert(parsed.notes.length >= 1, `Expected >=1 note, got ${parsed.notes.length}`);

    const note = parsed.notes[0];
    assert(typeof note.title === 'string' && note.title.length > 0, 'Expected title string');
    assert(typeof note.file === 'string' && note.file.includes('DECISIONS'), 'Expected file path');
    assert(typeof note.excerpt === 'string' && note.excerpt.length > 0, 'Expected excerpt string');
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PF-01: path-fragment query with no symbol match → [PATH_MATCH] section
test('PF-01 ask path-fragment returns [PATH_MATCH] when no symbol match', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pf-01-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    // File name contains 'vapi' but the function inside does not — FTS5 won't tokenise 'vapi' from 'vapiClient'
    fs.writeFileSync(path.join(piDir, 'vapiClient.ts'),
      'export function connect(url: string) { return url; }\n');

    run(`scan ${piDir}`);

    const out = run(`ask vapi`);
    assert(out.includes('[PATH_MATCH]'),
      `Expected [PATH_MATCH] section for path-fragment query, got:\n${out}`);
    assert(out.includes('vapiClient'),
      `Expected file reference in [PATH_MATCH] output, got:\n${out}`);
    assert(!out.includes('(no matches'),
      `Expected nodes from path match, not guidance, got:\n${out}`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PF-02: query with no symbol or path match → guidance message, never silent empty
test('PF-02 ask with no symbol or path match emits guidance not silent empty', () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-pf-02-'));
  const ncaDir = path.join(piDir, '.nca');
  fs.mkdirSync(ncaDir);
  const tmpDb = path.join(ncaDir, 'nca.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = tmpDb;

  try {
    fs.writeFileSync(path.join(piDir, 'app.ts'), 'export function start() { return 1; }\n');
    run(`scan ${piDir}`);

    const out = run(`ask xyzzy_zzz_no_match_99999`);
    assert(!out.includes('(no results)'),
      `Expected guidance text not "(no results)", got:\n${out}`);
    assert(out.includes('no matches for'),
      `Expected "no matches for" guidance message, got:\n${out}`);

    // JSON mode must include guidance field, not crash
    const jsonOut = run(`ask --json xyzzy_zzz_no_match_99999`);
    const parsed = JSON.parse(jsonOut);
    assert(typeof parsed.guidance === 'string' && parsed.guidance.length > 0,
      `Expected guidance string in JSON output, got: ${JSON.stringify(parsed.guidance)}`);
  } finally {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch {}
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
  }
});

// PF-03: valid symbol query still returns [N] — no regression
test('PF-03 ask valid symbol returns [N] not [PATH_MATCH]', () => {
  const out = run(`ask fetchData`);
  assert(out.includes('[N]'), `Expected [N] section for symbol query, got:\n${out}`);
  assert(!out.includes('[PATH_MATCH]'),
    `Expected no [PATH_MATCH] for valid symbol query, got:\n${out}`);
});

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// TS-CHAR-01 / PY-CHAR-01: Parser characterization — golden captured from main (pre-refactor)
// via NCAParser.parseFile() directly, isolating the parser from Linker post-processing.
// (Linker.link() runs after scan and drops relative imports that don't resolve to files;
// testing through scan+DB would conflate linker behaviour with parser behaviour.)
// Golden verified: same snippet fed to main's parseFile produces identical field values.
{
  const { NCAParser } = require(path.join(ROOT, 'dist', 'parser.js'));
  const charParser = new NCAParser();

  // ─── TS snippet ──────────────────────────────────────────────────────────────
  // Covers: named function, arrow function, class, methods, relative + external imports,
  // complexity via if-branches. Function+class in same snippet verifies allNodeTypes
  // iteration order (the key structural change in the refactor).
  const TS_SNIPPET = [
    "import { readFile } from 'fs/promises';",
    'import type { Config } from "./config";',
    '',
    'export function greet(name: string, loud: boolean): string {',
    '  if (loud) {',
    '    return name.toUpperCase();',
    '  }',
    '  return name;',
    '}',
    '',
    'export const formatLabel = (value: string): string => {',
    "  if (!value) return '';",
    '  return value.trim().toLowerCase();',
    '};',
    '',
    'export class Processor {',
    '  private items: string[] = [];',
    '',
    '  constructor(private config: Config) {}',
    '',
    '  process(input: string): string | null {',
    '    if (!input) return null;',
    '    const trimmed = input.trim();',
    '    if (trimmed.length === 0) return null;',
    '    return trimmed;',
    '  }',
    '',
    '  reset(): void {',
    '    this.items = [];',
    '  }',
    '}',
  ].join('\n');

  test('TS-CHAR-01 TypeScript parser output matches golden: functions, class, methods, arrows', () => {
    const charDir = path.join(os.tmpdir(), `nca-ts-char-${Date.now()}`);
    fs.mkdirSync(charDir, { recursive: true });
    const tsFile = path.join(charDir, 'char.ts');
    try {
      fs.writeFileSync(tsFile, TS_SNIPPET, 'utf-8');
      const nodes = charParser.parseFile(tsFile, '', charDir, TS_SNIPPET);
      nodes.sort((a, b) => a.line - b.line);

      const actual = nodes.map(n => ({
        name: n.name, type: n.type, inputs: n.inputs, outputs: n.outputs,
        complexity: n.complexity, deps: n.deps, line: n.line,
      }));

      const expected = [
        { name: 'greet',       type: 'function', inputs: ['name:: string', 'loud:: boolean'], outputs: ['string'],        complexity: 2, deps: ['fs/promises', './config', 'toUpperCase'],          line: 3  },
        { name: 'formatLabel', type: 'arrow',    inputs: ['value:: string'],                  outputs: ['string'],        complexity: 2, deps: ['fs/promises', './config', 'toLowerCase', 'trim'],   line: 10 },
        { name: 'Processor',   type: 'class',    inputs: [],                                  outputs: [],                complexity: 3, deps: ['fs/promises', './config', 'trim'],                  line: 15 },
        { name: 'constructor', type: 'method',   inputs: ['config:: Config'],                 outputs: [],                complexity: 1, deps: ['fs/promises', './config'],                          line: 18 },
        { name: 'process',     type: 'method',   inputs: ['input:: string'],                  outputs: ['string | null'], complexity: 3, deps: ['fs/promises', './config', 'trim'],                  line: 20 },
        { name: 'reset',       type: 'method',   inputs: [],                                  outputs: ['void'],          complexity: 1, deps: ['fs/promises', './config'],                          line: 27 },
      ];

      assert(actual.length === expected.length,
        `TS-CHAR-01: expected ${expected.length} nodes, got ${actual.length}:\n` +
        actual.map(n => `  ${n.name} (${n.type}) line=${n.line}`).join('\n'));

      for (let i = 0; i < expected.length; i++) {
        const a = actual[i]; const e = expected[i]; const ctx = `node[${i}] "${e.name}"`;
        assert(a.name === e.name,       `TS-CHAR-01: ${ctx} name: expected "${e.name}", got "${a.name}"`);
        assert(a.type === e.type,       `TS-CHAR-01: ${ctx} type: expected "${e.type}", got "${a.type}"`);
        assert(a.complexity === e.complexity, `TS-CHAR-01: ${ctx} complexity: expected ${e.complexity}, got ${a.complexity}`);
        assert(a.line === e.line,       `TS-CHAR-01: ${ctx} line: expected ${e.line}, got ${a.line}`);
        assert(JSON.stringify(a.inputs)  === JSON.stringify(e.inputs),  `TS-CHAR-01: ${ctx} inputs: expected ${JSON.stringify(e.inputs)}, got ${JSON.stringify(a.inputs)}`);
        assert(JSON.stringify(a.outputs) === JSON.stringify(e.outputs), `TS-CHAR-01: ${ctx} outputs: expected ${JSON.stringify(e.outputs)}, got ${JSON.stringify(a.outputs)}`);
        assert(JSON.stringify(a.deps)    === JSON.stringify(e.deps),    `TS-CHAR-01: ${ctx} deps: expected ${JSON.stringify(e.deps)}, got ${JSON.stringify(a.deps)}`);
      }
    } finally {
      try { fs.rmSync(charDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ─── PY snippet ──────────────────────────────────────────────────────────────
  // Covers: standalone functions with -> return types, class with methods (self excluded),
  // external-only imports (os, typing), complexity via for/if/except.
  const PY_SNIPPET = [
    'import os',
    'from typing import Optional, List',
    '',
    'def find_files(root: str, ext: str) -> List[str]:',
    '    results = []',
    '    for entry in os.listdir(root):',
    '        if entry.endswith(ext):',
    '            results.append(entry)',
    '    return results',
    '',
    'def normalize(value: Optional[str]) -> str:',
    '    if value is None:',
    "        return ''",
    '    return value.strip().lower()',
    '',
    'class Pipeline:',
    '    def __init__(self, name: str):',
    '        self.name = name',
    '        self._steps = []',
    '',
    "    def add(self, fn) -> 'Pipeline':",
    '        self._steps.append(fn)',
    '        return self',
    '',
    '    def run(self, data):',
    '        result = data',
    '        for step in self._steps:',
    '            try:',
    '                result = step(result)',
    '            except Exception:',
    '                result = None',
    '                break',
    '        return result',
  ].join('\n');

  test('PY-CHAR-01 Python parser output matches golden: functions, class, methods, return types', () => {
    const charDir = path.join(os.tmpdir(), `nca-py-char-${Date.now()}`);
    fs.mkdirSync(charDir, { recursive: true });
    const pyFile = path.join(charDir, 'char.py');
    try {
      fs.writeFileSync(pyFile, PY_SNIPPET, 'utf-8');
      const nodes = charParser.parseFile(pyFile, '', charDir, PY_SNIPPET);
      nodes.sort((a, b) => a.line - b.line);

      const actual = nodes.map(n => ({
        name: n.name, type: n.type, inputs: n.inputs, outputs: n.outputs,
        complexity: n.complexity, deps: n.deps, line: n.line,
      }));

      const expected = [
        { name: 'find_files', type: 'function', inputs: ['root: str', 'ext: str'],  outputs: ['List[str]'],  complexity: 3, deps: ['os', 'typing'],         line: 3  },
        { name: 'normalize',  type: 'function', inputs: ['value: Optional[str]'],   outputs: ['str'],        complexity: 2, deps: ['os', 'typing'],         line: 10 },
        { name: 'Pipeline',   type: 'class',    inputs: [],                          outputs: [],             complexity: 3, deps: ['os', 'typing', 'step'], line: 15 },
        { name: '__init__',   type: 'function', inputs: ['name: str'],               outputs: [],             complexity: 1, deps: ['os', 'typing'],         line: 16 },
        { name: 'add',        type: 'function', inputs: ['fn'],                      outputs: ["'Pipeline'"], complexity: 1, deps: ['os', 'typing'],         line: 20 },
        { name: 'run',        type: 'function', inputs: ['data'],                    outputs: [],             complexity: 3, deps: ['os', 'typing', 'step'], line: 24 },
      ];

      assert(actual.length === expected.length,
        `PY-CHAR-01: expected ${expected.length} nodes, got ${actual.length}:\n` +
        actual.map(n => `  ${n.name} (${n.type}) line=${n.line}`).join('\n'));

      for (let i = 0; i < expected.length; i++) {
        const a = actual[i]; const e = expected[i]; const ctx = `node[${i}] "${e.name}"`;
        assert(a.name === e.name,       `PY-CHAR-01: ${ctx} name: expected "${e.name}", got "${a.name}"`);
        assert(a.type === e.type,       `PY-CHAR-01: ${ctx} type: expected "${e.type}", got "${a.type}"`);
        assert(a.complexity === e.complexity, `PY-CHAR-01: ${ctx} complexity: expected ${e.complexity}, got ${a.complexity}`);
        assert(a.line === e.line,       `PY-CHAR-01: ${ctx} line: expected ${e.line}, got ${a.line}`);
        assert(JSON.stringify(a.inputs)  === JSON.stringify(e.inputs),  `PY-CHAR-01: ${ctx} inputs: expected ${JSON.stringify(e.inputs)}, got ${JSON.stringify(a.inputs)}`);
        assert(JSON.stringify(a.outputs) === JSON.stringify(e.outputs), `PY-CHAR-01: ${ctx} outputs: expected ${JSON.stringify(e.outputs)}, got ${JSON.stringify(a.outputs)}`);
        assert(JSON.stringify(a.deps)    === JSON.stringify(e.deps),    `PY-CHAR-01: ${ctx} deps: expected ${JSON.stringify(e.deps)}, got ${JSON.stringify(a.deps)}`);
      }
    } finally {
      try { fs.rmSync(charDir, { recursive: true, force: true }); } catch {}
    }
  });
}

// ─── VSEARCH tests ────────────────────────────────────────────────────────────

// VSEARCH-01: basic search returns matching note
test('VSEARCH-01 vault search returns matching notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-01-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'arch.md'),
      '---\nid: arch-decision\ntype: adr\narea: backend\nstatus: vigente\nsummary: Architecture decision\n---\n\nThis note explains the authentication architecture.\n');
    fs.writeFileSync(path.join(vaultRoot, 'setup.md'),
      '---\nid: setup-guide\ntype: guide\narea: devops\nstatus: vigente\nsummary: Setup guide\n---\n\nThis note explains the project setup steps.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "authentication" --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const results = JSON.parse(out);

    assert(Array.isArray(results), 'Expected JSON array');
    assert(results.length >= 1, `Expected >=1 result, got ${results.length}`);
    assert(results[0].id === 'arch-decision', `Expected arch-decision, got ${results[0].id}`);
    assert(results[0].path.endsWith('arch.md'), 'Expected path ending with arch.md');
    assert(typeof results[0].snippet === 'string', 'Expected snippet string');
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VSEARCH-02: filter by area returns only matching notes
test('VSEARCH-02 vault search --area filters correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-02-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'a.md'),
      '---\nid: note-backend\narea: backend\nstatus: vigente\n---\n\nThis is a backend deployment process note.\n');
    fs.writeFileSync(path.join(vaultRoot, 'b.md'),
      '---\nid: note-frontend\narea: frontend\nstatus: vigente\n---\n\nThis is a frontend deployment process note.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "deployment" --area backend --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const results = JSON.parse(out);

    assert(results.length === 1, `Expected 1 result with --area backend, got ${results.length}`);
    assert(results[0].id === 'note-backend', `Expected note-backend, got ${results[0].id}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VSEARCH-03: filter by type
test('VSEARCH-03 vault search --type filters correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-03-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'adr.md'),
      '---\nid: adr-note\ntype: adr\nstatus: vigente\n---\n\nThis document describes the system configuration decisions.\n');
    fs.writeFileSync(path.join(vaultRoot, 'guide.md'),
      '---\nid: guide-note\ntype: guide\nstatus: vigente\n---\n\nThis guide covers the system configuration steps.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "configuration" --type adr --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const results = JSON.parse(out);

    assert(results.length === 1, `Expected 1 result with --type adr, got ${results.length}`);
    assert(results[0].id === 'adr-note', `Expected adr-note, got ${results[0].id}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VSEARCH-04: no results for unmatched query
test('VSEARCH-04 vault search empty result for unmatched query', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-04-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'note.md'),
      '---\nid: simple-note\nstatus: vigente\n---\n\nThis note has some ordinary content.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "xyzzy_no_match_12345" --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const results = JSON.parse(out);

    assert(Array.isArray(results), 'Expected JSON array');
    assert(results.length === 0, `Expected empty array, got ${results.length}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VSEARCH-05: --limit respected
test('VSEARCH-05 vault search --limit restricts result count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-05-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(vaultRoot, `note${i}.md`),
        `---\nid: note-${i}\nstatus: vigente\n---\n\nThis note talks about infrastructure and deployment.\n`);
    }

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "infrastructure" --limit 2 --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const results = JSON.parse(out);

    assert(results.length <= 2, `Expected <=2 results with --limit 2, got ${results.length}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VSEARCH-06: text output (no --json) includes id and path
test('VSEARCH-06 vault search text output includes id and path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vsearch-06-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'myNote.md'),
      '---\nid: my-unique-note\nstatus: vigente\n---\n\nThis note covers caching strategies.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault search "caching"`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    assert(out.includes('my-unique-note'), `Expected id in output, got:\n${out}`);
    assert(out.includes('myNote.md'), `Expected path in output, got:\n${out}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// ─── VGET tests ───────────────────────────────────────────────────────────────

// VGET-01: get by id returns frontmatter
test('VGET-01 vault get by id returns note metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vget-01-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'arch.md'),
      '---\nid: arch-design\ntype: adr\narea: backend\nstatus: vigente\nsummary: Core design decision\nupdated: 2026-01-15\n---\n\nBody of the note.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault get arch-design --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const note = JSON.parse(out);

    assert(note.id === 'arch-design', `Expected id=arch-design, got ${note.id}`);
    assert(note.type === 'adr', `Expected type=adr, got ${note.type}`);
    assert(note.area === 'backend', `Expected area=backend, got ${note.area}`);
    assert(note.status === 'vigente', `Expected status=vigente, got ${note.status}`);
    assert(note.summary === 'Core design decision', `Expected summary, got ${note.summary}`);
    assert(note.updated === '2026-01-15', `Expected updated=2026-01-15, got ${note.updated}`);
    assert(note.body === undefined, 'Expected no body without --body flag');
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VGET-02: get by path suffix returns note
test('VGET-02 vault get by path suffix resolves correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vget-02-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vaultRoot, 'subdir'), { recursive: true });

  try {
    fs.writeFileSync(path.join(vaultRoot, 'subdir', 'deep.md'),
      '---\nid: deep-note\nstatus: vigente\n---\n\nDeep note content.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault get subdir/deep.md --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const note = JSON.parse(out);

    assert(note.id === 'deep-note', `Expected id=deep-note, got ${note.id}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VGET-03: get with --body includes file content
test('VGET-03 vault get --body includes markdown content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vget-03-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    const content = '---\nid: body-note\nstatus: vigente\n---\n\nThis is the full body content for testing.\n';
    fs.writeFileSync(path.join(vaultRoot, 'body.md'), content);

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault get body-note --body --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const note = JSON.parse(out);

    assert(note.id === 'body-note', `Expected id=body-note, got ${note.id}`);
    assert(typeof note.body === 'string', 'Expected body to be a string');
    assert(note.body.includes('full body content'), `Expected body content, got: ${note.body}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VGET-04: get non-existent note exits with error
test('VGET-04 vault get non-existent note exits with error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vget-04-'));
  const dbPath = path.join(dir, 'nca.db');

  try {
    const storage = new StorageClass(dbPath);
    storage.close();

    let threw = false;
    try {
      execSync(`node ${CLI} vault get id-that-does-not-exist-999 --json`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: dbPath },
      });
    } catch (err) {
      threw = true;
      assert(err.status === 1, `Expected exit code 1, got ${err.status}`);
    }
    assert(threw, 'Expected command to exit with non-zero code');
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// VGET-05: get by stem (filename without .md extension)
test('VGET-05 vault get by filename stem resolves note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-vget-05-'));
  const dbPath = path.join(dir, 'nca.db');
  const vaultRoot = path.join(dir, 'vault');
  fs.mkdirSync(vaultRoot);

  try {
    fs.writeFileSync(path.join(vaultRoot, 'SKELETONS.md'),
      '---\nid: doc-skeletons\nstatus: vigente\n---\n\nDocument skeleton templates.\n');

    execSync(`node ${CLI} vault scan ${vaultRoot}`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });

    const out = execSync(`node ${CLI} vault get SKELETONS --json`, { encoding: 'utf-8', env: { ...process.env, NCA_DB_PATH: dbPath } });
    const note = JSON.parse(out);

    assert(note.id === 'doc-skeletons', `Expected doc-skeletons, got ${note.id}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// ── EDGE tests — doc↔code edges ──────────────────────────────────────────────

// EDGE-01: upsertDocCodeEdges creates edges for known symbols
test('EDGE-01 upsertDocCodeEdges creates edges for known symbols', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge-'));
  const dbPath = path.join(dir, 'edge.db');
  try {
    const storage = new StorageClass(dbPath);

    // Insert a node so it can be found
    storage.upsertNode({
      type: 'function', name: 'handleBook', module: 'src/router',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/routers/booking.ts', line: 10, sha256: 'abc',
    });

    // Insert a note
    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('note-1', '/vault/gotcha.md', 'vigente', 'hash1', datetime('now'))`
    ).run();

    // Upsert edges
    storage.upsertDocCodeEdges('note-1', ['handleBook']);

    const rows = storage.db.prepare(
      `SELECT * FROM doc_code_edges WHERE note_id = 'note-1'`
    ).all();

    assert(rows.length === 1, `Expected 1 edge, got ${rows.length}`);
    assert(rows[0].symbol_name === 'handleBook', `Expected symbol_name=handleBook`);
    assert(rows[0].node_id !== null, `Expected node_id to be set (linked)`);
    assert(rows[0].node_id.includes('handleBook'), `Expected node_id to contain 'handleBook'`);

    storage.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-02: upsertDocCodeEdges creates edge with node_id NULL for unknown symbol
test('EDGE-02 upsertDocCodeEdges creates edge with node_id NULL for unknown symbol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge2-'));
  const dbPath = path.join(dir, 'edge2.db');
  try {
    const storage = new StorageClass(dbPath);

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('note-2', '/vault/other.md', 'vigente', 'hash2', datetime('now'))`
    ).run();

    storage.upsertDocCodeEdges('note-2', ['nonExistentSymbol']);

    const row = storage.db.prepare(
      `SELECT * FROM doc_code_edges WHERE note_id = 'note-2'`
    ).get();

    assert(row, 'Expected an edge row');
    assert(row.symbol_name === 'nonExistentSymbol', `Expected symbol_name=nonExistentSymbol`);
    assert(row.node_id === null, `Expected node_id=NULL for unknown symbol, got: ${row.node_id}`);

    storage.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-03: getDocsBySymbol returns notes that reference the symbol
test('EDGE-03 getDocsBySymbol returns notes referencing the symbol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge3-'));
  const dbPath = path.join(dir, 'edge3.db');
  try {
    const storage = new StorageClass(dbPath);

    storage.upsertNode({
      type: 'function', name: 'myFn', module: 'src/mod',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/mod.ts', line: 1, sha256: 'def',
    });

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, summary, content_hash, indexed_at)
       VALUES ('note-3', '/vault/doc.md', 'vigente', 'test summary', 'hash3', datetime('now'))`
    ).run();

    storage.upsertDocCodeEdges('note-3', ['myFn']);

    const docs = storage.getDocsBySymbol('myFn');

    assert(docs.length === 1, `Expected 1 doc, got ${docs.length}`);
    assert(docs[0].file === '/vault/doc.md', `Expected file=/vault/doc.md, got: ${docs[0].file}`);
    assert(docs[0].excerpt === 'test summary', `Expected excerpt='test summary', got: '${docs[0].excerpt}'`);

    storage.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-04: getSymbolsByDoc returns symbols with linked/unlinked status
test('EDGE-04 getSymbolsByDoc returns symbols with linked/unlinked status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge4-'));
  const dbPath = path.join(dir, 'edge4.db');
  try {
    const storage = new StorageClass(dbPath);

    storage.upsertNode({
      type: 'function', name: 'linkedFn', module: 'src/mod',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/mod.ts', line: 1, sha256: 'ghi',
    });

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('note-4', '/vault/note4.md', 'vigente', 'hash4', datetime('now'))`
    ).run();

    storage.upsertDocCodeEdges('note-4', ['linkedFn', 'unlinkedFn']);

    const symbols = storage.getSymbolsByDoc('note-4');

    assert(symbols.length === 2, `Expected 2 symbols, got ${symbols.length}`);

    const linked = symbols.find(s => s.symbol === 'linkedFn');
    const unlinked = symbols.find(s => s.symbol === 'unlinkedFn');

    assert(linked, 'Expected linkedFn in symbols');
    assert(linked.nodeId !== null, `Expected linkedFn.nodeId to be set, got null`);

    assert(unlinked, 'Expected unlinkedFn in symbols');
    assert(unlinked.nodeId === null, `Expected unlinkedFn.nodeId=null, got: ${unlinked.nodeId}`);

    storage.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-05: nca related <symbol> returns docs (CLI integration)
test('EDGE-05 nca related <symbol> returns docs (CLI integration)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge5-'));
  const dbPath = path.join(dir, 'edge5.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    storage.upsertNode({
      type: 'function', name: 'cliTestFn', module: 'src/test',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/test.ts', line: 5, sha256: 'jkl',
    });

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, summary, content_hash, indexed_at)
       VALUES ('note-5', '/vault/test-note.md', 'vigente', 'CLI test summary', 'hash5', datetime('now'))`
    ).run();

    storage.upsertDocCodeEdges('note-5', ['cliTestFn']);
    storage.close();

    const out = run('related cliTestFn');
    assert(out.includes('cliTestFn'), `Expected cliTestFn in output, got: ${out}`);
    assert(out.includes('/vault/test-note.md'), `Expected note path in output, got: ${out}`);
    assert(out.includes('1 docs found'), `Expected '1 docs found', got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-06: nca related <doc_id> returns symbols with linked/unlinked status (CLI)
test('EDGE-06 nca related <doc_id> returns symbols with status (CLI)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge6-'));
  const dbPath = path.join(dir, 'edge6.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    storage.upsertNode({
      type: 'function', name: 'knownFn', module: 'src/known',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/known.ts', line: 1, sha256: 'mno',
    });

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('note-6', '/vault/edge6.md', 'vigente', 'hash6', datetime('now'))`
    ).run();

    storage.upsertDocCodeEdges('note-6', ['knownFn', 'unknownFn']);
    storage.close();

    // Use note id as the argument (contains no '/' but the note path does)
    const out = run('related note-6');
    assert(out.includes('knownFn'), `Expected knownFn in output, got: ${out}`);
    assert(out.includes('unknownFn'), `Expected unknownFn in output, got: ${out}`);
    assert(out.includes('[linked]'), `Expected [linked] status, got: ${out}`);
    assert(out.includes('[unlinked]'), `Expected [unlinked] status, got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-07: vault scan processes references.symbols and creates edges
test('EDGE-07 vault scan processes references.symbols and creates edges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge7-'));
  const vaultRoot = path.join(dir, 'vault');
  const dbPath = path.join(dir, 'edge7.db');
  fs.mkdirSync(vaultRoot);
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    // Write a markdown note with references.symbols frontmatter
    fs.writeFileSync(path.join(vaultRoot, 'gotcha.md'), [
      '---',
      'type: gotcha',
      'status: vigente',
      'summary: Test gotcha',
      'references:',
      '  symbols: [handleBook, createInternalAppointment]',
      '---',
      '',
      '# Gotcha',
      'Some body text.',
    ].join('\n'));

    // Insert a matching code node before scanning
    const storage = new StorageClass(dbPath);
    storage.upsertNode({
      type: 'function', name: 'handleBook', module: 'src/router',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 1, file: '/app/src/routers/booking.ts', line: 10, sha256: 'pqr',
    });
    storage.close();

    // Run vault scan via CLI
    run(`vault scan ${vaultRoot}`);

    // Check edges were created
    const Database2 = require('better-sqlite3');
    const db2 = new Database2(dbPath);
    try {
      const edges = db2.prepare(
        `SELECT symbol_name, node_id FROM doc_code_edges ORDER BY symbol_name`
      ).all();

      assert(edges.length === 2, `Expected 2 edges, got ${edges.length}: ${JSON.stringify(edges)}`);

      const handleBookEdge = edges.find(e => e.symbol_name === 'handleBook');
      const createEdge = edges.find(e => e.symbol_name === 'createInternalAppointment');

      assert(handleBookEdge, 'Expected edge for handleBook');
      assert(handleBookEdge.node_id !== null, `Expected handleBook edge to be linked`);

      assert(createEdge, 'Expected edge for createInternalAppointment');
      assert(createEdge.node_id === null, `Expected createInternalAppointment to be unlinked (null node_id)`);
    } finally {
      db2.close();
    }
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// EDGE-08: vault scan ignores notes without references.symbols without error
test('EDGE-08 vault scan ignores notes without references.symbols silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-edge8-'));
  const vaultRoot = path.join(dir, 'vault');
  const dbPath = path.join(dir, 'edge8.db');
  fs.mkdirSync(vaultRoot);
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    // Note without references.symbols
    fs.writeFileSync(path.join(vaultRoot, 'plain.md'), [
      '---',
      'type: arquitectura',
      'status: vigente',
      'summary: Plain note without symbols',
      '---',
      '',
      '# Architecture Note',
      'No symbols here.',
    ].join('\n'));

    // Should not throw
    let threw = false;
    try {
      run(`vault scan ${vaultRoot}`);
    } catch (err) {
      threw = true;
    }
    assert(!threw, 'vault scan should not throw on notes without references.symbols');

    // No edges should be created
    const Database2 = require('better-sqlite3');
    const db2 = new Database2(dbPath);
    try {
      const count = db2.prepare(`SELECT COUNT(*) AS n FROM doc_code_edges`).get().n;
      assert(count === 0, `Expected 0 edges for note without symbols, got ${count}`);
    } finally {
      db2.close();
    }
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// ── AUDIT tests ───────────────────────────────────────────────────────────────

// AUDIT-01: nca docs audit calculates coverage % correctly
test('AUDIT-01 nca docs audit calculates coverage % correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-audit1-'));
  const dbPath = path.join(dir, 'audit1.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    // Add 4 nodes: 2 documented, 2 not
    for (let i = 1; i <= 4; i++) {
      storage.upsertNode({
        type: 'function', name: `fn${i}`, module: 'src/mod',
        inputs: [], outputs: [], deps: [], effects: [],
        complexity: 1, file: `/app/src/mod.ts`, line: i, sha256: `hash${i}`,
      });
    }

    // Add notes and edges for fn1 and fn2 only
    for (let i = 1; i <= 2; i++) {
      storage.db.prepare(
        `INSERT INTO notes (id, path, status, content_hash, indexed_at)
         VALUES (?, ?, 'vigente', ?, datetime('now'))`
      ).run(`note-a${i}`, `/vault/doc${i}.md`, `hashN${i}`);
      storage.upsertDocCodeEdges(`note-a${i}`, [`fn${i}`]);
    }

    storage.close();

    const out = run('docs audit');
    assert(out.includes('Indexed symbols:'), `Expected coverage header, got: ${out}`);
    assert(out.includes('4'), `Expected total of 4 symbols`);
    assert(out.includes('2'), `Expected 2 documented`);
    // Check percentage is in the output
    assert(out.match(/50%/), `Expected 50% coverage, got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// AUDIT-02: nca docs audit lists top undocumented by PageRank
test('AUDIT-02 nca docs audit lists top undocumented symbols by centrality', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-audit2-'));
  const dbPath = path.join(dir, 'audit2.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    // Add nodes without any documentation
    storage.upsertNode({
      type: 'function', name: 'centralFn', module: 'src/mod',
      inputs: [], outputs: [], deps: [], effects: [],
      complexity: 5, file: `/app/src/central.ts`, line: 1, sha256: 'c1',
    });
    storage.upsertNode({
      type: 'function', name: 'leafFn', module: 'src/mod',
      inputs: [], outputs: [], deps: ['centralFn'], effects: [],
      complexity: 1, file: `/app/src/leaf.ts`, line: 1, sha256: 'l1',
    });

    storage.close();

    const out = run('docs audit');
    assert(out.includes('Undocumented'), `Expected undocumented section, got: ${out}`);
    assert(out.includes('centralFn') || out.includes('leafFn'),
      `Expected at least one undocumented symbol listed, got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// AUDIT-03: nca docs audit detects orphaned docs
test('AUDIT-03 nca docs audit detects orphaned docs (all symbols unlinked)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-audit3-'));
  const dbPath = path.join(dir, 'audit3.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    // Note with all broken references (symbols not in graph)
    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('orphan-1', '/vault/orphaned.md', 'vigente', 'hashO', datetime('now'))`
    ).run();
    storage.upsertDocCodeEdges('orphan-1', ['ghostFn', 'phantomFn']);

    storage.close();

    const out = run('docs audit');
    assert(out.includes('Orphaned docs') || out.includes('orphaned'),
      `Expected orphaned docs section, got: ${out}`);
    assert(out.includes('/vault/orphaned.md'),
      `Expected orphaned doc path in output, got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
});

// AUDIT-04: nca docs audit detects broken edges
test('AUDIT-04 nca docs audit detects broken edges (symbol in doc but not in graph)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-audit4-'));
  const dbPath = path.join(dir, 'audit4.db');
  const prevDb = process.env.NCA_DB_PATH;
  process.env.NCA_DB_PATH = dbPath;

  try {
    const storage = new StorageClass(dbPath);

    storage.db.prepare(
      `INSERT INTO notes (id, path, status, content_hash, indexed_at)
       VALUES ('broken-1', '/vault/broken.md', 'vigente', 'hashB', datetime('now'))`
    ).run();
    // Symbol does not exist in code graph
    storage.upsertDocCodeEdges('broken-1', ['deletedFunction']);

    storage.close();

    const out = run('docs audit');
    assert(out.includes('Broken edges') || out.includes('broken'),
      `Expected broken edges section, got: ${out}`);
    assert(out.includes('deletedFunction'),
      `Expected deletedFunction in broken edges output, got: ${out}`);
  } finally {
    if (prevDb === undefined) delete process.env.NCA_DB_PATH;
    else process.env.NCA_DB_PATH = prevDb;
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
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

// ─── TASK tests ───────────────────────────────────────────────────────────────

{
  const { saveTask, loadTask, clearTask } = require(path.join(ROOT, 'dist', 'task.js'));

  // TASK-01: saveTask creates .nca/current-task.json with correct fields
  test('TASK-01 saveTask creates .nca/current-task.json with correct fields', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    try {
      saveTask(taskDir, 'test task description');
      const taskFile = path.join(taskDir, '.nca', 'current-task.json');
      assert(fs.existsSync(taskFile), `Expected task file at ${taskFile}`);
      const raw = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      assert(raw.description === 'test task description', `Expected description, got: ${raw.description}`);
      assert(typeof raw.createdAt === 'string' && raw.createdAt.length > 0, 'Expected createdAt string');
      assert(raw.repoRoot === taskDir, `Expected repoRoot=${taskDir}, got: ${raw.repoRoot}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
    }
  });

  // TASK-02: loadTask returns null if file does not exist
  test('TASK-02 loadTask returns null when no task file exists', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    try {
      const result = loadTask(taskDir);
      assert(result === null, `Expected null, got: ${JSON.stringify(result)}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
    }
  });

  // TASK-03: saveTask overwrites existing task
  test('TASK-03 saveTask overwrites existing task', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    try {
      saveTask(taskDir, 'first task');
      saveTask(taskDir, 'second task');
      const result = loadTask(taskDir);
      assert(result !== null, 'Expected task to exist');
      assert(result.description === 'second task', `Expected "second task", got: ${result.description}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
    }
  });

  // TASK-04: clearTask deletes the task file
  test('TASK-04 clearTask removes the task file', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    try {
      saveTask(taskDir, 'to be cleared');
      clearTask(taskDir);
      const result = loadTask(taskDir);
      assert(result === null, `Expected null after clear, got: ${JSON.stringify(result)}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
    }
  });

  // TASK-05: CLI nca task --show displays active task
  test('TASK-05 nca task --show displays current task', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    const prevDb = process.env.NCA_DB_PATH;
    try {
      saveTask(taskDir, 'my active cli task');
      const out = execSync(`node ${CLI} task --show`, {
        encoding: 'utf-8',
        cwd: taskDir,
        env: { ...process.env, NCA_DB_PATH: path.join(taskDir, 'nca.db') },
      });
      assert(out.includes('my active cli task'), `Expected task description in output, got: ${out}`);
      assert(out.includes('Current task:'), `Expected "Current task:" prefix, got: ${out}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // TASK-06: CLI nca task --show message when no task
  test('TASK-06 nca task --show shows clear message when no task active', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-task-'));
    const prevDb = process.env.NCA_DB_PATH;
    try {
      const out = execSync(`node ${CLI} task --show`, {
        encoding: 'utf-8',
        cwd: taskDir,
        env: { ...process.env, NCA_DB_PATH: path.join(taskDir, 'nca.db') },
      });
      assert(out.includes('No active task'), `Expected "No active task" message, got: ${out}`);
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });
}

// ─── BRIEF tests ──────────────────────────────────────────────────────────────

{
  const { saveTask, clearTask } = require(path.join(ROOT, 'dist', 'task.js'));
  const { generateBrief } = require(path.join(ROOT, 'dist', 'compiler', 'brief.js'));

  // BRIEF-01: brief --light without active task → error (no crash)
  test('BRIEF-01 brief --light without task active exits with error', () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(taskDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;
    // ensure no task file present
    try {
      let threw = false;
      try {
        execSync(`node ${CLI} brief --light`, {
          encoding: 'utf-8',
          cwd: taskDir,
          env: { ...process.env, NCA_DB_PATH: tmpDb },
        });
      } catch (err) {
        threw = true;
        assert(err.status === 1, `Expected exit code 1, got ${err.status}`);
        assert(
          (err.stderr || '').includes('No active task') || (err.message || '').includes('No active task'),
          `Expected "No active task" in stderr, got: ${err.stderr}`
        );
      }
      assert(threw, 'Expected brief --light to exit non-zero with no task');
    } finally {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BRIEF-02: brief --light with task → markdown not empty
  test('BRIEF-02 brief --light with active task produces non-empty markdown', () => {
    const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(briefDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      // Create minimal DB with a scan so storage opens ok
      fs.writeFileSync(path.join(briefDir, 'app.ts'), 'export function init() { return 1; }\n');
      execSync(`node ${CLI} scan ${briefDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      saveTask(briefDir, 'init function review');

      const result = generateBrief({ task: { description: 'init function review', createdAt: new Date().toISOString(), repoRoot: briefDir }, repoRoot: briefDir });
      assert(typeof result.markdown === 'string' && result.markdown.length > 0,
        'Expected non-empty markdown');
      assert(result.markdown.includes('## NCA Brief'), 'Expected ## NCA Brief header');
      assert(result.markdown.includes('init function review'), 'Expected task description in brief');
    } finally {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BRIEF-03: brief --light token count <= 300
  test('BRIEF-03 brief --light token count is <= 300', () => {
    const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(briefDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      fs.writeFileSync(path.join(briefDir, 'app.ts'), [
        'export function authenticate(user: string, token: string): boolean { return token.length > 0; }',
        'export function authorize(role: string, resource: string): boolean { return role === "admin"; }',
        'export function validate(input: string): boolean { return input.trim().length > 0; }',
      ].join('\n'));
      execSync(`node ${CLI} scan ${briefDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      const result = generateBrief({
        task: { description: 'authenticate user token validation', createdAt: new Date().toISOString(), repoRoot: briefDir },
        repoRoot: briefDir,
      });
      assert(result.tokens <= 300,
        `Expected tokens <= 300, got ${result.tokens}. Brief:\n${result.markdown}`);
    } finally {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BRIEF-04: brief --light excludes docs with status 'obsoleto'
  test('BRIEF-04 brief --light excludes docs with status obsoleto', () => {
    const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(briefDir, '.nca');
    const vaultDir = path.join(briefDir, 'vault');
    fs.mkdirSync(ncaDir, { recursive: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      fs.writeFileSync(path.join(briefDir, 'app.ts'), 'export function migrate() { return true; }\n');
      execSync(`node ${CLI} scan ${briefDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      // Index vault with one obsoleto and one vigente note
      fs.writeFileSync(path.join(vaultDir, 'old.md'),
        '---\nid: old-migration\nstatus: obsoleto\nsummary: Old migration guide\n---\n\nThis migration guide is obsolete and should not appear.\n');
      fs.writeFileSync(path.join(vaultDir, 'current.md'),
        '---\nid: current-migration\nstatus: vigente\nsummary: Current migration guide\n---\n\nThis migration guide is current and valid.\n');
      execSync(`node ${CLI} vault scan ${vaultDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      const result = generateBrief({
        task: { description: 'migrate database schema', createdAt: new Date().toISOString(), repoRoot: briefDir },
        repoRoot: briefDir,
        vaultRoot: briefDir,
      });

      // The markdown must NOT contain the obsoleto doc
      assert(!result.markdown.includes('old-migration'),
        `Expected obsoleto doc to be excluded from brief. Got:\n${result.markdown}`);
      assert(!result.markdown.includes('Old migration guide'),
        `Expected obsoleto summary to be excluded. Got:\n${result.markdown}`);
    } finally {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BRIEF-05: brief --light --json produces valid parseable JSON
  test('BRIEF-05 brief --light --json produces valid JSON', () => {
    const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(briefDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      fs.writeFileSync(path.join(briefDir, 'app.ts'), 'export function start() { return 1; }\n');
      execSync(`node ${CLI} scan ${briefDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      saveTask(briefDir, 'start application review');

      const out = execSync(`node ${CLI} brief --light --json`, {
        encoding: 'utf-8',
        cwd: briefDir,
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(`brief --json output is not valid JSON: ${e.message}\nOutput: ${out.slice(0, 300)}`);
      }

      assert(typeof parsed.task === 'string', 'Expected task string in JSON');
      assert(parsed.level === 'light', `Expected level='light', got: ${parsed.level}`);
      assert(typeof parsed.tokens === 'number', 'Expected tokens number in JSON');
      assert(Array.isArray(parsed.symbols), 'Expected symbols array in JSON');
      assert(Array.isArray(parsed.docs), 'Expected docs array in JSON');
      assert(Array.isArray(parsed.gotchas), 'Expected gotchas array in JSON');
      assert(typeof parsed.markdown === 'string', 'Expected markdown string in JSON');
    } finally {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BRIEF-06: brief --light without vaultRoot works (only symbols)
  test('BRIEF-06 brief --light without vaultRoot works with symbols only', () => {
    const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-brief-'));
    const ncaDir = path.join(briefDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      fs.writeFileSync(path.join(briefDir, 'app.ts'), 'export function connect() { return true; }\n');
      execSync(`node ${CLI} scan ${briefDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      // generateBrief without vaultRoot — must not throw, must produce markdown
      const result = generateBrief({
        task: { description: 'connect database', createdAt: new Date().toISOString(), repoRoot: briefDir },
        repoRoot: briefDir,
        // no vaultRoot
      });

      assert(typeof result.markdown === 'string' && result.markdown.length > 0,
        'Expected non-empty markdown without vaultRoot');
      assert(result.docs.length === 0, 'Expected 0 docs when no vaultRoot provided');
      assert(result.gotchas.length === 0, 'Expected 0 gotchas when no vaultRoot provided');
      assert(result.tokens <= 300, `Expected tokens <= 300, got ${result.tokens}`);
    } finally {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });
}

// ─── BCONFIG: brief reads vaultRoot from config ───────────────────────────────

{
  const { resolveVaultRoot, readDocSources } = require(path.join(ROOT, 'dist', 'config.js'));
  const { generateBrief } = require(path.join(ROOT, 'dist', 'compiler', 'brief.js'));

  // BCONFIG-01: brief reads config.local.json and uses external path as vaultRoot
  test('BCONFIG-01 brief resolves vaultRoot from config.local.json external source', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-'));
    const ncaDir = path.join(repoDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });

    // Create a fake external vault dir (doesn't need a real DB for this test)
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-vault-'));

    try {
      // Write config.local.json with an external docSource
      fs.writeFileSync(
        path.join(ncaDir, 'config.local.json'),
        JSON.stringify({
          version: 1,
          docSources: [{ type: 'external', path: vaultDir, label: 'Test vault' }],
        }),
      );

      const resolved = resolveVaultRoot(repoDir, undefined);
      assert(resolved === vaultDir, `Expected vaultRoot '${vaultDir}', got '${resolved}'`);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch {}
    }
  });

  // BCONFIG-02: --root explicit takes precedence over config.local.json
  test('BCONFIG-02 explicit --root overrides config.local.json external source', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-'));
    const ncaDir = path.join(repoDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });

    const configVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-cvault-'));
    const explicitVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-evault-'));

    try {
      fs.writeFileSync(
        path.join(ncaDir, 'config.local.json'),
        JSON.stringify({
          version: 1,
          docSources: [{ type: 'external', path: configVaultDir }],
        }),
      );

      // Explicit root must win
      const resolved = resolveVaultRoot(repoDir, explicitVaultDir);
      assert(resolved === explicitVaultDir,
        `Expected explicit vault '${explicitVaultDir}', got '${resolved}'`);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(configVaultDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(explicitVaultDir, { recursive: true, force: true }); } catch {}
    }
  });

  // BCONFIG-03: no config.local.json → brief works without vault (no crash)
  test('BCONFIG-03 brief does not crash when config.local.json is absent', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-'));
    const ncaDir = path.join(repoDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      // No config.local.json, no config.json
      fs.writeFileSync(path.join(repoDir, 'service.ts'), 'export function init() {}\n');
      execSync(`node ${CLI} scan ${repoDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      const vaultRoot = resolveVaultRoot(repoDir, undefined);
      assert(vaultRoot === undefined, `Expected undefined when no config, got '${vaultRoot}'`);

      const result = generateBrief({
        task: { description: 'initialize service', createdAt: new Date().toISOString(), repoRoot: repoDir },
        repoRoot: repoDir,
        vaultRoot,
      });

      assert(typeof result.markdown === 'string' && result.markdown.length > 0,
        'Expected non-empty markdown even without config.local.json');
      assert(result.docs.length === 0, 'Expected 0 docs without vault');
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });

  // BCONFIG-04: config.local.json exists but has no external sources → brief works without vault
  test('BCONFIG-04 brief works without vault when config.local.json has no external sources', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-bconfig-'));
    const ncaDir = path.join(repoDir, '.nca');
    fs.mkdirSync(ncaDir, { recursive: true });
    const tmpDb = path.join(ncaDir, 'nca.db');
    const prevDb = process.env.NCA_DB_PATH;
    process.env.NCA_DB_PATH = tmpDb;

    try {
      // config.local.json with only internal sources (no external)
      fs.writeFileSync(
        path.join(ncaDir, 'config.local.json'),
        JSON.stringify({
          version: 1,
          docSources: [{ type: 'internal', path: './docs' }],
        }),
      );

      fs.writeFileSync(path.join(repoDir, 'handler.ts'), 'export function handle() {}\n');
      execSync(`node ${CLI} scan ${repoDir}`, {
        encoding: 'utf-8',
        env: { ...process.env, NCA_DB_PATH: tmpDb },
      });

      const vaultRoot = resolveVaultRoot(repoDir, undefined);
      assert(vaultRoot === undefined,
        `Expected undefined when no external sources, got '${vaultRoot}'`);

      const result = generateBrief({
        task: { description: 'handle request', createdAt: new Date().toISOString(), repoRoot: repoDir },
        repoRoot: repoDir,
        vaultRoot,
      });

      assert(typeof result.markdown === 'string' && result.markdown.length > 0,
        'Expected non-empty markdown when config has no external sources');
      assert(result.docs.length === 0, 'Expected 0 docs without external vault');
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
      if (prevDb === undefined) delete process.env.NCA_DB_PATH;
      else process.env.NCA_DB_PATH = prevDb;
    }
  });
}

// ─── REDACT tests — secret redaction for orientation telemetry ────────────────
{
  const { redactString, redact, redactLine } = require(path.join(ROOT, 'dist', 'hooks', 'lib', 'redact.js'));
  const gone = (out, secret) => !out.includes(secret);
  const marked = (out) => /\[REDACTED/.test(out);

  test('REDACT-01 API_KEY=sk- value is redacted', () => {
    const out = redactString('API_KEY=sk-abc123DEF456ghi');
    assert(gone(out, 'sk-abc123DEF456ghi') && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-02 GitHub ghp_ token is redacted', () => {
    const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    const out = redactString(`token ${tok} end`);
    assert(gone(out, tok) && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-03 Stripe sk_live_ key is redacted', () => {
    const key = 'sk_live_' + '51H8aB2cD3eF4gH5iJ6kL7mN';
    const out = redactString(`STRIPE=${key}`);
    assert(gone(out, key) && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-04 AWS AKIA access key id is redacted', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE1';
    const out = redactString(`AWS_ACCESS_KEY_ID=${key}`);
    assert(gone(out, key) && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-05 JWT is redacted', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5Nqyz9aBcDeF';
    const out = redactString(`Authorization: Bearer ${jwt}`);
    assert(gone(out, jwt) && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-06 PEM block is redacted', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nggSjAgEAAoIBAQ==\n-----END PRIVATE KEY-----';
    const out = redactString(`key:\n${pem}\n`);
    assert(gone(out, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw') && marked(out), `not redacted: ${out}`);
  });

  test('REDACT-07 token inside a nested string is redacted (object walk)', () => {
    const tok = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4';
    const obj = redact({ msg: `calling api with token=${tok}` });
    assert(gone(obj.msg, tok) && marked(obj.msg), `not redacted: ${obj.msg}`);
  });

  test('REDACT-08 secret in a deep object (3+ levels) is redacted', () => {
    const secret = 'sk-deepNested0123456789abcdef';
    const obj = redact({ a: { b: { c: { val: `API_KEY=${secret}` } } } });
    assert(gone(obj.a.b.c.val, secret) && marked(obj.a.b.c.val), `not redacted: ${obj.a.b.c.val}`);
  });

  test('REDACT-09 negative: the word "secret" in prose is not over-redacted', () => {
    const prose = 'This is a secret feature; please keep it private and do not tell.';
    const out = redactString(prose);
    assert(out === prose, `over-redacted prose: ${out}`);
  });

  test('REDACT-10 redactLine second pass scrubs a raw secret in a serialized line', () => {
    const tok = 'ghp_' + 'M4n3B2v1C6x5Z8a7S0d9F2g1H4j3K6l5';
    const line = JSON.stringify({ leaked: tok });
    const out = redactLine(line);
    assert(gone(out, tok) && marked(out), `not redacted: ${out}`);
  });
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
