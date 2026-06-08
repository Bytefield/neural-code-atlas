#!/usr/bin/env node

import { Command, Option } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import { Storage, resolveDbPath } from './storage.js';
import { Scanner } from './scanner.js';
import { Linker } from './linker.js';
import { ContextExpander, buildQueryJSON } from './context.js';
import { FlowDetector } from './flow.js';
import { Evolver } from './evolve.js';
import { separator, header, formatField, formatStatus, colors } from './format.js';
import { registerProject } from './registry.js';
import { generateSkill } from './skill.js';
import {
  SessionFile,
  readSession,
  listSessions,
  isBriefEvent,
} from './hooks/lib/session.js';

// Directories excluded from markdown scanning — mirrors DEFAULT_EXCLUDED_DIRS in scanner.ts
const PROJECT_MD_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'coverage', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.nca', 'vendor', '.venv', 'venv', 'env',
]);

// Read version from package.json so it never needs manual updates
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Collector for repeatable --docs options */
function collect(val: string, prev: string[]): string[] {
  return prev.concat([val]);
}

interface EnsureIndexedOptions {
  interactive: boolean;
  fromHook: boolean;
  originalQuery?: string;
  flags: {
    yes?: boolean;
    docs?: string[];
    vault?: string;
    json?: boolean;
  };
}

function runSetupWizard(repoRoot: string, originalQuery?: string): void {
  // TODO(context-compiler-phase3): interactive wizard for first-run setup
  void repoRoot; void originalQuery;
  console.error('NCA index not found. Run: nca scan .');
  process.exit(1);
}

function runSilentSetup(repoRoot: string, flags: EnsureIndexedOptions['flags']): void {
  // TODO(context-compiler-phase3): auto-detect sources and run setup from flags
  void repoRoot; void flags;
  console.error('NCA index not found. Run: nca scan .');
  process.exit(1);
}

function ensureIndexed(repoRoot: string, options: EnsureIndexedOptions): void {
  const dbPath = resolveDbPath(repoRoot);
  if (fs.existsSync(dbPath)) return;

  if (options.fromHook) {
    console.log([
      '',
      '⚠️  No NCA index found for this repo.',
      '',
      'To get context-aware assistance, run one of:',
      '  nca ask "your question" --yes',
      '  nca ask "your question" --vault <path>',
      '',
      'Or set up manually:',
      '  nca scan .',
      '',
      'Continuing without NCA context.',
      '',
    ].join('\n'));
    return;
  }

  if (options.interactive) {
    runSetupWizard(repoRoot, options.originalQuery);
  } else {
    runSilentSetup(repoRoot, options.flags);
  }
}

const program = new Command();

program
  .name('nca')
  .description('Neural Code Atlas — local semantic index for codebases')
  .version(PKG_VERSION);

// ─── mcp ────────────────────────────────────────────────────────────────────
program
  .command('mcp')
  .description('Run MCP server (stdio JSON-RPC) for Claude Code integration')
  .action(() => {
    require('./mcp.js');
  });

// ─── scan ────────────────────────────────────────────────────────────────────
program
  .command('scan [path]')
  .description('Scan a directory and build/update the NCA index')
  .option('-v, --verbose', 'verbose output')
  .action(async (scanPath: string | undefined, opts: { verbose?: boolean }) => {
    const rawPath = path.resolve(scanPath ?? process.cwd());

    if (!fs.existsSync(rawPath)) {
      process.stderr.write(`Error: path not found: ${rawPath}\n`);
      process.exit(1);
    }

    const rootPath = fs.realpathSync(rawPath);

    const dbPath = resolveDbPath(rootPath);
    const storage = new Storage(dbPath);
    const scanner = new Scanner(storage);

    if (opts.verbose) process.stdout.write(`NCA|scan|root:${rootPath}\n`);

    const result = scanner.scan(rootPath);

    if (opts.verbose) {
      process.stdout.write(
        `NCA|scan|scanned:${result.scanned}|parsed:${result.parsed}|skipped:${result.skipped}|errors:${result.errors}|ms:${result.durationMs}\n`
      );
    }

    const linker = new Linker(storage);
    linker.link(rootPath);

    const detector = new FlowDetector(storage);
    detector.detectAll();

    const { VaultScanner } = require('./vault/scanner.js') as typeof import('./vault/scanner.js');
    const vaultScanner = new VaultScanner(storage.db, storage);
    await vaultScanner.scan(rootPath, { excludedDirNames: PROJECT_MD_EXCLUDED_DIRS, quiet: true });

    const stats = storage.stats();
    const scanTag = `NCA|scan_complete|files:${stats.files}|nodes:${stats.nodes}|flows:${stats.flows}|notes:${stats.notes}|ms:${result.durationMs}`;
    const scanLines = [
      formatStatus(scanTag),
      separator(),
      '  ' + header('SCAN COMPLETE'),
      separator(),
      '  ' + formatField('nodes', stats.nodes),
      '  ' + formatField('files', stats.files),
      '  ' + formatField('flows', stats.flows),
      '  ' + formatField('notes', stats.notes),
      '  ' + formatField('duration', `${result.durationMs}ms`),
      separator(),
    ];
    process.stdout.write(scanLines.join('\n') + '\n');

    const skillContent = generateSkill(dbPath);
    const skillPath = path.join(path.dirname(dbPath), 'SKILL.md');
    fs.writeFileSync(skillPath, skillContent, 'utf-8');

    storage.close();
    registerProject(rootPath);
  });

