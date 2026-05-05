import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface NCNode {
  id?: number;
  type: string;
  name: string;
  module: string;
  inputs: string[];
  outputs: string[];
  deps: string[];
  effects: string[];
  complexity: number;
  file: string;
  line: number;
  sha256: string;
}

export interface NCFlow {
  id?: number;
  name: string;
  steps: string[];
}

export interface NCWarning {
  id?: number;
  rule_id: string;
  node_id: string;
  detail: string;
}

export interface FileRecord {
  id: number;
  path: string;
  mtime: number;
  sha256: string;
  parsed_at: number;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS file_index (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT    UNIQUE NOT NULL,
  mtime      INTEGER NOT NULL,
  sha256     TEXT    NOT NULL,
  parsed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  module     TEXT    NOT NULL DEFAULT '',
  inputs     TEXT    NOT NULL DEFAULT '[]',
  outputs    TEXT    NOT NULL DEFAULT '[]',
  deps       TEXT    NOT NULL DEFAULT '[]',
  effects    TEXT    NOT NULL DEFAULT '[]',
  complexity INTEGER NOT NULL DEFAULT 1,
  file       TEXT    NOT NULL,
  line       INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT    NOT NULL DEFAULT '',
  UNIQUE(name, file, line)
);

CREATE TABLE IF NOT EXISTS flows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    UNIQUE NOT NULL,
  steps      TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    TEXT    NOT NULL,
  node_id    TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, module, inputs, outputs, deps, effects, file,
  content='nodes', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, module, inputs, outputs, deps, effects, file)
  VALUES (new.id, new.name, new.module, new.inputs, new.outputs, new.deps, new.effects, new.file);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, module, inputs, outputs, deps, effects, file)
  VALUES ('delete', old.id, old.name, old.module, old.inputs, old.outputs, old.deps, old.effects, old.file);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, module, inputs, outputs, deps, effects, file)
  VALUES ('delete', old.id, old.name, old.module, old.inputs, old.outputs, old.deps, old.effects, old.file);
  INSERT INTO nodes_fts(rowid, name, module, inputs, outputs, deps, effects, file)
  VALUES (new.id, new.name, new.module, new.inputs, new.outputs, new.deps, new.effects, new.file);
END;

CREATE INDEX IF NOT EXISTS idx_nodes_file_name ON nodes(file, name);
CREATE INDEX IF NOT EXISTS idx_nodes_module    ON nodes(module);

