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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);

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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
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
    const events1 = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
    const events2 = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);

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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
    for (const ev of events) {
      assert(ev.schema_version === SCHEMA_VERSION,
        `Expected schema_version=${SCHEMA_VERSION}, got ${ev.schema_version}`);
      assert(ev.extractor_version === EXTRACTOR_VERSION,
        `Expected extractor_version=${EXTRACTOR_VERSION}, got ${ev.extractor_version}`);
      assert('source_cwd' in ev,
        `Every event must have source_cwd field (schema v2)`);
      assert(ev.source_cwd === '/test/project',
        `Expected source_cwd=/test/project, got ${ev.source_cwd}`);
    }
    // schema_version must be v2 (new field source_cwd was added in v2)
    assert(SCHEMA_VERSION === 'orientation_event_v2',
      `Expected SCHEMA_VERSION=orientation_event_v2, got ${SCHEMA_VERSION}`);
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
      const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
      const allJson = JSON.stringify(events);

      // None of the raw prompt text should appear
      assert(!allJson.includes('first prompt text for testing'), 'Raw prompt text must not appear in events JSON');
      assert(!allJson.includes('second prompt text for testing'), 'Raw prompt text must not appear in events JSON');
      assert(!allJson.includes('file content here'), 'Tool result content must not appear');

      // derived_at must NOT be in events (moved to manifest.generated_at for reproducibility)
      assert(!allJson.includes('"derived_at"'), 'derived_at must not appear in events after reproducibility fix');

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
      assert(typeof manifest.generated_at === 'string' && manifest.generated_at.length > 0,
        'Manifest must have generated_at (extraction run timestamp)');
      assert(manifest.cwd_filter_mode === 'main-only',
        `Manifest must have cwd_filter_mode=main-only (default), got ${manifest.cwd_filter_mode}`);
      assert(typeof manifest.cwd_event_counts === 'object' && manifest.cwd_event_counts !== null,
        'Manifest must have cwd_event_counts object');

      // Verify sha256 matches the actual file content
      const fileContent = fs.readFileSync(report.outputPath);
      const actualSha256 = crypto.createHash('sha256').update(fileContent).digest('hex');
      assert(manifest.output_sha256 === actualSha256,
        `Manifest sha256 must match file, expected ${actualSha256}, got ${manifest.output_sha256}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-10: bit-exact reproducibility — same inputs → same output_sha256 ──

  test('CORPUS-10 re-run with same corpus produces identical JSONL bytes (bit-exact)', () => {
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

      // Bit-exact reproducibility: same corpus → same JSONL bytes → same sha256.
      // (derived_at was removed from events; only manifest.generated_at is volatile.)
      assert(sha1 === sha2,
        `output_sha256 must be identical across runs.\nRun1: ${sha1}\nRun2: ${sha2}`);

      // Also verify event_ids are stable (independent check)
      const lines1 = fs.readFileSync(run1.outputPath, 'utf-8').split('\n').filter(Boolean);
      const lines2 = fs.readFileSync(run2.outputPath, 'utf-8').split('\n').filter(Boolean);
      const ids1 = lines1.map(l => JSON.parse(l).event_id).sort();
      const ids2 = lines2.map(l => JSON.parse(l).event_id).sort();
      assert(JSON.stringify(ids1) === JSON.stringify(ids2),
        'event_ids must be identical across runs');

      // No derived_at in the JSONL output
      const allContent = fs.readFileSync(run1.outputPath, 'utf-8');
      assert(!allContent.includes('"derived_at"'),
        'derived_at must not appear in JSONL output');
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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
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
    const events = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
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

  // ── CORPUS-16: main-only filter excludes worktree events ─────────────────────

  test('CORPUS-16 main-only filter excludes events from worktree cwd', () => {
    const session = parseSessionFile(path.join(TEST_CORPUS_DIR, 'session-worktree-006.jsonl'));
    const derivedSession = {
      sessionId: 'session-worktree-006',
      filename: 'session-worktree-006.jsonl',
      isAgentPrefixed: false,
      ...session,
    };

    // main-only: only events with cwd=/test/project
    const mainOnlyEvents = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', false);
    // Session has 7 events with cwd=/test/project: 1 session_start, 3 prompts, 3 tool_use
    assert(mainOnlyEvents.every(e => e.source_cwd === '/test/project'),
      'main-only mode: all events must have source_cwd=/test/project');
    const worktreeEvents = mainOnlyEvents.filter(e => e.source_cwd === '/test/project-worktree');
    assert(worktreeEvents.length === 0,
      `main-only mode: 0 worktree events expected, got ${worktreeEvents.length}`);

    // include-worktrees: all events
    const allEvents = deriveSessionEvents(derivedSession, 'test-project', 'baseline', '/test/project', true);
    assert(allEvents.length > mainOnlyEvents.length,
      `include-worktrees must produce more events than main-only: ${allEvents.length} vs ${mainOnlyEvents.length}`);
    const worktreeInAll = allEvents.filter(e => e.source_cwd === '/test/project-worktree');
    assert(worktreeInAll.length > 0,
      'include-worktrees mode: must include events with worktree cwd');
  });

  // ── CORPUS-17: --include-worktrees via extract() ──────────────────────────────

  test('CORPUS-17 extract() include-worktrees produces more events than main-only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const mainOnly = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        includeWorktrees: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      const withWorktrees = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        includeWorktrees: true,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      assert(mainOnly.cwdFilterMode === 'main-only',
        `Expected cwdFilterMode=main-only, got ${mainOnly.cwdFilterMode}`);
      assert(withWorktrees.cwdFilterMode === 'include-worktrees',
        `Expected cwdFilterMode=include-worktrees, got ${withWorktrees.cwdFilterMode}`);
      assert(withWorktrees.totalEvents > mainOnly.totalEvents,
        `include-worktrees (${withWorktrees.totalEvents}) must exceed main-only (${mainOnly.totalEvents})`);

      // Delta breakdown:
      // - session-worktree-006: 4 worktree events (2 user_prompt_submit + 2 post_tool_use)
      // - session-sparse-main-007: 5 events in include-worktrees (1 session_start + 4 user_prompt_submit);
      //   excluded in main-only because only 2 main-cwd events < 5 threshold
      assert(withWorktrees.totalEvents - mainOnly.totalEvents === 9,
        `Delta must be 9, got ${withWorktrees.totalEvents - mainOnly.totalEvents}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-18: source_cwd present in all events ───────────────────────────────

  test('CORPUS-18 source_cwd field present in every event and reflects line cwd', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const report = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: false,
        includeWorktrees: true,   // use include-worktrees so we get worktree events too
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
        forceRewrite: true,
      });

      assert(report.outputPath && fs.existsSync(report.outputPath), 'Output must exist');

      const lines = fs.readFileSync(report.outputPath, 'utf-8').split('\n').filter(Boolean);
      assert(lines.length > 0, 'Expected events in output');

      for (const line of lines) {
        const ev = JSON.parse(line);
        assert('source_cwd' in ev,
          `source_cwd must be present in every event, missing in: ${ev.event_id}`);
        // source_cwd must be a non-empty string or null (not undefined)
        assert(ev.source_cwd === null || (typeof ev.source_cwd === 'string' && ev.source_cwd.length > 0),
          `source_cwd must be non-empty string or null, got ${ev.source_cwd} in ${ev.event_id}`);
      }

      // cwd_event_counts in manifest must match actual event distribution
      const manifest = JSON.parse(fs.readFileSync(report.manifestPath, 'utf-8'));
      assert(typeof manifest.cwd_event_counts === 'object', 'Manifest must have cwd_event_counts');
      const totalFromCwdCounts = Object.values(manifest.cwd_event_counts).reduce((s, v) => s + v, 0);
      assert(totalFromCwdCounts === report.totalEvents,
        `cwd_event_counts total (${totalFromCwdCounts}) must equal totalEvents (${report.totalEvents})`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── CORPUS-19: threshold applied to cwd-filtered count, not raw count ─────────
  //
  // session-sparse-main-007: 2 main events + 5 worktree events = 7 total real events.
  // Old (wrong) order: count 7 total → pass threshold (≥5) → filter by cwd → emit 2 events.
  // New (correct) order: filter by cwd → count 2 main events → fail threshold (<5) → exclude.

  test('CORPUS-19 threshold uses cwd-filtered count (main-only excludes sparse-main session)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-corpus-test-'));
    try {
      const mainOnly = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        includeWorktrees: false,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      const withWorktrees = extract({
        projectName: 'test-project',
        projectRoot: '/test/project',
        phase: 'baseline',
        dryRun: true,
        includeWorktrees: true,
        corpusHome: FIXTURES_CORPUS_HOME,
        metricsHome: tmpDir,
      });

      // sparse-main-007 passes the raw threshold (7 total ≥ 5) but fails the
      // main-cwd threshold (2 main events < 5), so it must be excluded in main-only.
      assert(withWorktrees.sessionsIncluded > mainOnly.sessionsIncluded,
        `include-worktrees must include sparse-main session: ${withWorktrees.sessionsIncluded} vs ${mainOnly.sessionsIncluded}`);

      // too_few_events exclusion count must be strictly higher in main-only
      const mainOnlyTooFew = mainOnly.exclusionReasons['too_few_events'] ?? 0;
      const wtTooFew = withWorktrees.exclusionReasons['too_few_events'] ?? 0;
      assert(mainOnlyTooFew > wtTooFew,
        `main-only must exclude more sessions via too_few_events: ${mainOnlyTooFew} vs ${wtTooFew}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── PROXY tests: orientation proxy analyzer ───────────────────────────────────

  const FIXTURES_ANALYZER = path.join(__dirname, 'fixtures', 'analyzer');
  const SAMPLE_JSONL = path.join(FIXTURES_ANALYZER, 'sample-events.jsonl');
  const SAMPLE_MANIFEST = path.join(FIXTURES_ANALYZER, 'sample-events.manifest.json');

  function loadAnalyzer() {
    return require(path.join(ROOT, 'dist', 'corpus', 'analyzer.js'));
  }

  // Helper: build a minimal OrientationEvent
  function mkEvent(overrides) {
    return Object.assign({
      event_id: 'ev-' + Math.random().toString(36).slice(2, 8),
      schema_version: SCHEMA_VERSION,
      extractor_version: EXTRACTOR_VERSION,
      source: 'claude_corpus',
      source_project: 'test',
      nca_experiment_phase: 'baseline',
      subagent: false,
      git_branch: 'main',
      source_cwd: '/proj',
    }, overrides);
  }

  // ── PROXY-01: Read+Grep before Edit counted correctly ─────────────────────────

  test('PROXY-01 pre_edit_read_tools counts Read and Grep before first write', () => {
    const { analyzeEvents } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 's1', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's1', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Read', file_path: '/a.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's1', timestamp: '2026-06-01T10:00:02.000Z', tool_name: 'Grep', file_path: null }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's1', timestamp: '2026-06-01T10:00:03.000Z', tool_name: 'Edit', file_path: '/a.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's1', timestamp: '2026-06-01T10:00:04.000Z', tool_name: 'Read', file_path: '/b.ts' }),
    ];
    const { sessions } = analyzeEvents(events);
    assert(sessions.length === 1, `expected 1 write session, got ${sessions.length}`);
    const s = sessions[0];
    assert(s.pre_edit_read_tools_count === 2, `pre_edit_read_tools should be 2, got ${s.pre_edit_read_tools_count}`);
    assert(s.pre_edit_all_tools_count === 2, `pre_edit_all_tools should be 2, got ${s.pre_edit_all_tools_count}`);
    assert(s.first_write_tool_name === 'Edit', `first_write_tool=${s.first_write_tool_name}`);
    assert(s.has_write === true, 'has_write should be true');
  });

  // ── PROXY-02: tools AFTER first write are excluded ────────────────────────────

  test('PROXY-02 tools after first write are excluded from pre-edit counts', () => {
    const { analyzeEvents } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 's2', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's2', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Edit', file_path: '/a.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's2', timestamp: '2026-06-01T10:00:02.000Z', tool_name: 'Read', file_path: '/b.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's2', timestamp: '2026-06-01T10:00:03.000Z', tool_name: 'Grep', file_path: null }),
    ];
    const { sessions } = analyzeEvents(events);
    const s = sessions[0];
    assert(s.pre_edit_read_tools_count === 0, `expected 0 read_tools, got ${s.pre_edit_read_tools_count}`);
    assert(s.pre_edit_all_tools_count === 0, `expected 0 all_tools, got ${s.pre_edit_all_tools_count}`);
  });

  // ── PROXY-03: no-write session → no_write_sessions, excluded from aggregates ──

  test('PROXY-03 session without write tool goes to no_write_sessions', () => {
    const { analyzeEvents } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 's3', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's3', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Read', file_path: '/a.ts' }),
      mkEvent({ event_type: 'user_prompt_submit', source_session_id: 's3', timestamp: '2026-06-01T10:00:02.000Z', prompt_hash: 'x', prompt_length: 10 }),
    ];
    const { sessions, no_write_sessions } = analyzeEvents(events);
    assert(sessions.length === 0, `write-sessions should be empty, got ${sessions.length}`);
    assert(no_write_sessions.length === 1, `no_write_sessions should be 1, got ${no_write_sessions.length}`);
    assert(no_write_sessions[0].has_write === false, 'has_write must be false');
  });

  // ── PROXY-04: Bash counts in all_tools but NOT in read_tools ─────────────────

  test('PROXY-04 Bash counts in pre_edit_all_tools but not pre_edit_read_tools', () => {
    const { analyzeEvents } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 's4', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's4', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Bash', file_path: null }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's4', timestamp: '2026-06-01T10:00:02.000Z', tool_name: 'Write', file_path: '/a.ts' }),
    ];
    const { sessions } = analyzeEvents(events);
    const s = sessions[0];
    assert(s.pre_edit_read_tools_count === 0, `read_tools should be 0, got ${s.pre_edit_read_tools_count}`);
    assert(s.pre_edit_all_tools_count === 1, `all_tools should be 1, got ${s.pre_edit_all_tools_count}`);
  });

  // ── PROXY-05: MultiEdit and Write count as first_write_event ─────────────────

  test('PROXY-05 MultiEdit is recognised as a write tool', () => {
    const { analyzeEvents } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 's5', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's5', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Read', file_path: '/a.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 's5', timestamp: '2026-06-01T10:00:02.000Z', tool_name: 'MultiEdit', file_path: '/b.ts' }),
    ];
    const { sessions } = analyzeEvents(events);
    const s = sessions[0];
    assert(s.has_write === true, 'has_write should be true');
    assert(s.first_write_tool_name === 'MultiEdit', `first_write_tool=${s.first_write_tool_name}`);
    assert(s.pre_edit_read_tools_count === 1, `read_tools before MultiEdit should be 1`);
  });

  // ── PROXY-06: aggregate median/p75/mean correct on sample fixture ─────────────
  //
  // Fixture sessions:
  //   sess-A: read=3, all=3   sess-B: read=0, all=1
  //   sess-D: read=0, all=0   sess-E: read=2, all=2
  // (sess-C is no_write, excluded from aggregates)
  // read sorted: [0,0,2,3]  →  p50=1, p75=2.25, mean=1.25
  // all  sorted: [0,1,2,3]  →  p50=1.5, p75=2.25, mean=1.5

  test('PROXY-06 aggregate median/p75/mean computed correctly from sample fixture', () => {
    const { analyze } = loadAnalyzer();
    const report = analyze({
      project: 'test',
      phase: 'baseline',
      inputPath: SAMPLE_JSONL,
    });
    const agg = report.aggregate;
    assert(agg.sessions_total === 5, `sessions_total should be 5, got ${agg.sessions_total}`);
    assert(agg.sessions_with_write === 4, `sessions_with_write should be 4, got ${agg.sessions_with_write}`);
    assert(agg.sessions_without_write === 1, `sessions_without_write should be 1, got ${agg.sessions_without_write}`);
    // pre_edit_read_tools: sorted [0,0,2,3]
    assert(agg.median_pre_edit_read_tools === 1, `median_read should be 1, got ${agg.median_pre_edit_read_tools}`);
    assert(agg.p75_pre_edit_read_tools === 2.25, `p75_read should be 2.25, got ${agg.p75_pre_edit_read_tools}`);
    assert(Math.abs(agg.mean_pre_edit_read_tools - 1.25) < 0.001, `mean_read should be 1.25, got ${agg.mean_pre_edit_read_tools}`);
    // pre_edit_all_tools: sorted [0,1,2,3]
    assert(agg.median_pre_edit_all_tools === 1.5, `median_all should be 1.5, got ${agg.median_pre_edit_all_tools}`);
    assert(agg.p75_pre_edit_all_tools === 2.25, `p75_all should be 2.25, got ${agg.p75_pre_edit_all_tools}`);
    assert(Math.abs(agg.mean_pre_edit_all_tools - 1.5) < 0.001, `mean_all should be 1.5, got ${agg.mean_pre_edit_all_tools}`);
    // top_10 should contain all 4 write sessions, sorted descending by read count
    assert(agg.top_10_sessions_by_pre_edit_read_tools.length === 4, 'top_10 should have 4 entries');
    assert(agg.top_10_sessions_by_pre_edit_read_tools[0].pre_edit_read_tools_count === 3, 'top session should have read=3');
  });

  // ── PROXY-07: --json returns stable structure ─────────────────────────────────

  test('PROXY-07 analyze() returns stable JSON-serialisable structure', () => {
    const { analyze } = loadAnalyzer();
    const report = analyze({ project: 'test', phase: 'baseline', inputPath: SAMPLE_JSONL });
    const json = JSON.parse(JSON.stringify(report));
    assert(typeof json.dataset_path === 'string', 'dataset_path must be string');
    assert(json.schema_version === SCHEMA_VERSION, `schema_version mismatch: ${json.schema_version}`);
    assert(json.phase === 'baseline', `phase should be baseline`);
    assert(json.cwd_filter_mode === 'main-only', `cwd_filter_mode should be main-only`);
    assert(Array.isArray(json.sessions), 'sessions must be array');
    assert(Array.isArray(json.no_write_sessions), 'no_write_sessions must be array');
    assert(typeof json.aggregate.sessions_total === 'number', 'aggregate.sessions_total must be number');
    assert(Array.isArray(json.aggregate.top_10_sessions_by_pre_edit_read_tools), 'top_10 must be array');
  });

  // ── PROXY-08: schema_version mismatch aborts with clear error ────────────────

  test('PROXY-08 wrong schema_version in events aborts with clear error', () => {
    const { analyze } = loadAnalyzer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-proxy-test-'));
    try {
      const badJsonl = path.join(tmpDir, 'orientation-events.jsonl');
      const badManifest = path.join(tmpDir, 'orientation-events.manifest.json');
      fs.writeFileSync(badJsonl,
        JSON.stringify({ event_id: 'x', schema_version: 'orientation_event_v1',
          extractor_version: '0.0.9', source: 'claude_corpus', source_session_id: 's1',
          source_project: 'p', nca_experiment_phase: 'baseline', subagent: false,
          event_type: 'session_start', timestamp: '2026-01-01T00:00:00.000Z',
          git_branch: null, source_cwd: '/x' }) + '\n', 'utf-8');
      fs.writeFileSync(badManifest, JSON.stringify({
        schema_version: 'orientation_event_v1', extractor_version: '0.0.9',
        phase: 'baseline', cwd_filter_mode: 'main-only', sessions_included: 1,
      }), 'utf-8');

      let threw = false;
      try {
        analyze({ project: 'p', phase: 'baseline', inputPath: badJsonl });
      } catch (err) {
        threw = true;
        assert(err.message.includes('schema_version'), `error must mention schema_version: ${err.message}`);
      }
      assert(threw, 'analyze() must throw on wrong schema_version');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── PROXY-09: sessions_total mismatch aborts with clear error ────────────────

  test('PROXY-09 sessions_total / manifest.sessions_included mismatch aborts', () => {
    const { analyze } = loadAnalyzer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-proxy-test-'));
    try {
      const jsonl = path.join(tmpDir, 'orientation-events.jsonl');
      const manifest = path.join(tmpDir, 'orientation-events.manifest.json');
      // 1 session in JSONL but manifest says 99
      fs.writeFileSync(jsonl,
        JSON.stringify({ event_id: 'x', schema_version: SCHEMA_VERSION,
          extractor_version: EXTRACTOR_VERSION, source: 'claude_corpus',
          source_session_id: 'only-session', source_project: 'p',
          nca_experiment_phase: 'baseline', subagent: false,
          event_type: 'session_start', timestamp: '2026-01-01T00:00:00.000Z',
          git_branch: null, source_cwd: '/x' }) + '\n', 'utf-8');
      fs.writeFileSync(manifest, JSON.stringify({
        schema_version: SCHEMA_VERSION, extractor_version: EXTRACTOR_VERSION,
        phase: 'baseline', cwd_filter_mode: 'main-only', sessions_included: 99,
      }), 'utf-8');

      let threw = false;
      try {
        analyze({ project: 'p', phase: 'baseline', inputPath: jsonl });
      } catch (err) {
        threw = true;
        assert(err.message.includes('mismatch'), `error must mention mismatch: ${err.message}`);
      }
      assert(threw, 'analyze() must throw on sessions_total mismatch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── PROXY-10: toCSV generates correct headers and rows ───────────────────────

  test('PROXY-10 toCSV generates headers and per-session rows', () => {
    const { analyzeEvents, toCSV } = loadAnalyzer();
    const events = [
      mkEvent({ event_type: 'session_start', source_session_id: 'csv-s1', timestamp: '2026-06-01T10:00:00.000Z' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 'csv-s1', timestamp: '2026-06-01T10:00:01.000Z', tool_name: 'Read', file_path: '/a.ts' }),
      mkEvent({ event_type: 'post_tool_use', source_session_id: 'csv-s1', timestamp: '2026-06-01T10:00:02.000Z', tool_name: 'Edit', file_path: '/b.ts' }),
    ];
    const { sessions } = analyzeEvents(events);
    const csv = toCSV(sessions);
    const lines = csv.trim().split('\n');
    assert(lines[0].startsWith('source_session_id,'), `first line must be header: ${lines[0]}`);
    assert(lines.length === 2, `expected header + 1 data row, got ${lines.length} lines`);
    assert(lines[1].includes('csv-s1'), `data row must contain session id`);
  });
};
