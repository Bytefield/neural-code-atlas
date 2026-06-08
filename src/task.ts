import * as fs from 'fs';
import * as path from 'path';

export interface CurrentTask {
  description: string;
  createdAt: string;
  repoRoot: string;
}

function taskFilePath(repoRoot: string): string {
  return path.join(repoRoot, '.nca', 'current-task.json');
}

export function saveTask(repoRoot: string, description: string): void {
  const ncaDir = path.join(repoRoot, '.nca');
  if (!fs.existsSync(ncaDir)) {
    fs.mkdirSync(ncaDir, { recursive: true });
  }
  const task: CurrentTask = {
    description,
    createdAt: new Date().toISOString(),
    repoRoot,
  };
  fs.writeFileSync(taskFilePath(repoRoot), JSON.stringify(task, null, 2), 'utf-8');
}

export function loadTask(repoRoot: string): CurrentTask | null {
  const filePath = taskFilePath(repoRoot);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CurrentTask;
  } catch {
    return null;
  }
}

export function clearTask(repoRoot: string): void {
  const filePath = taskFilePath(repoRoot);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore errors — file may already be gone
  }
}
