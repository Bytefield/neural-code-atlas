/**
 * Corpus extractor tests.
 * Consumed by test/run.js via: require('./corpus.test.js')(test, assert)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// Fixtures follow the real corpus layout: <corpusHome>/.claude/projects/<slug>/
const FIXTURES_CORPUS_HOME = path.join(__dirname, 'fixtures', 'corpus');
const TEST_CORPUS_DIR = path.join(FIXTURES_CORPUS_HOME, '.claude', 'projects', '-test-project');

// Modules under test (from dist/ after npm run build)
function loadModules() {
  return {
    slug: require(path.join(ROOT, 'dist', 'corpus', 'slug.js')),
    reader: require(path.join(ROOT, 'dist', 'corpus', 'reader.js')),
    events: require(path.join(ROOT, 'dist', 'corpus', 'events.js')),
    writer: require(path.join(ROOT, 'dist', 'corpus', 'writer.js')),
    types: require(path.join(ROOT, 'dist', 'corpus', 'types.js')),
    index: require(path.join(ROOT, 'dist', 'corpus', 'index.js')),
  };
}

module.exports = function runCorpusTests(test, assert) {
  const m = loadModules();
  const { resolveProjectSlug } = m.slug;
  const { parseSessionFile, readAllSessions } = m.reader;
  const { deriveSessionEvents } = m.events;
  const { checkExistingVersion, resolveOutputPath } = m.writer;
  const { SCHEMA_VERSION, EXTRACTOR_VERSION } = m.types;
  const { extract } = m.index;

  // ── CORPUS-1: resolveProjectSlug ────────────────────────────────────────────

  test('CORPUS-1a resolveProjectSlug WSL path', () => {
    assert(resolveProjectSlug('/mnt/c/dev/synio') === '-mnt-c-dev-synio',
      'Expected -mnt-c-dev-synio');
  });

  test('CORPUS-1b resolveProjectSlug Windows path', () => {
    assert(resolveProjectSlug('C:\\dev\\synio') === 'C--dev-synio',
      'Expected C--dev-synio');
  });

  test('CORPUS-1c resolveProjectSlug alphanumeric only', () => {
    assert(resolveProjectSlug('myproject') === 'myproject',
      'Expected myproject unchanged');
  });

  // ── CORPUS-2: corrupted line does not abort session ─────────────────────────

  test('CORPUS-2 corrupted line does not abort session', () => {
    const corruptedPath = path.join(TEST_CORPUS_DIR, 'session-corrupted-002.jsonl');
    const result = parseSessionFile(corruptedPath);
    // Session has 6 lines total: 1 attachment + corrupted + 2 user + 1 assistant + 1 tool_result user
    // After skipping the corrupted line, 5 valid lines remain
    assert(result.lines.length === 5,
      `Expected 5 valid lines after skipping corrupted one, got ${result.lines.length}`);
    assert(result.realEventCount >= 2,
      `Expected at least 2 real events, got ${result.realEventCount}`);
  });

  // ── CORPUS-3: tool_result message does NOT generate user_prompt_submit ───────

  test('CORPUS-3 tool_result-only message excluded from user_prompt_submit', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...session,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());

    const prompts = events.filter(e => e.event_type === 'user_prompt_submit');
    // Session has 2 real prompts + 1 tool_result response → should yield exactly 2 user_prompt_submit
    assert(prompts.length === 2,
      `Expected 2 user_prompt_submit events, got ${prompts.length}`);

    // Verify no raw text in any event
    for (const ev of events) {
      const serialized = JSON.stringify(ev);
      assert(!serialized.includes('first prompt text for testing'),
        'Raw prompt text must not appear in events');
      assert(!serialized.includes('second prompt text for testing'),
        'Raw prompt text must not appear in events');
    }
  });

  // ── CORPUS-4: subagent flag — agent-* prefix ─────────────────────────────────

  test('CORPUS-4a agent-* prefix session has subagent=true', () => {
    const agentSession = parseSessionFile(path.join(TEST_CORPUS_DIR, 'agent-sub-session-004.jsonl'));
    const derivedSession = {
      sessionId: 'agent-sub-session-004',
      filename: 'agent-sub-session-004.jsonl',
      isAgentPrefixed: true, // filename starts with agent-
      ...agentSession,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    assert(events.length > 0, 'Expected events from agent session');
    assert(events.every(e => e.subagent === true),
      'All events from agent-* session must have subagent=true');
  });

  test('CORPUS-4b isSidechain=true session has subagent=true', () => {
    const sidechainSession = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-sidechain-005.jsonl'));
    assert(sidechainSession.hasSidechainTrue === true,
      'Expected hasSidechainTrue=true for sidechain session');
    const derivedSession = {
      sessionId: 'session-sidechain-005',
      filename: 'session-sidechain-005.jsonl',
      isAgentPrefixed: false,
      ...sidechainSession,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    assert(events.every(e => e.subagent === true),
      'All events from isSidechain session must have subagent=true');
  });

  test('CORPUS-4c regular session has subagent=false', () => {
    const regularSession = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...regularSession,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    assert(events.every(e => e.subagent === false),
      'All events from regular session must have subagent=false');
  });

  // ── CORPUS-5: event_id is deterministic ──────────────────────────────────────

  test('CORPUS-5 event_id is deterministic across runs', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...session,
    };
    const now = '2026-06-26T00:00:00.000Z';
    const events1 = deriveSessionEvents(derivedSession, 'test-project', 'baseline', now);
    const events2 = deriveSessionEvents(derivedSession, 'test-project', 'baseline', now);

    assert(events1.length === events2.length, 'Same number of events on both runs');
    for (let i = 0; i < events1.length; i++) {
      assert(events1[i].event_id === events2[i].event_id,
        `event_id at index ${i} must be stable: ${events1[i].event_id} vs ${events2[i].event_id}`);
    }
    // event_id must be a 16-char hex string
    for (const ev of events1) {
      assert(/^[0-9a-f]{16}$/.test(ev.event_id),
        `event_id must be 16-char hex, got: ${ev.event_id}`);
    }
  });

  // ── CORPUS-6: schema_version + extractor_version in every event ─────────────

  test('CORPUS-6 schema_version and extractor_version in every event', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...session,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    for (const ev of events) {
      assert(ev.schema_version === SCHEMA_VERSION,
        `Expected schema_version=${SCHEMA_VERSION}, got ${ev.schema_version}`);
      assert(ev.extractor_version === EXTRACTOR_VERSION,
        `Expected extractor_version=${EXTRACTOR_VERSION}, got ${ev.extractor_version}`);
    }
  });

  // ── CORPUS-7: no raw prompt text in output ───────────────────────────────────

  test('CORPUS-7 no raw prompt text in any event field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      // In dry-run, no file is written, but we can still check derived events via the reader
      const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
      const derivedSession = {
        sessionId: 'session-regular-001',
        filename: 'session-regular-001.jsonl',
        isAgentPrefixed: false,
        ...session,
      };
      const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
      const allJson = JSON.stringify(events);

      // None of the raw prompt text should appear
      assert(!allJson.includes('first prompt text for testing'), 'Raw prompt text must not appear in events JSON');
      assert(!allJson.includes('second prompt text for testing'), 'Raw prompt text must not appear in events JSON');
      assert(!allJson.includes('file content here'), 'Tool result content must not appear');

      // prompt_hash must be 16-char hex, prompt_length must be a positive number
      const promptEvents = events.filter(e => e.event_type === 'user_prompt_submit');
      for (const pe of promptEvents) {
        assert(/^[0-9a-f]{16}$/.test(pe.prompt_hash ?? ''),
          `prompt_hash must be 16-char hex, got: ${pe.prompt_hash}`);
        assert(typeof pe.prompt_length === 'number' && pe.prompt_length > 0,
          `prompt_length must be positive number, got: ${pe.prompt_length}`);
      }

      void report;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-8: empty session is excluded ──────────────────────────────────────

  test('CORPUS-8 empty session (<5 real events) is excluded', () => {
    const emptySession = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-empty-003.jsonl'));
    assert(emptySession.realEventCount < 5,
      `Expected <5 real events in empty session, got ${emptySession.realEventCount}`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });
      const exclusions = report.exclusionReasons;
      assert((exclusions['too_few_events'] ?? 0) >= 1,
        `Expected at least 1 exclusion by too_few_events, got: ${JSON.stringify(exclusions)}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-9: manifest written with sha256 ───────────────────────────────────

  test('CORPUS-9 manifest written with correct fields and output_sha256', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      assert(report.outputPath && fs.existsSync(report.outputPath),
        'Output JSONL must exist after write');
      assert(report.manifestPath && fs.existsSync(report.manifestPath),
        'Manifest must exist after write');

      const manifest = JSON.parse(fs.readFileSync(report.manifestPath, 'utf-8'));
      assert(manifest.schema_version === SCHEMA_VERSION, 'Manifest must have schema_version');
      assert(manifest.extractor_version === EXTRACTOR_VERSION, 'Manifest must have extractor_version');
      assert(typeof manifest.output_sha256 === 'string' && manifest.output_sha256.length === 64,
        `Manifest must have 64-char output_sha256, got: ${manifest.output_sha256}`);
      assert(typeof manifest.sessions_seen === 'number', 'Manifest must have sessions_seen');
      assert(typeof manifest.sessions_included === 'number', 'Manifest must have sessions_included');
      assert(manifest.project === 'test-project', 'Manifest must have correct project name');

      // Verify sha256 matches the actual file content
      const fileContent = fs.readFileSync(report.outputPath);
      const actualSha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
      assert(manifest.output_sha256 === actualSha256,
        `Manifest sha256 must match file, expected ${actualSha256}, got ${manifest.output_sha256}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-10: idempotence — re-run does not duplicate events ───────────────

  test('CORPUS-10 re-run produces identical output (idempotent)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const run1 = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
        forceRewrite: true,
      });

      const sha1 = JSON.parse(fs.readFileSync(run1.manifestPath, 'utf-8')).output_sha256;
      const count1 = fs.readFileSync(run1.outputPath, 'utf-8').split('\n').filter(Boolean).length;

      const run2 = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
        forceRewrite: true,
      });

      const sha2 = JSON.parse(fs.readFileSync(run2.manifestPath, 'utf-8')).output_sha256;
      const count2 = fs.readFileSync(run2.outputPath, 'utf-8').split('\n').filter(Boolean).length;

      assert(count1 === count2,
        `Event count must be identical across runs: ${count1} vs ${count2}`);
      // sha256 of events JSONL will differ due to derived_at timestamp changing between runs,
      // but event COUNT and event_ids must be stable
      const lines1 = fs.readFileSync(run1.outputPath, 'utf-8').split('\n').filter(Boolean);
      const lines2 = fs.readFileSync(run2.outputPath, 'utf-8').split('\n').filter(Boolean);
      const ids1 = lines1.map(l => JSON.parse(l).event_id).sort();
      const ids2 = lines2.map(l => JSON.parse(l).event_id).sort();
      assert(JSON.stringify(ids1) === JSON.stringify(ids2),
        'event_ids must be identical across runs (deterministic)');

      void sha1; void sha2; // derived_at changes between runs, sha256 will differ — that's expected
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-11: version mismatch aborts unless --force-rewrite ───────────────

  test('CORPUS-11 incompatible version aborts without --force-rewrite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      // Plant an output with a different version
      const outDir = path.join(tmpDir, '.nca', 'metrics', 'test-project');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, 'orientation-events.jsonl');
      fs.writeFileSync(outPath, JSON.stringify({
        event_id: 'x',
        schema_version: 'orientation_event_v0', // old version
        extractor_version: '0.0.1',
        source: 'claude_corpus',
      }) + '\n');

      let threw = false;
      try {
        extract({
          projectName: 'test-project',
          projectRoot: '/test/project',
          phase: 'baseline',
          dryRun: false,
          corpusHome: FIXTURES_CORPUS_HOME,
          metricsHome: tmpDir,
          forceRewrite: false,
        });
      } catch (err) {
        threw = true;
        assert(err.message.includes('Incompatible output version'),
          `Expected incompatible version error, got: ${err.message}`);
      }
      assert(threw, 'Expected extract to throw on version mismatch');

      // With --force-rewrite it should succeed
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
        forceRewrite: true,
      });
      assert(report.sessionsIncluded >= 0, 'force-rewrite should succeed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-12: --project-root explicit (no registry) ────────────────────────

  test('CORPUS-12 --project-root explicit works without any registry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project', // explicit root → slug = -test-project
        phase: 'baseline',
        dryRun: true,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });
      assert(report.slug === '-test-project',
        `Expected slug -test-project, got ${report.slug}`);
      assert(report.sessionsTotal >= 0, 'Should report sessions without needing a registry');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-13: gitBranch captured from corpus ────────────────────────────────

  test('CORPUS-13 gitBranch is extracted from session events', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    assert(session.sessionGitBranch === 'main',
      `Expected gitBranch=main from attachment event, got: ${session.sessionGitBranch}`);

    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...session,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    for (const ev of events) {
      assert(ev.git_branch === 'main',
        `Expected git_branch=main on all events, got: ${ev.git_branch}`);
    }
  });

  // ── CORPUS-14: output written outside any repo ────────────────────────────────

  test('CORPUS-14 output path is outside any repo (under ~/.nca/metrics/)', () => {
    const { resolveOutputPath: rop } = m.writer;
    const outPath = rop('synio');
    assert(outPath.includes(path.join('.nca', 'metrics', 'synio')),
      `Output path must be under ~/.nca/metrics/synio, got: ${outPath}`);
    // Must not be inside any known repo path
    assert(!outPath.includes('/dev/') || outPath.startsWith(os.homedir()),
      `Output path must not be inside a repo: ${outPath}`);
  });

  // ── CORPUS-15: post_tool_use captures file_path from Read/Write/Edit/Grep ────

  test('CORPUS-15 post_tool_use captures file_path from tool input', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-regular-001.jsonl'));
    const derivedSession = {
      sessionId: 'session-regular-001',
      filename: 'session-regular-001.jsonl',
      isAgentPrefixed: false,
      ...session,
    };
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', new Date().toISOString());
    const toolEvents = events.filter(e => e.event_type === 'post_tool_use');
    assert(toolEvents.length >= 1, 'Expected at least one post_tool_use event');
    const readEvent = toolEvents.find(e => e.tool_name === 'Read');
    assert(readEvent !== undefined, 'Expected a Read tool_use event');
    assert(readEvent.file_path === '/test/project/src/file.ts',
      `Expected file_path=/test/project/src/file.ts, got: ${readEvent.file_path}`);
    const writeEvent = toolEvents.find(e => e.tool_name === 'Write');
    assert(writeEvent !== undefined, 'Expected a Write tool_use event');
    assert(writeEvent.file_path === '/test/project/src/out.ts',
      `Expected file_path=/test/project/src/out.ts, got: ${writeEvent.file_path}`);
  });
};
