import * as path from 'path';
import * as fs from 'fs';
import { Storage, NCNode } from './storage.js';

const SUPPORTED_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'];

/**
 * Write-path component. Resolves import paths to known node names and persists
 * updated deps to the database. Graph reads are handled by GraphSnapshot.
 */
export class Linker {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * For each node, resolve its deps (imports + function calls) to known node names.
   * Updates deps field in place (in the DB) where resolution succeeds.
   */
  link(rootPath: string): void {
    const all = this.storage.getAllNodes();
    const nodesByName = new Map<string, NCNode>();
    const nodesByModule = new Map<string, NCNode[]>();

    for (const n of all) {
      nodesByName.set(n.name, n);
      const list = nodesByModule.get(n.module) ?? [];
      list.push(n);
      nodesByModule.set(n.module, list);
    }

    const updates: NCNode[] = [];

    for (const node of all) {
      const resolvedDeps: string[] = [];

      for (const dep of node.deps) {
        // Already a known node name?
        if (nodesByName.has(dep)) {
          resolvedDeps.push(dep);
          continue;
        }

        // Try resolving as a relative import path
        if (dep.startsWith('.')) {
          const resolved = resolveRelativeImport(node.file, dep, rootPath);
          if (resolved) {
            const moduleName = resolved;
            const modulNodes = nodesByModule.get(moduleName) ?? [];
            for (const mn of modulNodes) resolvedDeps.push(mn.name);
            continue;
          }
        }

        // External package import — keep as-is but log
        if (!dep.startsWith('.') && !dep.startsWith('/')) {
          resolvedDeps.push(dep);
        } else {
          process.stderr.write(`NCA|unresolved|${dep}\n`);
        }
      }

      if (JSON.stringify(resolvedDeps) !== JSON.stringify(node.deps)) {
        updates.push({ ...node, deps: resolvedDeps });
      }
    }

    if (updates.length > 0) {
      this.storage.upsertNodes(updates);
    }
  }
}

function resolveRelativeImport(fromFile: string, importPath: string, rootPath: string): string | null {
  const dir = path.dirname(fromFile);
  // Strip known source extensions from TypeScript ESM-style imports (e.g. './foo.js' → './foo')
  const stripped = importPath.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const base = path.resolve(dir, stripped);

  // Try with each extension
  for (const ext of SUPPORTED_EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(rootPath, candidate).replace(/\.[^.]+$/, '').replace(/\\/g, '/');
    }
  }

  // Try index file
  for (const ext of SUPPORTED_EXTS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate)) {
      return path.relative(rootPath, candidate).replace(/\.[^.]+$/, '').replace(/\\/g, '/');
    }
  }

  return null;
}
