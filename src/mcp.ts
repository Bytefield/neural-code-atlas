#!/usr/bin/env node
/**
 * NCA MCP Server — stdio transport, JSON-RPC 2.0
 * Tools: nca_ask, nca_flow, nca_status, nca_evolve, nca_insights, nca_projects
 *
 * Each tool call is stateless: pass an optional `project` argument to target any
 * indexed project. Resolution priority:
 *   1. `project` arg (registry name/hint or direct path)
 *   2. NCA_DB_PATH env var
 *   3. <cwd>/.nca/nca.db autodetect
 */

import * as path from 'path';
import * as readline from 'readline';
import type { Storage } from './storage.js';
import { resolveAndGetStorage, closeAll, rootFromDbPath } from './db-cache.js';
import { listProjects } from './registry.js';
import { ContextExpander } from './context.js';
import { FlowDetector } from './flow.js';
import { Evolver } from './evolve.js';

const PROTOCOL_VERSION = '2024-11-05';
const { version: PKG_VERSION } = require('../package.json') as { version: string };
const SERVER_INFO = { name: 'nca', version: PKG_VERSION };

const PROJECT_PARAM = {
  project: {
    type: 'string',
    description: 'Project path or name hint; if omitted, uses NCA_DB_PATH or cwd autodetect.',
  },
};

const TOOLS = [
  {
    name: 'nca_ask',
    description: 'Query the Neural Code Atlas semantic index for nodes matching a search query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (function name, concept, module, etc.)' },
        ...PROJECT_PARAM,
      },
      required: ['query'],
    },
  },
  {
    name: 'nca_flow',
    description: 'Trace the execution flow starting from a named entry point using BFS.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entry point function or method name' },
        ...PROJECT_PARAM,
      },
      required: ['name'],
    },
  },
  {
    name: 'nca_status',
    description: 'Return NCA index status: file count, node count, DB size.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_PARAM },
    },
  },
  {
    name: 'nca_evolve',
    description: 'Run code evolution analysis and return architectural warnings.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_PARAM },
    },
  },
  {
    name: 'nca_insights',
    description: 'Return the top 10 most frequently queried nodes, used to surface hot code paths.',
    inputSchema: {
      type: 'object',
      properties: { ...PROJECT_PARAM },
    },
  },
  {
    name: 'nca_projects',
    description: 'List all indexed projects registered in the NCA registry.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function respond(id: number | string | null, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id: number | string | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function toolText(text: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/** Prepend a stale-index warning if the last scan was more than 7 days ago. */
function staleWarning(storage: Storage): string {
  type Row = { latest: number | null };
  const row = (storage.db as import('better-sqlite3').Database)
    .prepare('SELECT MAX(parsed_at) AS latest FROM file_index')
    .get() as Row;
  if (!row?.latest) return '';
  const ageDays = (Math.floor(Date.now() / 1000) - row.latest) / 86400;
  if (ageDays > 7) return `[WARN] Index is ${Math.floor(ageDays)} days old — run: nca scan <project>\n`;
  return '';
}

function handleInitialize(id: number | string | null): void {
  respond(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(id: number | string | null): void {
  respond(id, { tools: TOOLS });
}

function handleToolCall(id: number | string | null, name: string, args: Record<string, unknown>): void {
  try {
    const ts = Date.now();
    const projectHint = args.project ? String(args.project) : undefined;

    if (name === 'nca_projects') {
      const projects = listProjects();
      if (projects.length === 0) {
        respond(id, toolText("No indexed projects found. Run 'nca scan <path>'"));
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const lines = [`NCA|projects|t:${ts}`, '[PROJECTS]'];
      for (const p of projects) {
        const ageDays = Math.floor((nowSec - p.registeredAt) / 86400);
        const exists = p.dbExists ? 'db:ok' : 'db:missing';
        lines.push(`${p.name} | ${p.root} | ${exists} | registered:${ageDays}d ago`);
      }
      respond(id, toolText(lines.join('\n')));
      return;
    }

    const storage = resolveAndGetStorage(projectHint);
    const warning = staleWarning(storage);

    if (name === 'nca_ask') {
      const query = String(args.query ?? '');
      const ctx = new ContextExpander(storage);
      const nodes = storage.search(query);
      const matchedIds = nodes.filter(n => n.id !== undefined).map(n => n.id as number);
      storage.logQuery(query, matchedIds);
      storage.updateNodeScores(matchedIds);
      const flows = storage.getAllFlows();
      const warnings = storage.getWarnings();
      const notes = storage.searchNotes(query);
      const result = ctx.formatFull({ query, nodes, timestamp: ts }, flows, warnings, notes);
      respond(id, toolText(warning + result));
      return;
    }

    if (name === 'nca_flow') {
      const flowName = String(args.name ?? '');
      const detector = new FlowDetector(storage);
      const result = detector.detect(flowName);
      storage.upsertFlow({ name: flowName, steps: result.steps });
      const lines: string[] = [
        `NCA|flow:${flowName}|t:${ts}`,
        '[F]',
        detector.formatFlow(result),
      ];
      respond(id, toolText(warning + lines.join('\n')));
      return;
    }

    if (name === 'nca_status') {
      const stats = storage.stats();
      const lines = [
        `NCA|status|t:${ts}`,
        `files:${stats.files}|nodes:${stats.nodes}|flows:${stats.flows}|warnings:${stats.warnings}`,
        `db:${storage.dbPath}|size:${stats.dbSize}`,
      ];
      respond(id, toolText(warning + lines.join('\n')));
      return;
    }

    if (name === 'nca_evolve') {
      const root = rootFromDbPath(storage.dbPath);
      const evolver = new Evolver(storage);
      const result = evolver.analyze(root);
      respond(id, toolText(warning + result.summary));
      return;
    }

    if (name === 'nca_insights') {
      const insights = storage.topInsights();
      const lines = [`NCA|insights|t:${ts}`, '[HOT]'];
      for (const i of insights) {
        lines.push(`${i.name}|q:${i.query_count}|boost:${i.score_boost.toFixed(2)}|f:${i.file}`);
      }
      if (insights.length === 0) lines.push('(no data yet)');
      respond(id, toolText(warning + lines.join('\n')));
      return;
    }

    respondError(id, -32601, `Unknown tool: ${name}`);
  } catch (err) {
    respondError(id, -32603, `Tool execution error: ${(err as Error).message}`);
  }
}

function handleMessage(raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    handleInitialize(id);
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    respond(id, {});
    return;
  }

  if (method === 'tools/list') {
    handleToolsList(id);
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name ?? '';
    const toolArgs = params?.arguments ?? {};
    handleToolCall(id, toolName, toolArgs);
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

function main(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  });

  let buffer = '';

  rl.on('line', (line: string) => {
    buffer += line;
    try {
      handleMessage(buffer);
      buffer = '';
    } catch {
      buffer = '';
    }
  });

  rl.on('close', () => {
    closeAll();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    closeAll();
    process.exit(0);
  });
}

main();
