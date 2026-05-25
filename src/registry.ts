import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RegisteredProject {
  name: string;
  root: string;
  dbPath: string;
  dbExists: boolean;
  registeredAt: number; // Unix epoch seconds
}

interface StoredProject {
  name: string;
  root: string;
  dbPath: string;
  registeredAt: number;
}

interface RegistryData {
  projects: StoredProject[];
}

function getRegistryPath(): string {
  return process.env.NCA_REGISTRY_PATH ?? path.join(os.homedir(), '.nca', 'registry.json');
}

function readRegistry(): RegistryData {
  const p = getRegistryPath();
  if (!fs.existsSync(p)) return { projects: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RegistryData;
  } catch {
    return { projects: [] };
  }
}

function writeRegistry(data: RegistryData): void {
  const p = getRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

/** Upsert a project root into the registry. No-op if already present. */
export function registerProject(root: string): void {
  const absRoot = path.resolve(root);
  const data = readRegistry();
  const existing = data.projects.find(p => p.root === absRoot);
  if (!existing) {
    data.projects.push({
      name: path.basename(absRoot),
      root: absRoot,
      dbPath: path.join(absRoot, '.nca', 'nca.db'),
      registeredAt: Math.floor(Date.now() / 1000),
    });
    writeRegistry(data);
  }
}

/** List all registered projects with a live dbExists check. */
export function listProjects(): RegisteredProject[] {
  return readRegistry().projects.map(p => ({
    ...p,
    dbExists: fs.existsSync(p.dbPath),
  }));
}

/**
 * Find a project by hint using three strategies in order:
 * 1. Exact root match (resolved absolute path)
 * 2. Exact name match (case-insensitive)
 * 3. Partial root substring match (case-insensitive)
 */
export function findProject(hint: string): RegisteredProject | undefined {
  const projects = listProjects();
  const lower = hint.toLowerCase();
  const absHint = path.resolve(hint);

  return (
    projects.find(p => p.root === absHint) ??
    projects.find(p => p.name.toLowerCase() === lower) ??
    projects.find(p => p.root.toLowerCase().includes(lower))
  );
}
