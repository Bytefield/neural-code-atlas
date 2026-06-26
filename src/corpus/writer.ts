import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { OrientationEvent, Manifest, SCHEMA_VERSION, EXTRACTOR_VERSION } from './types.js';

// ─── Path resolution ──────────────────────────────────────────────────────────

export function resolveMetricsDir(projectName: string, metricsHome?: string): string {
  const home = metricsHome ?? os.homedir();
  return path.join(home, '.nca', 'metrics', projectName);
}

export function resolveOutputPath(projectName: string, metricsHome?: string): string {
  return path.join(resolveMetricsDir(projectName, metricsHome), 'orientation-events.jsonl');
}

export function resolveManifestPath(projectName: string, metricsHome?: string): string {
  return path.join(resolveMetricsDir(projectName, metricsHome), 'orientation-events.manifest.json');
}

// ─── Version compatibility check ─────────────────────────────────────────────

export interface VersionCheck {
  compatible: boolean;
  foundSchemaVersion?: string;
  foundExtractorVersion?: string;
}

export function checkExistingVersion(outputPath: string): VersionCheck {
  if (!fs.existsSync(outputPath)) return { compatible: true };

  try {
    const content = fs.readFileSync(outputPath, 'utf-8');
    const firstLine = content.split('\n').find(l => l.trim().length > 0);
    if (!firstLine) return { compatible: true };
    const event = JSON.parse(firstLine) as Partial<OrientationEvent>;
    return {
      compatible: event.schema_version === SCHEMA_VERSION && event.extractor_version === EXTRACTOR_VERSION,
      foundSchemaVersion: event.schema_version,
      foundExtractorVersion: event.extractor_version,
    };
  } catch {
    return { compatible: true }; // Unreadable → allow overwrite
  }
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

function sha256ofBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function writeOutput(
  events: OrientationEvent[],
  manifest: Manifest,
  projectName: string,
  metricsHome?: string,
): { outputPath: string; manifestPath: string; outputSha256: string } {
  const outDir = resolveMetricsDir(projectName, metricsHome);
  fs.mkdirSync(outDir, { recursive: true });

  const outputPath = resolveOutputPath(projectName, metricsHome);
  const manifestPath = resolveManifestPath(projectName, metricsHome);
  const tmpPath = outputPath + '.tmp';

  const content = events.length > 0
    ? events.map(e => JSON.stringify(e)).join('\n') + '\n'
    : '';
  const buf = Buffer.from(content, 'utf-8');
  const outputSha256 = sha256ofBuffer(buf);

  // Write to temp, then atomic rename — prevents partial reads on re-run
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, outputPath);

  const finalManifest: Manifest = { ...manifest, output_sha256: outputSha256 };
  fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf-8');

  return { outputPath, manifestPath, outputSha256 };
}