// ─── ask ─────────────────────────────────────────────────────────────────────
program
  .command('ask <query...>')
  .description('Query the NCA semantic index')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .option('--yes', 'accept all defaults without prompting')
  .option('--docs <path>', 'add a doc source (repeatable)', collect, [])
  .option('--vault <path>', 'add an external vault path')
  .addOption(new Option('--from-hook', 'called from SessionStart hook (internal use)').hideHelp())
  .action((queryParts: string[], opts: {
    path?: string; json?: boolean; yes?: boolean;
    docs?: string[]; vault?: string; fromHook?: boolean;
  }) => {
    const query = queryParts.join(' ');
    const rootPath = path.resolve(opts.path ?? process.cwd());

    ensureIndexed(rootPath, {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      fromHook: opts.fromHook ?? false,
      originalQuery: query,
      flags: { yes: opts.yes, docs: opts.docs, vault: opts.vault, json: opts.json },
    });

    const dbPath = resolveDbPath(rootPath);

    const storage = new Storage(dbPath);
    const ctx = new ContextExpander(storage);
    let nodes = storage.search(query);

    // Log query and update frequency-based score boosts (only for symbol hits)
    const matchedIds = nodes.filter(n => n.id !== undefined).map(n => n.id as number);
    storage.logQuery(query, matchedIds);
    storage.updateNodeScores(matchedIds);

    // Path fallback: if no symbols matched, try file-path substring match
    let pathFallback = false;
    if (nodes.length === 0) {
      nodes = storage.searchByPath(query);
      pathFallback = nodes.length > 0;
    }

    const flows = storage.getAllFlows();
    const warnings = storage.getWarnings();
    const notes = storage.searchNotes(query);
    const ts = Date.now();

    if (opts.json) {
      const json = buildQueryJSON({ query, nodes, timestamp: ts }, ctx, flows, warnings, notes, pathFallback);
      process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    } else {
      const result = ctx.formatFull({ query, nodes, timestamp: ts }, flows, warnings, notes, pathFallback);
      process.stdout.write(result + '\n');
    }

    storage.close();
  });

// ─── flow ─────────────────────────────────────────────────────────────────────
program
  .command('flow <name>')
  .description('Trace execution flow from an entry point')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .option('--yes', 'accept all defaults without prompting')
  .option('--docs <path>', 'add a doc source (repeatable)', collect, [])
  .option('--vault <path>', 'add an external vault path')
  .addOption(new Option('--from-hook', 'called from SessionStart hook (internal use)').hideHelp())
  .action((name: string, opts: {
    path?: string; json?: boolean; yes?: boolean;
    docs?: string[]; vault?: string; fromHook?: boolean;
  }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());

    ensureIndexed(rootPath, {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      fromHook: opts.fromHook ?? false,
      originalQuery: undefined,
      flags: { yes: opts.yes, docs: opts.docs, vault: opts.vault, json: opts.json },
    });

    const dbPath = resolveDbPath(rootPath);
    const storage = new Storage(dbPath);
    const detector = new FlowDetector(storage);
    const result = detector.detect(name);
    storage.upsertFlow({ name, steps: result.steps });

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          name: result.name,
          steps: result.steps,
          cycleDetected: result.cycleDetected,
          truncated: result.truncated,
          timestamp: Date.now(),
        }, null, 2) + '\n'
      );
    } else {
      const ts = Date.now();
      const lines = [`NCA|flow:${name}|t:${ts}`, '[F]', detector.formatFlow(result)];
      process.stdout.write(lines.join('\n') + '\n');
    }

    storage.close();
  });

// ─── evolve ───────────────────────────────────────────────────────────────────
program
  .command('evolve')
  .description('Run architectural analysis and emit warnings')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .option('--yes', 'accept all defaults without prompting')
  .option('--docs <path>', 'add a doc source (repeatable)', collect, [])
  .option('--vault <path>', 'add an external vault path')
  .addOption(new Option('--from-hook', 'called from SessionStart hook (internal use)').hideHelp())
  .action((opts: {
    path?: string; json?: boolean; yes?: boolean;
    docs?: string[]; vault?: string; fromHook?: boolean;
  }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());

    ensureIndexed(rootPath, {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      fromHook: opts.fromHook ?? false,
      originalQuery: undefined,
      flags: { yes: opts.yes, docs: opts.docs, vault: opts.vault, json: opts.json },
    });

    const dbPath = resolveDbPath(rootPath);
    const storage = new Storage(dbPath);
    const evolver = new Evolver(storage);
    const result = evolver.analyze(rootPath);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ timestamp: Date.now(), warnings: result.warnings }, null, 2) + '\n'
      );
    } else {
      const RULE_NAMES: Record<string, string> = {
        R001: 'High complexity',
        R002: 'Long dependency chain',
        R003: 'Missing return type',
        R004: 'Circular dependency',
        R005: 'Deep call chain',
        R006: 'Isolated node',
      };
      const evolveTag = `NCA|evolve|t:${Date.now()}`;
      const evolveLines: string[] = [
        formatStatus(evolveTag),
        separator(),
        '  ' + header('ANALYSIS WARNINGS [W]'),
        separator(),
      ];
      if (result.warnings.length === 0) {
        evolveLines.push('');
        evolveLines.push('  ' + colors.green + '(no warnings)' + colors.reset);
      } else {
        const groups = new Map<string, typeof result.warnings>();
        for (const w of result.warnings) {
          const group = groups.get(w.rule_id) ?? [];
          group.push(w);
          groups.set(w.rule_id, group);
        }
        for (const [ruleId, ws] of groups) {
          const name = RULE_NAMES[ruleId] ?? ruleId;
          evolveLines.push('');
          evolveLines.push('  ' + header(`${name} (${ruleId}):`));
          for (const w of ws) {
            evolveLines.push(`    • ${w.node_id} — ${w.detail}`);
          }
        }
      }
      evolveLines.push('');
      evolveLines.push(separator());
      process.stdout.write(evolveLines.join('\n') + '\n');
    }

    storage.close();
  });