CREATE TABLE IF NOT EXISTS query_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  query       TEXT    NOT NULL,
  matched_ids TEXT,
  ts          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS node_scores (
  cell_id      TEXT    PRIMARY KEY,
  query_count  INTEGER DEFAULT 0,
  last_queried INTEGER,
  score_boost  REAL    DEFAULT 0.0
);
`;

export class Storage {
  private db: BetterSqlite3.Database;
  private stmts!: {
    upsertNode: BetterSqlite3.Statement;
    deleteNodesForFile: BetterSqlite3.Statement;
    getNode: BetterSqlite3.Statement;
    getNodeByName: BetterSqlite3.Statement;
    getAllNodes: BetterSqlite3.Statement;
    searchNodes: BetterSqlite3.Statement;
    countNodes: BetterSqlite3.Statement;
    upsertFlow: BetterSqlite3.Statement;
    getFlow: BetterSqlite3.Statement;
    getAllFlows: BetterSqlite3.Statement;
    insertWarning: BetterSqlite3.Statement;
    clearWarnings: BetterSqlite3.Statement;
    getWarnings: BetterSqlite3.Statement;
    getFileRecord: BetterSqlite3.Statement;
    upsertFileRecord: BetterSqlite3.Statement;
    countFiles: BetterSqlite3.Statement;
    getNodesByFile: BetterSqlite3.Statement;
    getNodeDeps: BetterSqlite3.Statement;
    insertQueryLog: BetterSqlite3.Statement;
    upsertNodeScore: BetterSqlite3.Statement;
    getNodeBoost: BetterSqlite3.Statement;
    getCellChecksums: BetterSqlite3.Statement;
    topNodeScores: BetterSqlite3.Statement;
  };

  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.exec(SCHEMA);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      upsertNode: this.db.prepare(`
        INSERT INTO nodes (type, name, module, inputs, outputs, deps, effects, complexity, file, line, sha256)
        VALUES (@type, @name, @module, @inputs, @outputs, @deps, @effects, @complexity, @file, @line, @sha256)
        ON CONFLICT(name, file, line) DO UPDATE SET
          type=excluded.type, module=excluded.module, inputs=excluded.inputs,
          outputs=excluded.outputs, deps=excluded.deps, effects=excluded.effects,
          complexity=excluded.complexity, sha256=excluded.sha256
      `),
      deleteNodesForFile: this.db.prepare(`DELETE FROM nodes WHERE file = ?`),
      getNode: this.db.prepare(`SELECT * FROM nodes WHERE id = ?`),
      getNodeByName: this.db.prepare(`SELECT * FROM nodes WHERE name = ? ORDER BY id LIMIT 1`),
      getAllNodes: this.db.prepare(`SELECT * FROM nodes ORDER BY file, line`),
      searchNodes: this.db.prepare(`
        SELECT n.* FROM nodes n
        INNER JOIN nodes_fts f ON n.id = f.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY rank
        LIMIT 50
      `),
      countNodes: this.db.prepare(`SELECT COUNT(*) as count FROM nodes`),
      upsertFlow: this.db.prepare(`
        INSERT INTO flows (name, steps)
        VALUES (@name, @steps)
        ON CONFLICT(name) DO UPDATE SET steps=excluded.steps
      `),
      getFlow: this.db.prepare(`SELECT * FROM flows WHERE name = ?`),
      getAllFlows: this.db.prepare(`SELECT * FROM flows ORDER BY name`),
      insertWarning: this.db.prepare(`
        INSERT INTO warnings (rule_id, node_id, detail) VALUES (@rule_id, @node_id, @detail)
      `),
      clearWarnings: this.db.prepare(`DELETE FROM warnings`),
      getWarnings: this.db.prepare(`SELECT * FROM warnings ORDER BY rule_id`),
      getFileRecord: this.db.prepare(`SELECT * FROM file_index WHERE path = ?`),
      upsertFileRecord: this.db.prepare(`
        INSERT INTO file_index (path, mtime, sha256, parsed_at)
        VALUES (@path, @mtime, @sha256, unixepoch())
        ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, sha256=excluded.sha256, parsed_at=unixepoch()
      `),
      countFiles: this.db.prepare(`SELECT COUNT(*) as count FROM file_index`),
      getNodesByFile: this.db.prepare(`SELECT * FROM nodes WHERE file = ? ORDER BY line`),
      getNodeDeps: this.db.prepare(`SELECT * FROM nodes WHERE name IN (SELECT value FROM json_each(?))`),
      insertQueryLog: this.db.prepare(`INSERT INTO query_log(query, matched_ids, ts) VALUES(?,?,?)`),
      upsertNodeScore: this.db.prepare(`
        INSERT INTO node_scores(cell_id, query_count, last_queried, score_boost)
        VALUES(?, 1, ?, 0.1)
        ON CONFLICT(cell_id) DO UPDATE SET
          query_count = query_count + 1,
          last_queried = excluded.last_queried,
          score_boost = MIN(score_boost + 0.05, 0.5)
      `),
      getNodeBoost: this.db.prepare(`SELECT score_boost FROM node_scores WHERE cell_id = ?`),
      getCellChecksums: this.db.prepare(`SELECT name, sha256 FROM nodes WHERE file = ?`),
      topNodeScores: this.db.prepare(`
        SELECT ns.cell_id, ns.query_count, ns.score_boost, n.name, n.module, n.file
        FROM node_scores ns
        JOIN nodes n ON CAST(n.id AS TEXT) = ns.cell_id
        ORDER BY ns.query_count DESC LIMIT 10
      `),
    };
  }

  upsertNode(node: NCNode): void {
    this.stmts.upsertNode.run({
      type: node.type,
      name: node.name,
      module: node.module,
      inputs: JSON.stringify(node.inputs),
      outputs: JSON.stringify(node.outputs),
      deps: JSON.stringify(node.deps),
      effects: JSON.stringify(node.effects),
      complexity: node.complexity,
      file: node.file,
      line: node.line,
      sha256: node.sha256,
    });
  }

  upsertNodes(nodes: NCNode[]): void {
    const tx = this.db.transaction((ns: NCNode[]) => {
      for (const n of ns) this.upsertNode(n);
    });
    tx(nodes);
  }

  deleteNodesForFile(file: string): void {
    this.stmts.deleteNodesForFile.run(file);
  }

  getNode(id: number): NCNode | null {
    const row = this.stmts.getNode.get(id) as any;
    return row ? this.rowToNode(row) : null;
  }

  getNodeByName(name: string): NCNode | null {
    const row = this.stmts.getNodeByName.get(name) as any;
    return row ? this.rowToNode(row) : null;
  }

  getAllNodes(): NCNode[] {
    return (this.stmts.getAllNodes.all() as any[]).map(r => this.rowToNode(r));
  }

  getNodesByFile(file: string): NCNode[] {
    return (this.stmts.getNodesByFile.all(file) as any[]).map(r => this.rowToNode(r));
  }

  search(query: string): NCNode[] {
    try {
      const escaped = query.replace(/['"*]/g, ' ').trim();
      if (!escaped) return this.getAllNodes().slice(0, 20);
      return (this.stmts.searchNodes.all(escaped) as any[]).map(r => this.rowToNode(r));
    } catch {
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE name LIKE ? OR module LIKE ? ORDER BY id LIMIT 20`
      ).all(`%${query}%`, `%${query}%`) as any[];
      return rows.map(r => this.rowToNode(r));
    }
  }

  getNodeDepNodes(node: NCNode): NCNode[] {
    if (!node.deps.length) return [];
    const rows = this.stmts.getNodeDeps.all(JSON.stringify(node.deps)) as any[];
    return rows.map(r => this.rowToNode(r));
  }

  upsertFlow(flow: NCFlow): void {
    this.stmts.upsertFlow.run({ name: flow.name, steps: JSON.stringify(flow.steps) });
  }

  getFlow(name: string): NCFlow | null {
    const row = this.stmts.getFlow.get(name) as any;
    if (!row) return null;
    return { id: row.id, name: row.name, steps: this.parseJSON(row.steps, []) };
  }

  getAllFlows(): NCFlow[] {
    return (this.stmts.getAllFlows.all() as any[]).map(r => ({
      id: r.id, name: r.name, steps: this.parseJSON(r.steps, []),
    }));
  }

  clearWarnings(): void {
    this.stmts.clearWarnings.run();
  }

  insertWarning(w: NCWarning): void {
    this.stmts.insertWarning.run(w);
  }

  getWarnings(): NCWarning[] {
    return this.stmts.getWarnings.all() as NCWarning[];
  }

  getFileRecord(filePath: string): FileRecord | null {
    return (this.stmts.getFileRecord.get(filePath) as FileRecord) ?? null;
  }

  upsertFileRecord(filePath: string, mtime: number, sha256: string): void {
    this.stmts.upsertFileRecord.run({ path: filePath, mtime, sha256 });
  }

  deleteFileRecord(filePath: string): void {
    this.db.prepare(`DELETE FROM file_index WHERE path = ?`).run(filePath);
  }

  logQuery(query: string, matchedIds: number[]): void {
    this.stmts.insertQueryLog.run(query, JSON.stringify(matchedIds), Date.now());
  }

  updateNodeScores(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        this.stmts.upsertNodeScore.run(String(id), now);
      }
    });
    tx();
  }

  getNodeBoost(cellId: string): number {
    const row = this.stmts.getNodeBoost.get(cellId) as { score_boost: number } | undefined;
    return row?.score_boost ?? 0;
  }

  getCellChecksums(file: string): Map<string, string> {
    const rows = this.stmts.getCellChecksums.all(file) as { name: string; sha256: string }[];
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.name, r.sha256);
    return map;
  }

  deleteRemovedCells(file: string, currentNames: Set<string>): void {
    const existing = this.getNodesByFile(file);
    const toDelete = existing.filter(n => !currentNames.has(n.name));
    if (toDelete.length === 0) return;
    const del = this.db.prepare(`DELETE FROM nodes WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const n of toDelete) del.run(n.id);
    });
    tx();
  }

  topInsights(): Array<{
    cell_id: string; query_count: number; score_boost: number;
    name: string; module: string; file: string;
  }> {
    return this.stmts.topNodeScores.all() as any[];
  }

  stats(): { files: number; nodes: number; flows: number; warnings: number; dbSize: number } {
    const files = (this.stmts.countFiles.get() as any).count as number;
    const nodes = (this.stmts.countNodes.get() as any).count as number;
    const flows = (this.db.prepare(`SELECT COUNT(*) as count FROM flows`).get() as any).count as number;
    const warnings = (this.db.prepare(`SELECT COUNT(*) as count FROM warnings`).get() as any).count as number;
    let dbSize = 0;
    try { dbSize = fs.statSync(this.dbPath).size; } catch {}
    return { files, nodes, flows, warnings, dbSize };
  }

  close(): void {
    this.db.close();
  }

  static hashFile(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  private rowToNode(row: any): NCNode {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      module: row.module,
      inputs: this.parseJSON(row.inputs, []),
      outputs: this.parseJSON(row.outputs, []),
      deps: this.parseJSON(row.deps, []),
      effects: this.parseJSON(row.effects, []),
      complexity: row.complexity,
      file: row.file,
      line: row.line,
      sha256: row.sha256,
    };
  }

  private parseJSON<T>(val: string, fallback: T): T {
    try { return JSON.parse(val); } catch { return fallback; }
  }
}

export function resolveDbPath(rootPath?: string): string {
  if (process.env.NCA_DB_PATH) return process.env.NCA_DB_PATH;
  const base = rootPath ?? process.cwd();
  return path.join(base, '.nca', 'nca.db');
}

export function resolveRootPath(): string {
  if (process.env.NCA_DB_PATH) {
    const dir = path.dirname(process.env.NCA_DB_PATH);
    if (path.basename(dir) === '.nca') {
      return path.dirname(dir);
    }
  }
  return process.cwd();
}
