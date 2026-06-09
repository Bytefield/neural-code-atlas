/**
 * Cheap current-branch reader for orientation telemetry. Reads .git/HEAD
 * directly (no `git` subprocess — hooks run on a sub-second budget) and resolves
 * the worktree case where .git is a file pointing at the real gitdir. Returns
 * null for a detached HEAD or any non-git / unreadable cwd. Never throws.
 */

import * as fs from 'fs';
import * as path from 'path';

export function gitBranch(cwd: string): string | null {
  try {
    const dotGit = path.join(cwd, '.git');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      return null;
    }

    let gitDir = dotGit;
    if (stat.isFile()) {
      // Worktree / submodule: ".git" is a file "gitdir: <path>".
      const m = fs.readFileSync(dotGit, 'utf-8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(cwd, m[1].trim());
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : null; // detached HEAD -> null
  } catch {
    return null;
  }
}
