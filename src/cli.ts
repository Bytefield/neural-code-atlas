#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { Storage, resolveDbPath } from './storage.js';
import { Scanner } from './scanner.js';
import { Linker } from './linker.js';
import { ContextExpander, buildQueryJSON } from './context.js';
import { FlowDetector } from './flow.js';
import { Evolver } from './evolve.js';

const program = new Command();

program
  .name('nca')
  .description('Neural Code Atlas — local semantic index for codebases')
  .version('1.0.0');

// ─── scan ────────────────────────────────────────────────────────────────────
program
  .command('scan [path]')
  .description('Scan a directory and build/update the NCA index')
  .option('-v, --verbose', 'verbose output')
  .action((scanPath: string | undefined, opts: { verbose?: boolean }) => {
    const rootPath = path.resolve(scanPath ?? process.cwd());

    if (!fs.existsSync(rootPath)) {
      process.stderr.write(`Error: path not found: ${rootPath}\n`);
      process.exit(1);
    }

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

    const stats = storage.stats();
    process.stdout.write(
      `NCA|scan_complete|files:${stats.files}|nodes:${stats.nodes}|flows:${stats.flows}|ms:${result.durationMs}\n`
    );

    storage.close();
  });

// ─── ask ─────────────────────────────────────────────────────────────────────
program
  .command('ask <query...>')
  .description('Query the NCA semantic index')
  .option('-p, --path <path>', 'project root path (defaults to cwd)')
  .option('--json', 'output structured JSON')
  .action((queryParts: string[], opts: { path?: string; json?: boolean }) => {
    const query = queryParts.join(' ');
    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);

    if (!fs.existsSync(dbPath)) {
      const msg = `NCA|error|no_index|run: nca scan ${rootPath}`;
      process.stdout.write(opts.json ? JSON.stringify({ error: msg }) + '\n' : msg + '\n');
      process.exit(1);
    }

    const storage = new Storage(dbPath);
    const ctx = new ContextExpander(storage);
    const nodes = storage.search(query);

    // Log query and update frequency-based score boosts
    const matchedIds = nodes.filter(n => n.id !== undefined).map(n => n.id as number);
    storage.logQuery(query, matchedIds);
    storage.updateNodeScores(matchedIds);

    const flows = storage.getAllFlows();
    const warnings = storage.getWarnings();
    const ts = Date.now();

    if (opts.json) {
      const json = buildQueryJSON({ query, nodes, timestamp: ts }, ctx, flows, warnings);
      process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    } else {
      const result = ctx.formatFull({ query, nodes, timestamp: ts }, flows, warnings);
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
  .action((name: string, opts: { path?: string; json?: boolean }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);

    if (!fs.existsSync(dbPath)) {
      const msg = `NCA|error|no_index|run: nca scan ${rootPath}`;
      process.stdout.write(opts.json ? JSON.stringify({ error: msg }) + '\n' : msg + '\n');
      process.exit(1);
    }

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
  .action((opts: { path?: string; json?: boolean }) => {
    const rootPath = path.resolve(opts.path ?? process.cwd());
    const dbPath = resolveDbPath(rootPath);

    if (!fs.existsSync(dbPath)) {
      const msg = `NCA|error|no_index|run: nca scan ${rootPath}`;
      process.stdout.write(opts.json ? JSON.stringify({ error: msg }) + '\n' : msg + '\n');
      process.exit(1);
    }

    const storage = new Storage(dbPath);
    const evolver = new Evolver(storage);
    const result = evolver.analyze(rootPath);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ timestamp: Date.now(), warnings: result.warnings }, null, 2) + '\n'
      );
    } else {
      process.stdout.write(result.summary + '\n');
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
      const lines = [
        `NCA|status|t:${ts}`,
        `files:${stats.files}|nodes:${stats.nodes}|flows:${stats.flows}|warnings:${stats.warnings}`,
        `db:${dbPath}|size:${stats.dbSize}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    }

    storage.close();
  });

// ─── watch ────────────────────────────────────────────────────────────────────
program
  .command('watch [path]')
  .description('Watch for file changes and auto-reindex (requires chokidar)')
  .option('-v, --verbose', 'log each reindex event')
  .action((watchPath: string | undefined, opts: { verbose?: boolean }) => {
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

    // Initial scan
    scanner.scan(rootPath);
    new Linker(storage).link(rootPath);
    new FlowDetector(storage).detectAll();
    process.stdout.write(
      `NCA|watch_ready|root:${rootPath}|nodes:${storage.stats().nodes}\n`
    );

    const DEBOUNCE_MS = 300;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChanges = new Set<string>();
    const pendingDeletes = new Set<string>();

    function flush(): void {
      const changed = [...pendingChanges];
      const deleted = [...pendingDeletes];
      pendingChanges.clear();
      pendingDeletes.clear();

      // Handle deletions
      for (const fp of deleted) {
        storage.deleteNodesForFile(fp);
        storage.deleteFileRecord(fp);
        if (opts.verbose) process.stdout.write(`NCA|watch_unlink|${fp}\n`);
      }

      // Re-index only the files that changed
      let totalParsed = 0;
      let totalMs = 0;
      for (const fp of changed) {
        const r = scanner.scanFile(fp, rootPath);
        totalParsed += r.parsed;
        totalMs += r.durationMs;
        if (opts.verbose) process.stdout.write(`NCA|watch_reindex_file|${fp}|parsed:${r.parsed}|ms:${r.durationMs}\n`);
      }

      // Relink and redetect whenever anything changed — symmetric for both changes and deletions
      if (deleted.length > 0 || changed.length > 0) {
        new Linker(storage).link(rootPath);
        new FlowDetector(storage).detectAll();
        const stats = storage.stats();
        process.stdout.write(
          `NCA|watch_reindex|files:${totalParsed}|nodes:${stats.nodes}|ms:${totalMs}\n`
        );
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
      process.stdout.write(
        `NCA|migrate_status|current:${status.currentVersion}|target:${status.targetVersion}|pending:${status.pending.length}\n`
      );
      for (const p of status.pending) {
        process.stdout.write(`NCA|migrate_pending|v${p.version}|${p.name}\n`);
      }
    } else if (opts.apply) {
      process.stdout.write(`NCA|migrate_complete\n`);
    }

    storage.close();
  });

program.parse(process.argv);