// ─── status ───────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show NCA index status')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .action((opts: { path?: string; json?: boolean }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);

    if (!fs.existsSync(dbPath)) {
      const payload = { indexed: false, dbPath };
      process.stdout.write(
        opts.json ? JSON.stringify(payload) + '\n' : `NCA|status|no_index|db:${dbPath}\n`
      );
      process.exit(0);
    }

    const storage = new Storage(dbPath);
    const stats = storage.stats();
    const ts = Date.now();

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          timestamp: ts,
          files: stats.files,
          nodes: stats.nodes,
          flows: stats.flows,
          warnings: stats.warnings,
          dbPath,
          dbSize: stats.dbSize,
        }, null, 2) + '\n'
      );
    } else {
      const sizeKb = (stats.dbSize / 1024).toFixed(0);
      const statusLines = [
        formatStatus(`NCA|status|t:${ts}`),
        separator(),
        '  ' + header('NCA STATUS'),
        separator(),
        '  ' + formatField('nodes', stats.nodes),
        '  ' + formatField('files', stats.files),
        '  ' + formatField('flows', stats.flows),
        '  ' + formatField('warnings', stats.warnings),
        '  ' + formatField('db', dbPath),
        '  ' + formatField('size', `${sizeKb} KB`),
        separator(),
      ];
      process.stdout.write(statusLines.join('\n') + '\n');
    }

    storage.close();
  });

// ─── watch ────────────────────────────────────────────────────────────────────
program
  .command('watch [path]')
  .description('Watch for file changes and auto-reindex (requires chokidar)')
  .option('-v, --verbose', 'log each reindex event')
  .action(async (watchPath: string | undefined, opts: { verbose?: boolean }) => {
    const rootPath = path.resolve(watchPath ?? process.cwd());

    if (!fs.existsSync(rootPath)) {
      process.stderr.write(`Error: path not found: ${rootPath}\n`);
      process.exit(1);
    }

    let chokidar: any;
    try {
      chokidar = require('chokidar');
    } catch {
      process.stderr.write(
        'Error: chokidar not installed. Run: npm install chokidar\n'
      );
      process.exit(1);
    }

    const dbPath = resolveDbPath(rootPath);
    const storage = new Storage(dbPath);
    const scanner = new Scanner(storage);
    const { VaultScanner } = require('./vault/scanner.js') as typeof import('./vault/scanner.js');
    const vaultScanner = new VaultScanner(storage.db, storage);

    // Initial scan
    scanner.scan(rootPath);
    await vaultScanner.scan(rootPath, { excludedDirNames: PROJECT_MD_EXCLUDED_DIRS, quiet: true });
    new Linker(storage).link(rootPath);
    new FlowDetector(storage).detectAll();
    const initStats = storage.stats();
    process.stdout.write(
      `NCA|watch_ready|root:${rootPath}|nodes:${initStats.nodes}|notes:${initStats.notes}\n`
    );

    const DEBOUNCE_MS = 300;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChanges = new Set<string>();
    const pendingDeletes = new Set<string>();

    async function flush(): Promise<void> {
      const changed = [...pendingChanges];
      const deleted = [...pendingDeletes];
      pendingChanges.clear();
      pendingDeletes.clear();

      const changedMd = changed.filter(fp => fp.endsWith('.md'));
      const changedCode = changed.filter(fp => !fp.endsWith('.md'));
      const deletedMd = deleted.filter(fp => fp.endsWith('.md'));
      const deletedCode = deleted.filter(fp => !fp.endsWith('.md'));

      // Handle code deletions
      for (const fp of deletedCode) {
        storage.deleteNodesForFile(fp);
        storage.deleteFileRecord(fp);
        if (opts.verbose) process.stdout.write(`NCA|watch_unlink|${fp}\n`);
      }

      // Handle markdown deletions
      for (const fp of deletedMd) {
        vaultScanner.deleteMdFile(fp);
        if (opts.verbose) process.stdout.write(`NCA|watch_unlink_md|${fp}\n`);
      }

      // Re-index code files
      let totalParsed = 0;
      let totalMs = 0;
      for (const fp of changedCode) {
        const r = scanner.scanFile(fp, rootPath);
        totalParsed += r.parsed;
        totalMs += r.durationMs;
        if (opts.verbose) process.stdout.write(`NCA|watch_reindex_file|${fp}|parsed:${r.parsed}|ms:${r.durationMs}\n`);
      }

      // Re-index markdown files
      for (const fp of changedMd) {
        const outcome = await vaultScanner.scanMdFile(fp);
        if (opts.verbose) process.stdout.write(`NCA|watch_reindex_md|${fp}|${outcome}\n`);
      }

      // Relink and redetect whenever anything changed
      if (deleted.length > 0 || changed.length > 0) {
        new Linker(storage).link(rootPath);
        new FlowDetector(storage).detectAll();
        const stats = storage.stats();
        process.stdout.write(
          `NCA|watch_reindex|files:${totalParsed}|nodes:${stats.nodes}|notes:${stats.notes}|ms:${totalMs}\n`
        );
        const skillContent = generateSkill(dbPath);
        const skillPath = path.join(path.dirname(dbPath), 'SKILL.md');
        fs.writeFileSync(skillPath, skillContent, 'utf-8');
      }
    }

    function schedule(fp: string, type: 'change' | 'unlink'): void {
      if (type === 'unlink') pendingDeletes.add(fp);
      else pendingChanges.add(fp);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, DEBOUNCE_MS);
    }

    const ignored = [
      /(^|[/\\])\../, // dot files/dirs
      /node_modules/,
      /[/\\]dist[/\\]/,
      /[/\\]build[/\\]/,
      /[/\\]\.nca[/\\]/,
      /[/\\]__pycache__[/\\]/,
    ];

    const watcher = chokidar.watch(rootPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher
      .on('add', (fp: string) => schedule(fp, 'change'))
      .on('change', (fp: string) => schedule(fp, 'change'))
      .on('unlink', (fp: string) => schedule(fp, 'unlink'))
      .on('error', (err: Error) => process.stderr.write(`NCA|watch_error|${err.message}\n`));

    process.stdout.write(`NCA|watching|${rootPath}\n`);

    process.on('SIGINT', () => {
      watcher.close();
      storage.close();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      watcher.close();
      storage.close();
      process.exit(0);
    });
  });

