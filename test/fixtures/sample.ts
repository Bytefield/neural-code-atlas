import { readFileSync } from 'fs';
import { join } from 'path';

export interface Config {
  host: string;
  port: number;
  debug: boolean;
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as Config;
}

export async function fetchData(
  url: string,
  retries: number = 3,
  timeout: number = 5000
): Promise<{ data: unknown; status: number }> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (res.ok) {
        return { data: await res.json(), status: res.status };
      }
      if (res.status >= 500 && i < retries - 1) continue;
      return { data: null, status: res.status };
    } catch (err) {
      if (i === retries - 1) throw err;
    }
  }
  throw new Error('fetchData: exhausted retries');
}

export class DataProcessor {
  private config: Config;
  private cache: Map<string, unknown> = new Map();

  constructor(config: Config) {
    this.config = config;
  }

  process(key: string, value: unknown): unknown {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    const result = this.transform(value);
    this.cache.set(key, result);
    return result;
  }

  private transform(value: unknown): unknown {
    if (typeof value === 'string') return value.trim().toLowerCase();
    if (Array.isArray(value)) return value.map(v => this.transform(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.transform(v)])
      );
    }
    return value;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const processItem = (item: string): string => {
  if (!item) return '';
  return item.replace(/\s+/g, '_').toLowerCase();
};
