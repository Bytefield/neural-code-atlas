import * as fs from 'fs';
import * as path from 'path';

export interface NCAEvolveConfig {
  complexityThreshold: number;
  maxParamsThreshold: number;
  maxDepsThreshold: number;
  maxChainDepth: number;
  dbPatterns: string[];
  logPatterns: string[];
  entryPointPatterns: string[];
}

export interface NCAConfig {
  evolve: NCAEvolveConfig;
}

export const defaultConfig: NCAConfig = {
  evolve: {
    complexityThreshold: 10,
    maxParamsThreshold: 7,
    maxDepsThreshold: 15,
    maxChainDepth: 6,
    dbPatterns: ['db', 'repo', 'store', 'repository', 'prisma', 'knex', 'drizzle', 'mongoose'],
    logPatterns: ['log', 'logger', 'console', 'winston', 'pino', 'bunyan'],
    entryPointPatterns: ['main', 'index', 'handler', 'controller', 'route', 'resolver', 'action'],
  },
};

export function loadEvolveConfig(rootPath?: string): NCAEvolveConfig {
  const base = rootPath ?? process.cwd();
  const configPath = path.join(base, '.nca', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { evolve?: Partial<NCAEvolveConfig> };
    return { ...defaultConfig.evolve, ...(parsed.evolve ?? {}) };
  } catch {
    return { ...defaultConfig.evolve };
  }
}