// ─── insights ─────────────────────────────────────────────────────────────────
program
  .command('insights')
  .description('Show most frequently queried nodes')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .action((opts: { path?: string; json?: boolean }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);

    if (!fs.existsSync(dbPath)) {
      const msg = `NCA|error|no_index|run: nca scan ${rootPath}`;
      process.stdout.write(opts.json ? JSON.stringify({ error: msg }) + '\n' : msg + '\n');
      process.exit(1);
    }

    const storage = new Storage(dbPath);
    const insights = storage.topInsights();

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ timestamp: Date.now(), insights }, null, 2) + '\n'
      );
    } else {
      const ts = Date.now();
      const lines = [`NCA|insights|t:${ts}`, '[HOT]'];
      for (const i of insights) {
        lines.push(`${i.name}|q:${i.query_count}|boost:${i.score_boost.toFixed(2)}|f:${i.file}`);
      }
      if (insights.length === 0) lines.push('(no data yet)');
      process.stdout.write(lines.join('\n') + '\n');
    }

    storage.close();
  });

// ─── migrate ──────────────────────────────────────────────────────────────────
program
  .command('migrate')
  .description('Manage schema migrations')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--status', 'Show migration status without applying')
  .option('--apply', 'Force migration run (already runs at startup; use to migrate explicitly)')
  .action((opts: { path?: string; status?: boolean; apply?: boolean }) => {
    if (!opts.status && !opts.apply) {
      process.stderr.write(`NCA|error|migrate requires --status or --apply\n`);
      process.exit(1);
    }

    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);
    // Storage constructor already runs pending migrations.
    const storage = new Storage(dbPath);

    if (opts.status) {
      const status = storage.getMigrationStatus();
      const migrateTag = `NCA|migrate_status|current:${status.currentVersion}|target:${status.targetVersion}|pending:${status.pending.length}`;
      const migrateLines = [
        formatStatus(migrateTag),
        separator(),
        '  ' + header('MIGRATION STATUS'),
        separator(),
        '  ' + formatField('current', status.currentVersion),
        '  ' + formatField('target', status.targetVersion),
        '  ' + formatField('pending', status.pending.length),
        '',
      ];
      if (status.pending.length === 0) {
        migrateLines.push('  ' + colors.green + 'Database is up to date.' + colors.reset);
      } else {
        migrateLines.push('  ' + colors.yellow + 'Pending migrations:' + colors.reset);
        for (const p of status.pending) {
          migrateLines.push(`    • v${p.version} — ${p.name}`);
        }
      }
      migrateLines.push(separator());
      process.stdout.write(migrateLines.join('\n') + '\n');
    } else if (opts.apply) {
      process.stdout.write(`NCA|migrate_complete\n`);
    }

    storage.close();
  });

// ─── vault ────────────────────────────────────────────────────────────────────
const vault = program.command('vault').description('Vault Obsidian operations');

vault
  .command('scan <root>')
  .description('Index a Markdown vault into NCA')
  .option('--dry-run', 'do not write to DB')
  .option('--verbose', 'verbose output')
  .action(async (root: string, opts: { dryRun?: boolean; verbose?: boolean }) => {
    const rootPath = path.resolve(root);

    if (!fs.existsSync(rootPath)) {
      process.stderr.write(`Error: path not found: ${rootPath}\n`);
      process.exit(1);
    }

    const { VaultScanner } = require('./vault/scanner.js') as typeof import('./vault/scanner.js');
    const dbPath = resolveDbPath(rootPath);
    const storage = new Storage(dbPath);
    const db = storage.db;
    const scanner = new VaultScanner(db, storage);

    await scanner.scan(rootPath, { dryRun: opts.dryRun, verbose: opts.verbose });

    storage.close();
  });

