import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Raw JSONL types ──────────────────────────────────────────────────────────

export interface RawTextBlock {
  type: 'text';
  text: string;
}

export interface RawToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface RawToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export type RawContentBlock =
  | RawTextBlock
  | RawToolUseBlock
  | RawToolResultBlock
  | { type: string; [key: string]: unknown };

export interface RawMessage {
  role?: string;
  content?: RawContentBlock[] | string;
}

// Corpus line from Claude Code JSONL.
// Field presence verified against real corpus (2026-06-26).
// Relevant types: attachment, user, assistant, system, ai-title, mode, etc.
// gitBranch and isSidechain appear in: attachment, user, assistant, system.
export interface RawLine {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  gitBranch?: string;
  message?: RawMessage;
  [key: string]: unknown;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface ParsedSession {
  sessionId: string;
  filename: string;
  isAgentPrefixed: boolean;
  lines: RawLine[];
  hasSidechainTrue: boolean; // any event in session has isSidechain===true
  sessionGitBranch: string | null; // from first event that carries gitBranch
  cwdValues: string[];
  realEventCount: number; // user + assistant events with timestamps
  parentSessionId?: string; // set only for nested sessions (<parentId>/subagents/*.jsonl)
}

// ─── Corpus resolution ────────────────────────────────────────────────────────

export function resolveCorpusDir(slug: string, metricsHome?: string): string {
  const home = metricsHome ?? os.homedir();
  return path.join(home, '.claude', 'projects', slug);
}

// ─── Session reader ───────────────────────────────────────────────────────────

export function parseSessionFile(jsonlPath: string): {
  lines: RawLine[];
  hasSidechainTrue: boolean;
  sessionGitBranch: string | null;
  cwdValues: string[];
  realEventCount: number;
} {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const rawLines = content.split('\n');
  const lines: RawLine[] = [];
  let hasSidechainTrue = false;
  let sessionGitBranch: string | null = null;
  const cwdSet = new Set<string>();
  let realEventCount = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawLine;
      lines.push(parsed);

      if (parsed.isSidechain === true) hasSidechainTrue = true;

      if (parsed.gitBranch && typeof parsed.gitBranch === 'string' && !sessionGitBranch) {
        sessionGitBranch = parsed.gitBranch;
      }

      if (parsed.cwd && typeof parsed.cwd === 'string') cwdSet.add(parsed.cwd);

      if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.timestamp) {
        realEventCount++;
      }
    } catch {
      // Corrupted line — skip without aborting the session
    }
  }

  return { lines, hasSidechainTrue, sessionGitBranch, cwdValues: [...cwdSet], realEventCount };
}

export function readAllSessions(corpusDir: string): ParsedSession[] {
  if (!fs.existsSync(corpusDir)) return [];

  const entries = fs.readdirSync(corpusDir);
  const sessions: ParsedSession[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.slice(0, -'.jsonl'.length);
    const isAgentPrefixed = sessionId.startsWith('agent-');
    const fullPath = path.join(corpusDir, entry);

    try {
      const parsed = parseSessionFile(fullPath);
      sessions.push({
        sessionId,
        filename: entry,
        isAgentPrefixed,
        ...parsed,
      });
    } catch {
      // Unreadable session file — skip
    }
  }

  return sessions;
}

// Nested discovery (opt-in). Exactly one shape: <corpusDir>/<parentId>/subagents/*.jsonl.
// Nothing else is recursed. Session id = file stem; parentSessionId = directory name.
export function readNestedSessions(corpusDir: string): ParsedSession[] {
  if (!fs.existsSync(corpusDir)) return [];

  const sessions: ParsedSession[] = [];
  const parentDirs = fs.readdirSync(corpusDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const parentId of parentDirs) {
    const subDir = path.join(corpusDir, parentId, 'subagents');
    if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) continue;

    const files = fs.readdirSync(subDir, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => f.name)
      .sort();

    for (const entry of files) {
      const sessionId = entry.slice(0, -'.jsonl'.length);
      try {
        const parsed = parseSessionFile(path.join(subDir, entry));
        sessions.push({
          sessionId,
          filename: entry,
          isAgentPrefixed: sessionId.startsWith('agent-'),
          parentSessionId: parentId,
          ...parsed,
        });
      } catch {
        // Unreadable nested file — skip
      }
    }
  }

  return sessions;
}
