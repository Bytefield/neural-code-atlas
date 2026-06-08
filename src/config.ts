import * as fs from 'fs';
import * as path from 'path';

// ─── types ────────────────────────────────────────────────────────────────────

export interface DocSource {
  type: string;
  path: string;
  label?: string;
}

export interface NcaProjectConfig {
  version?: number;
  docSources?: DocSource[];
}

// ─── readers ──────────────────────────────────────────────────────────────────

/**
 * Read docSources from .nca/config.local.json, falling back to .nca/config.json.
 * Returns [] if neither file exists or neither has a valid docSources array.
 * Never throws.
 */
export function readDocSources(repoRoot: string): DocSource[] {
  const candidates = [
    path.join(repoRoot, '.nca', 'config.local.json'),
    path.join(repoRoot, '.nca', 'config.json'),
  ];

  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as NcaProjectConfig;
      if (Array.isArray(parsed.docSources)) {
        return parsed.docSources;
      }
    } catch {
      // file missing or not valid JSON — try next
    }
  }

  return [];
}

// ─── vault resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the vaultRoot for brief generation using this precedence:
 *
 *   1. explicitRoot (passed via --root flag) — highest precedence
 *   2. First external docSource in .nca/config.local.json
 *   3. First external docSource in .nca/config.json
 *   4. undefined (brief operates on symbols only)
 *
 * "external" means docSource.type === "external".
 */
export function resolveVaultRoot(repoRoot: string, explicitRoot?: string): string | undefined {
  // 1. --root flag wins
  if (explicitRoot !== undefined) {
    return explicitRoot;
  }

  // 2 & 3. Check config files for external sources
  const sources = readDocSources(repoRoot);
  const external = sources.find(s => s.type === 'external' && typeof s.path === 'string');
  if (external) {
    return external.path;
  }

  // 4. No vault available
  return undefined;
}