vault
  .command('search <query>')
  .description('Search vault notes via full-text search')
  .option('--root <path>', 'vault root path (must match the path used in vault scan)')
  .option('--area <area>', 'filter by area')
  .option('--type <type>', 'filter by note type')
  .option('--status <status>', 'filter by status (vigente|borrador|obsoleto)')
  .option('--limit <n>', 'max results (default 10, max 50)', '10')
  .option('--json', 'output as JSON')
  .option('--yes', 'accept all defaults without prompting')
  .option('--docs <path>', 'add a doc source (repeatable)', collect, [])
  .option('--vault <path>', 'add an external vault path')
  .addOption(new Option('--from-hook', 'called from SessionStart hook (internal use)').hideHelp())
  .action((query: string, opts: {
    root?: string; area?: string; type?: string; status?: string;
    limit: string; json?: boolean; yes?: boolean;
    docs?: string[]; vault?: string; fromHook?: boolean;
  }) => {
    const repoRoot = process.cwd();
    ensureIndexed(repoRoot, {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      fromHook: opts.fromHook ?? false,
      originalQuery: query,
      flags: { yes: opts.yes, docs: opts.docs, vault: opts.vault, json: opts.json },
    });

    const dbPath = opts.root ? resolveDbPath(path.resolve(opts.root)) : resolveDbPath();
    const storage = new Storage(dbPath);

    const limit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 10), 50);
    const filters = {
      ...(opts.area ? { area: opts.area } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };

    const results = storage.vaultSearch(query, filters, limit);
    storage.close();

    if (opts.json) {
      process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      return;
    }

    if (results.length === 0) {
      process.stdout.write('No results found.\n');
      return;
    }

    const lines: string[] = [separator()];
    for (const r of results) {
      const area = r.area ?? '—';
      const type = r.type ?? '—';
      const updated = r.updated ?? '—';
      const summary = r.summary ? (r.summary.length > 60 ? r.summary.slice(0, 57) + '...' : r.summary) : '—';
      lines.push(`${colors.bold}${r.id}${colors.reset} | ${area} | ${type} | ${updated} | ${summary}`);
      lines.push(`  ${colors.gray}${r.path}${colors.reset}`);
      if (r.snippet) lines.push(`  ${colors.gray}${r.snippet}${colors.reset}`);
      lines.push(separator());
    }
    process.stdout.write(lines.join('\n') + '\n');
  });

vault
  .command('get <id_or_path>')
  .description('Retrieve a vault note by id or path')
  .option('--root <path>', 'vault root path (must match the path used in vault scan)')
  .option('--body', 'include full markdown body')
  .option('--json', 'output as JSON')
  .option('--yes', 'accept all defaults without prompting')
  .option('--docs <path>', 'add a doc source (repeatable)', collect, [])
  .option('--vault <path>', 'add an external vault path')
  .addOption(new Option('--from-hook', 'called from SessionStart hook (internal use)').hideHelp())
  .action((idOrPath: string, opts: {
    root?: string; body?: boolean; json?: boolean; yes?: boolean;
    docs?: string[]; vault?: string; fromHook?: boolean;
  }) => {
    const repoRoot = process.cwd();
    ensureIndexed(repoRoot, {
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      fromHook: opts.fromHook ?? false,
      originalQuery: undefined,
      flags: { yes: opts.yes, docs: opts.docs, vault: opts.vault, json: opts.json },
    });

    const dbPath = opts.root ? resolveDbPath(path.resolve(opts.root)) : resolveDbPath();
    const storage = new Storage(dbPath);

    const note = storage.vaultGet(idOrPath, opts.body);
    storage.close();

    if (!note) {
      process.stderr.write(`Error: note not found: ${idOrPath}\n`);
      process.exit(1);
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(note, null, 2) + '\n');
      return;
    }

    const lines: string[] = [
      separator(),
      header(note.id),
      '',
      formatField('path',       note.path),
      formatField('status',     note.status),
      formatField('area',       note.area ?? '—'),
      formatField('type',       note.type ?? '—'),
      formatField('updated',    note.updated ?? '—'),
      formatField('indexed_at', note.indexed_at),
    ];
    if (note.summary) lines.push(formatField('summary', note.summary));
    lines.push(separator());
    if (opts.body && note.body !== undefined) {
      lines.push('');
      lines.push(note.body);
    }
    process.stdout.write(lines.join('\n') + '\n');
  });

// ─── related ──────────────────────────────────────────────────────────────────

