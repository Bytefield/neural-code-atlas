#!/usr/bin/env node
/**
 * NCA MCP Server — stdio transport, JSON-RPC 2.0
 * Tools: nca_ask, nca_flow, nca_status, nca_evolve, nca_insights
 */

import * as readline from 'readline';
import { Storage, resolveDbPath, resolveRootPath } from './storage.js';
import { ContextExpander } from './context.js';
import { FlowDetector } from './flow.js';
import { Evolver } from './evolve.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'nca', version: '1.0.0' };

const TOOLS = [
  {
    name: 'nca_ask',
    description: 'Query the Neural Code Atlas semantic index for nodes matching a search query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (function name, concept, module, etc.)' },
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
      },
      required: ['name'],
    },
  },
  {
    name: 'nca_status',
    description: 'Return NCA index status: file count, node count, DB size.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nca_evolve',
    description: 'Run code evolution analysis and return architectural warnings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nca_insights',
    description: 'Return the top 10 most frequently queried nodes, used to surface hot code paths.',
    inputSchema: { type: 'object', properties: {} },
  },
];

let storage: Storage | null = null;

function getStorage(): Storage {
  if (!storage) {
    storage = new Storage(resolveDbPath());
  }
  return storage;
}

function respond(id: number | string | null, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id: number | string | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
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

function toolText(text: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function handleToolCall(id: number | string | null, name: string, args: Record<string, unknown>): void {
  try {
    const db = getStorage();
    const ts = Date.now();
    if (name === 'nca_ask') {
      const query = String(args.query ?? '');
      const ctx = new ContextExpander(db);
      const nodes = db.search(query);
      const matchedIds = nodes.filter(n => n.id !== undefined).map(n => n.id as number);
      db.logQuery(query, matchedIds);
      db.updateNodeScores(matchedIds);
      const flows = db.getAllFlows();
      const warnings = db.getWarnings();
      const result = ctx.formatFull({ query, nodes, timestamp: ts }, flows, warnings);
      respond(id, toolText(result));
      return;
    }

    if (name === 'nca_flow') {
      const flowName = String(args.name ?? '');
      const detector = new FlowDetector(db);
      const result = detector.detect(flowName);
      // Always persist — covers both new flows and re-traces after re-scan
      db.upsertFlow({ name: flowName, steps: result.steps });
      const lines: string[] = [
        `NCA|flow:${flowName}|t:${ts}`,
        '[F]',
        detector.formatFlow(result),
      ];
      respond(id, toolText(lines.join('\n')));
      return;
    }

    if (name === 'nca_status') {
      const stats = db.stats();
      const lines = [
        `NCA|status|t:${ts}`,
        `files:${stats.files}|nodes:${stats.nodes}|flows:${stats.flows}|warnings:${stats.warnings}`,
        `db:${db.dbPath}|size:${stats.dbSize}`,
      ];
      respond(id, toolText(lines.join('\n')));
      return;
    }

    if (name === 'nca_evolve') {
      const evolver = new Evolver(db);
      const result = evolver.analyze(resolveRootPath());
      respond(id, toolText(result.summary));
      return;
    }

    if (name === 'nca_insights') {
      const insights = db.topInsights();
      const lines = [`NCA|insights|t:${ts}`, '[HOT]'];
      for (const i of insights) {
        lines.push(`${i.name}|q:${i.query_count}|boost:${i.score_boost.toFixed(2)}|f:${i.file}`);
      }
      if (insights.length === 0) lines.push('(no data yet)');
      respond(id, toolText(lines.join('\n')));
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
    // No response needed for notifications
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
    if (storage) storage.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    if (storage) storage.close();
    process.exit(0);
  });
}

main();
