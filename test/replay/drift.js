/**
 * Drift vs regression discrimination for clean_no_match replay results.
 *
 * For an in-scope clean_no_match query, extracts the identifier-shaped
 * candidate token(s) it was plausibly targeting and checks whether they exist
 * in the SYNIO source tree at the commit the frozen index was built from
 * (git grep, scoped to the directories NCA actually indexes per .ncaignore:
 * src/, tests/, prisma/, scripts/). This tells us whether a miss is because
 * the target genuinely no longer exists (drift, over ~3.5 months of synio
 * history since the May/June baseline) or because it does exist but nca_ask's
 * search still didn't surface it (a regression candidate — see run.js's
 * checkRegressionCandidates, which empirically tests these against a
 * June-era NCA build rather than guessing).
 *
 * Deterministic and git-object-store based: reads the commit's tree via
 * `git grep <commit>` / `git ls-tree <commit>`, never the live working tree,
 * so results do not depend on uncommitted changes in the synio worktree.
 */

const { execFileSync } = require('child_process');

const SCAN_DIRS = ['src', 'tests', 'prisma', 'scripts']; // matches synio's .ncaignore "keep for indexing" list

// Deliberately conservative: words common enough in these queries' natural-language
// padding that they would never be a useful candidate even if identifier-shaped.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'to', 'is', 'are',
  'with', 'from', 'that', 'this', 'other', 'outside', 'already', 'bad', 'request',
]);

function extractCandidates(query) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const candidates = [];
  const seen = new Set();

  for (const raw of tokens) {
    const tok = raw.replace(/^[.,;:()[\]{}"']+|[.,;:()[\]{}"']+$/g, '');
    if (!tok || seen.has(tok)) continue;

    const isPath = tok.includes('/') || /\.(ts|tsx|js|jsx|py|json|md|sql|env)$/.test(tok);
    const isKebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tok) && tok.length >= 6;
    const core = tok.startsWith('$') ? tok.slice(1) : tok;
    const isIdentShape = /^[A-Za-z_][A-Za-z0-9_]*$/.test(core);
    const hasInternalUpper = isIdentShape && core.length > 1 && /[A-Z]/.test(core.slice(1));
    const hasLower = /[a-z]/.test(core);
    const isCamelOrPascal = isIdentShape && hasInternalUpper && hasLower;
    const isUpperSnake = isIdentShape && core.includes('_') && core === core.toUpperCase();
    const isSnake = isIdentShape && core.includes('_') && core === core.toLowerCase();
    const isDollar = tok.startsWith('$') && isIdentShape;

    const strong = isPath || isKebab || isCamelOrPascal || isUpperSnake || isSnake || isDollar;
    if (!strong) continue;
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    if (core.length < 4) continue;

    const kind = (isPath || isKebab) ? 'path'
      : isUpperSnake ? 'upper_snake'
      : isSnake ? 'snake'
      : isDollar ? 'dollar'
      : 'camel_pascal';

    seen.add(tok);
    candidates.push({ token: tok, kind });
  }
  return candidates;
}

function gitGrepExists(synioRoot, commit, token) {
  const pathspecs = SCAN_DIRS.flatMap(d => [d, `${d}/*`]);
  try {
    const out = execFileSync('git', ['-C', synioRoot, 'grep', '-F', '-w', '-n', '-e', token, commit, '--', ...pathspecs], { encoding: 'utf-8' });
    const first = out.trim().split('\n')[0];
    return { exists: true, evidence: first };
  } catch (err) {
    if (err.status === 1) return { exists: false, evidence: null }; // git grep: no match
    return { exists: false, evidence: `git grep error: ${err.message}` };
  }
}

let treeFilesCache = null;
function listTreeFiles(synioRoot, commit) {
  if (treeFilesCache) return treeFilesCache;
  const out = execFileSync('git', ['-C', synioRoot, 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf-8' });
  treeFilesCache = out.split('\n').filter(Boolean);
  return treeFilesCache;
}

function pathExists(synioRoot, commit, token) {
  const files = listTreeFiles(synioRoot, commit);
  const match = files.find(f => f.includes(token));
  return match ? { exists: true, evidence: match } : { exists: false, evidence: null };
}

/**
 * Classify one clean_no_match query as drift / present-but-missed / undeterminable.
 */
function classifyQuery(query, synioRoot, commit) {
  const candidates = extractCandidates(query);
  if (candidates.length === 0) {
    return {
      verdict: 'undeterminable',
      reason: 'no identifier-shaped token extracted — natural-language / multi-concept query with no single symbol or path candidate',
      candidates: [],
    };
  }

  const checked = candidates.map(c => {
    const result = c.kind === 'path' ? pathExists(synioRoot, commit, c.token) : gitGrepExists(synioRoot, commit, c.token);
    return { ...c, exists: result.exists, evidence: result.evidence };
  });

  const anyExists = checked.some(c => c.exists);
  return {
    verdict: anyExists ? 'symbol_present_but_missed' : 'symbol_absent',
    reason: anyExists
      ? `at least one candidate token exists in synio@${commit.slice(0, 8)} (scoped to ${SCAN_DIRS.join('/')}) but nca_ask returned no match`
      : `none of the extracted candidate tokens exist in synio@${commit.slice(0, 8)} (scoped to ${SCAN_DIRS.join('/')}) — consistent with drift since the May/June baseline`,
    candidates: checked,
  };
}

module.exports = { extractCandidates, classifyQuery, SCAN_DIRS };
