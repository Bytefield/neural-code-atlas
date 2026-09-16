import * as fs from 'fs';
import * as path from 'path';
import { OrientationEvent } from '../types.js';
import { resolveOutputPath, resolveManifestPath, resolveMetricsDir } from '../writer.js';

export function resolveInsightsDir(project: string, metricsHome?: string): string {
  return path.join(resolveMetricsDir(project, metricsHome), 'insights');
}

export interface InsightsSourceManifest {
  schema_version: string;
  cwd_filter_mode?: string;
  sessions_included?: number;
}

export interface LoadedInsightsCorpus {
  events: OrientationEvent[];
  jsonlPath: string;
  manifestPath: string;
  manifest: InsightsSourceManifest;
}

/**
 * Reads a project's orientation-events corpus for the insights engine.
 *
 * Deliberately NOT analyzer.ts's analyze() loader: that one hard-rejects any
 * schema_version other than the current SCHEMA_VERSION (by design — it protects
 * aggregate proxy-metric reports from silently mixing extractor versions). The
 * insights engine has a different, explicit backward-compatibility contract
 * (condition 5): v2-shaped events must remain readable, degrading individual
 * rules to insufficient_evidence when a field they need (e.g. result_class) is
 * simply absent, never erroring on the schema_version value itself.
 */
export function loadEventsForInsights(project: string, metricsHome?: string, inputPath?: string): LoadedInsightsCorpus {
  const jsonlPath = inputPath ?? resolveOutputPath(project, metricsHome);
  const manifestPath = inputPath
    ? inputPath.replace(/\.jsonl$/, '.manifest.json')
    : resolveManifestPath(project, metricsHome);

  if (!fs.existsSync(jsonlPath)) {
    throw new Error(
      `Orientation events file not found: ${jsonlPath}\n` +
      `Run 'nca corpus extract --project ${project} --project-root <path> --phase baseline' first.`,
    );
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InsightsSourceManifest;

  const events: OrientationEvent[] = [];
  for (const line of fs.readFileSync(jsonlPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as OrientationEvent);
    } catch {
      // skip malformed lines — extractor writes atomically, unexpected in practice
    }
  }

  return { events, jsonlPath, manifestPath, manifest };
}
