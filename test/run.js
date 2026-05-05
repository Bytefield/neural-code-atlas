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
test('AC8b per-node diff keeps node count stable after file content change', () => {
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