program
  .command('related <symbol_or_doc>')
  .description('Show docs referencing a symbol, or symbols referenced by a doc')
  .option('--root <path>', 'vault/project root to use for DB resolution')
  .option('--json', 'output as JSON')
  .action((symbolOrDoc: string, opts: { root?: string; json?: boolean }) => {
    const dbPath = opts.root ? resolveDbPath(path.resolve(opts.root)) : resolveDbPath();
    const storage = new Storage(dbPath);

    // Resolution strategy:
    // 1. If arg contains '/' or ends with '.md' → definitely a doc path/id
    // 2. Otherwise: try vaultGet — if a note with that id/stem exists, treat as doc; else as symbol
    const looksLikeDoc = symbolOrDoc.includes('/') || symbolOrDoc.endsWith('.md');
    const noteCandidate = storage.vaultGet(symbolOrDoc);
    const isDoc = looksLikeDoc || noteCandidate !== null;

    if (isDoc) {
      // Resolve to note_id: use the looked-up note id or fall back to the raw arg
      const noteId = noteCandidate?.id ?? symbolOrDoc;
      const symbols = storage.getSymbolsByDoc(noteId);
      storage.close();

      if (opts.json) {
        process.stdout.write(JSON.stringify({ doc: symbolOrDoc, symbols }, null, 2) + '\n');
        return;
      }

      const linked = symbols.filter(s => s.nodeId !== null).length;
      process.stdout.write(`Symbols referenced by '${symbolOrDoc}':\n`);
      if (symbols.length === 0) {
        process.stdout.write('  (none)\n');
      } else {
        for (const s of symbols) {
          const status = s.nodeId ? '[linked]' : '[unlinked]';
          process.stdout.write(`  ${s.symbol} ${status}\n`);
        }
      }
      process.stdout.write(`(${symbols.length} symbols, ${linked} linked to code graph)\n`);
    } else {
      // Treat as symbol name
      const docs = storage.getDocsBySymbol(symbolOrDoc);
      storage.close();

      if (opts.json) {
        process.stdout.write(JSON.stringify({ symbol: symbolOrDoc, docs }, null, 2) + '\n');
        return;
      }

      process.stdout.write(`Docs referencing '${symbolOrDoc}':\n`);
      if (docs.length === 0) {
        process.stdout.write('  (none)\n');
      } else {
        for (const d of docs) {
          const summary = d.excerpt ? ` — ${d.excerpt}` : '';
          process.stdout.write(`  ${d.file}${summary}\n`);
        }
      }
      process.stdout.write(`(${docs.length} docs found)\n`);
    }
  });

// ─── docs ─────────────────────────────────────────────────────────────────────

const docs = program.command('docs').description('Documentation coverage operations');

docs
  .command('audit')
  .description('Audit documentation coverage of the code graph (read-only)')
  .option('--root <path>', 'project root to use for DB resolution')
  .option('--json', 'output as JSON')
  .action((opts: { root?: string; json?: boolean }) => {
    const dbPath = opts.root ? resolveDbPath(path.resolve(opts.root)) : resolveDbPath();
    const storage = new Storage(dbPath);
    const db = storage.db;

    // 1. All nodes in graph
    const allNodes = storage.getAllNodes();
    const totalSymbols = allNodes.length;

    // 2. Which nodes have at least one doc_code_edge with non-null node_id?
    // node_id in doc_code_edges is stored as "file:name" composite
    const documentedNodeIds = new Set<string>(
      (db.prepare(`SELECT DISTINCT node_id FROM doc_code_edges WHERE node_id IS NOT NULL`).all() as { node_id: string }[])
        .map(r => r.node_id)
    );

    const documentedCount = allNodes.filter(n => documentedNodeIds.has(`${n.file}:${n.name}`)).length;
    const undocumentedNodes = allNodes.filter(n => !documentedNodeIds.has(`${n.file}:${n.name}`));

    // 3. Top undocumented by PageRank
    // Compute pagerank on the live graph
    const { GraphSnapshot } = require('./graph.js') as typeof import('./graph.js');
    const { pagerank } = require('./graph/pagerank.js') as typeof import('./graph/pagerank.js');
    const snap = GraphSnapshot.build(storage);
    const ranks = pagerank(snap);

    // Sort undocumented by pagerank descending
    const undocWithRank = undocumentedNodes
      .map(n => ({ node: n, rank: ranks.get(`${n.file}:${n.name}`) ?? 0 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 10);

    // 4. Orphaned docs: notes with references.symbols where ALL edges have node_id NULL
    const orphanedRows = db.prepare(`
      SELECT dce.note_id, n.path, COUNT(*) as total,
             SUM(CASE WHEN dce.node_id IS NULL THEN 1 ELSE 0 END) as broken
      FROM doc_code_edges dce
      JOIN notes n ON n.id = dce.note_id
      GROUP BY dce.note_id, n.path
      HAVING broken = total AND total > 0
    `).all() as { note_id: string; path: string; total: number; broken: number }[];

    // 5. Broken edges: edges where node_id IS NULL
    const brokenRows = db.prepare(`
      SELECT dce.symbol_name, COUNT(*) as doc_count
      FROM doc_code_edges dce
      WHERE dce.node_id IS NULL
      GROUP BY dce.symbol_name
      ORDER BY doc_count DESC
    `).all() as { symbol_name: string; doc_count: number }[];

    storage.close();

    const coveragePct = totalSymbols > 0
      ? Math.round((documentedCount / totalSymbols) * 100)
      : 0;

    if (opts.json) {
      const result = {
        totalSymbols,
        documentedCount,
        undocumentedCount: totalSymbols - documentedCount,
        coveragePct,
        topUndocumented: undocWithRank.map(({ node, rank }) => ({
          name: node.name,
          file: node.file,
          rank,
        })),
        orphanedDocs: orphanedRows.map(r => ({
          noteId: r.note_id,
          path: r.path,
          brokenRefs: r.broken,
        })),
        brokenEdges: brokenRows.map(r => ({
          symbol: r.symbol_name,
          docCount: r.doc_count,
        })),
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    const lines: string[] = [
      'NCA Documentation Coverage',
      '─'.repeat(40),
      `Indexed symbols:     ${totalSymbols}`,
      `Documented:          ${documentedCount}  (${coveragePct}%)`,
      `Undocumented:        ${totalSymbols - documentedCount}  (${100 - coveragePct}%)`,
    ];

    if (undocWithRank.length > 0) {
      lines.push('');
      lines.push('Top undocumented symbols (by centrality):');
      for (const { node } of undocWithRank) {
        const name = node.name.padEnd(30);
        lines.push(`  ${name} ${node.file}`);
      }
    }

    if (orphanedRows.length > 0) {
      lines.push('');
      lines.push('Orphaned docs (all referenced symbols unlinked):');
      for (const r of orphanedRows) {
        lines.push(`  ${r.path} — ${r.broken} broken reference${r.broken !== 1 ? 's' : ''}`);
      }
    }

    if (brokenRows.length > 0) {
      lines.push('');
      lines.push('Broken edges (symbol referenced in docs but not in graph):');
      for (const r of brokenRows) {
        lines.push(`  ${r.symbol_name} — referenced in ${r.doc_count} doc${r.doc_count !== 1 ? 's' : ''}, not in graph`);
      }
    }

    process.stdout.write(lines.join('\n') + '\n');
  });

// ─── task ─────────────────────────────────────────────────────────────────────

program
  .command('task [description]')
  .description('Declare the current task (stored in .nca/current-task.json)')
  .option('--show', 'show the current active task')
  .option('--clear', 'clear the active task')
  .action((description: string | undefined, opts: { show?: boolean; clear?: boolean }) => {
    const { saveTask, loadTask, clearTask } = require('./task.js') as typeof import('./task.js');
    const rootPath = process.cwd();

    if (opts.clear) {
      clearTask(rootPath);
      process.stdout.write('Task cleared.\n');
      return;
    }

    if (opts.show) {
      const task = loadTask(rootPath);
      if (!task) {
        process.stdout.write("No active task. Run: nca task '<description>'\n");
        return;
      }
      const ageSec = Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 1000);
      let ageStr: string;
      if (ageSec < 60) ageStr = `${ageSec}s`;
      else if (ageSec < 3600) ageStr = `${Math.floor(ageSec / 60)}m`;
      else if (ageSec < 86400) ageStr = `${Math.floor(ageSec / 3600)}h`;
      else ageStr = `${Math.floor(ageSec / 86400)}d`;
      process.stdout.write(`Current task: ${task.description}\n(set ${ageStr} ago)\n`);
      return;
    }

    if (!description || description.trim() === '') {
      process.stderr.write("Error: provide a task description or use --show / --clear\n");
      process.exit(1);
    }

    saveTask(rootPath, description.trim());
    process.stdout.write(`Task set: ${description.trim()}\n`);
  });

// ─── brief ────────────────────────────────────────────────────────────────────

program
  .command('brief')
  .description('Generate a context brief for the active task')
  .option('--light', 'generate a light brief (~300 tokens) — default and only level')
  .option('--root <path>', 'vault root path for doc lookup')
  .option('--json', 'output as JSON')
  .action((opts: { light?: boolean; root?: string; json?: boolean }) => {
    const { loadTask } = require('./task.js') as typeof import('./task.js');
    const { generateBrief } = require('./compiler/brief.js') as typeof import('./compiler/brief.js');
    const { resolveVaultRoot } = require('./config.js') as typeof import('./config.js');

    const rootPath = process.cwd();
    const task = loadTask(rootPath);

    if (!task) {
      process.stderr.write("No active task. Run: nca task '<description>' first.\n");
      process.exit(1);
    }

    // Precedence: --root flag > .nca/config.local.json external source > .nca/config.json external source > undefined
    const explicitRoot = opts.root ? path.resolve(opts.root) : undefined;
    const vaultRoot = resolveVaultRoot(rootPath, explicitRoot);
    const result = generateBrief({ task, repoRoot: rootPath, vaultRoot });

    if (opts.json) {
      const payload = {
        task: task.description,
        level: 'light',
        tokens: result.tokens,
        symbols: result.symbols,
        docs: result.docs,
        gotchas: result.gotchas,
        markdown: result.markdown,
      };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else {
      process.stdout.write(result.markdown + '\n');
    }
  });

// ─── session report / compare ────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const safe = ms < 0 ? 0 : ms;
  const totalSec = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

interface SessionStats {
  briefCalls: number;
  grepCalls: number;
  grepAfterBrief: number;
  grepBlocked: number;
  globCalls: number;
  globAfterBrief: number;
  globBlocked: number;
  readCalls: number;
  editWriteCalls: number;
  blockedTotal: number;
  totalCalls: number;
  durationMs: number;
  ttfe: string;
}

function computeSessionStats(session: SessionFile): SessionStats {
  let briefCalls = 0;
  let grepCalls = 0, grepAfterBrief = 0, grepBlocked = 0;
  let globCalls = 0, globAfterBrief = 0, globBlocked = 0;
  let readCalls = 0;
  let editWriteCalls = 0;

  for (const e of session.events) {
    if (isBriefEvent(e)) {
      briefCalls++;
    } else if (e.tool === 'Grep') {
      grepCalls++;
      if (e.fallback_after_brief) grepAfterBrief++;
      if (e.blocked) grepBlocked++;
    } else if (e.tool === 'Glob') {
      globCalls++;
      if (e.fallback_after_brief) globAfterBrief++;
      if (e.blocked) globBlocked++;
    } else if (e.tool === 'Read') {
      readCalls++;
    } else if (e.tool === 'Edit' || e.tool === 'Write') {
      editWriteCalls++;
    }
  }

  const lastTs = session.events.length > 0
    ? session.events[session.events.length - 1].ts
    : session.started_at;
  const durationMs = new Date(lastTs).getTime() - new Date(session.started_at).getTime();
  const ttfe = session.first_edit_at
    ? formatDuration(new Date(session.first_edit_at).getTime() - new Date(session.started_at).getTime())
    : 'n/a';

  return {
    briefCalls,
    grepCalls, grepAfterBrief, grepBlocked,
    globCalls, globAfterBrief, globBlocked,
    readCalls,
    editWriteCalls,
    blockedTotal: session.events.filter((e) => e.blocked).length,
    totalCalls: session.events.length,
    durationMs,
    ttfe,
  };
}

function grepDetailSuffix(after: number, blocked: number): string {
  return ` (${after} after-brief, ${blocked} blocked)`;
}

function formatSessionReport(session: SessionFile): string {
  const s = computeSessionStats(session);
  const lines: string[] = [];
  lines.push(`NCA Session Report — ${session.started_at}`);
  lines.push(`Repo: ${session.repo}  ·  Mode: ${session.mode}  ·  Duration: ${formatDuration(s.durationMs)}`);
  lines.push('');
  lines.push('Tool usage:');
  lines.push(`  nca brief        ${s.briefCalls} calls`);
  lines.push(`  Grep             ${s.grepCalls} calls${grepDetailSuffix(s.grepAfterBrief, s.grepBlocked)}`);
  lines.push(`  Glob             ${s.globCalls} calls${grepDetailSuffix(s.globAfterBrief, s.globBlocked)}`);
  lines.push(`  Read             ${s.readCalls} calls`);
  lines.push(`  Edit/Write       ${s.editWriteCalls} calls`);
  lines.push('');
  lines.push('Behavior:');
  lines.push(`  Time-to-first-edit: ${s.ttfe}`);
  lines.push(`  Files read before first edit: ${session.files_read_before_first_edit}`);
  lines.push(`  Reverts detected: ${session.reverts_detected}`);
  return lines.join('\n');
}

function sessionReportJSON(session: SessionFile): object {
  const s = computeSessionStats(session);
  return {
    session_id: session.session_id,
    repo: session.repo,
    mode: session.mode,
    started_at: session.started_at,
    duration_ms: s.durationMs,
    tool_usage: {
      nca_brief: s.briefCalls,
      grep: { calls: s.grepCalls, after_brief: s.grepAfterBrief, blocked: s.grepBlocked },
      glob: { calls: s.globCalls, after_brief: s.globAfterBrief, blocked: s.globBlocked },
      read: s.readCalls,
      edit_write: s.editWriteCalls,
    },
    behavior: {
      time_to_first_edit: s.ttfe,
      files_read_before_first_edit: session.files_read_before_first_edit,
      reverts_detected: session.reverts_detected,
    },
  };
}

const sessionCmd = program.command('session').description('Session log analysis commands');

sessionCmd
  .command('report [session_id]')
  .description('Report tool usage for a logged session (defaults to the most recent)')
  .option('--all', 'summarize all sessions in this repo')
  .option('--json', 'output as JSON')
  .action((sessionId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
    const cwd = process.cwd();

    if (opts.all) {
      const sessions = listSessions(cwd)
        .map((s) => readSession(cwd, s.id))
        .filter((s): s is SessionFile => s !== null);
      if (opts.json) {
        process.stdout.write(JSON.stringify(sessions.map(sessionReportJSON), null, 2) + '\n');
        return;
      }
      if (sessions.length === 0) {
        process.stdout.write('No sessions found in this repo.\n');
        return;
      }
      process.stdout.write(`NCA Sessions — ${sessions[0].repo}\n`);
      for (const session of sessions) {
        const s = computeSessionStats(session);
        process.stdout.write(
          `  ${session.session_id}  mode=${session.mode}  ${formatDuration(s.durationMs)}  ` +
          `briefs:${s.briefCalls} grep:${s.grepCalls} glob:${s.globCalls} read:${s.readCalls} edits:${s.editWriteCalls}\n`
        );
      }
      return;
    }

    let id = sessionId;
    if (!id) {
      const sessions = listSessions(cwd);
      if (sessions.length === 0) {
        process.stderr.write('No sessions found in this repo.\n');
        process.exit(1);
      }
      id = sessions[0].id;
    }

    const session = readSession(cwd, id);
    if (!session) {
      process.stderr.write(`Session not found: ${id}\n`);
      process.exit(1);
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(sessionReportJSON(session), null, 2) + '\n');
    } else {
      process.stdout.write(formatSessionReport(session) + '\n');
    }
  });

program.parse(process.argv);
