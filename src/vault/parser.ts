import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export interface ParsedNote {
  id: string;
  path: string;
  type?: string;
  status: 'vigente' | 'borrador' | 'obsoleto';
  area?: string;
  summary?: string;
  updated?: string;
  contentHash: string;
  bodyChunks: string[];
}

/**
 * Derive note ID from file path when not in frontmatter.
 * Rules: filename (no extension), lowercase, replace spaces/special chars with hyphens.
 */
function deriveId(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || '';
  const withoutExt = fileName.replace(/\.[^.]*$/, '');
  return withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compute SHA256 hash of content.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Split body into chunks (~1000 chars each) with paragraph overlap.
 * Algorithm:
 * 1. Split by double newlines to get paragraphs
 * 2. Group paragraphs sequentially until chunk > ~1000 chars
 * 3. Overlap: first paragraph of next chunk = last paragraph of previous
 * 4. If body < 1000 chars or empty, return single chunk or empty array
 */
function chunkBody(body: string): string[] {
  if (body.length === 0) {
    return [];
  }

  if (body.length < 1000) {
    return [body];
  }

  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let i = 0;

  while (i < paragraphs.length) {
    let chunk = paragraphs[i];
    let j = i + 1;

    // Accumulate paragraphs until chunk exceeds ~1000 chars
    while (j < paragraphs.length && chunk.length < 1000) {
      chunk += '\n\n' + paragraphs[j];
      j++;
    }

    chunks.push(chunk);

    // Overlap: include last paragraph of this chunk as first of next.
    // Use Math.max to guarantee forward progress when a single paragraph >= 1000 chars
    // (in that case j - 1 === i, which would loop forever without the guard).
    if (j < paragraphs.length) {
      i = Math.max(i + 1, j - 1);
    } else {
      break;
    }
  }

  return chunks;
}

export async function parseNote(filePath: string): Promise<ParsedNote> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read file: ${filePath}`);
  }

  // Normalize path to forward slashes
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Check for frontmatter
  let frontmatter: Record<string, unknown> = {};
  let body = content;

  if (content.startsWith('---')) {
    const firstNewline = content.indexOf('\n');
    if (firstNewline === -1) {
      // File is just "---", no frontmatter end marker
      body = content;
    } else {
      const afterFirst = content.substring(firstNewline + 1);
      const secondMarker = afterFirst.indexOf('---');

      if (secondMarker === -1) {
        // No closing marker, treat entire content as body
        body = content;
      } else {
        const frontmatterText = afterFirst.substring(0, secondMarker);
        body = afterFirst.substring(secondMarker + 3).replace(/^\n/, '');

        // Parse YAML frontmatter
        try {
          const parsed = parseYaml(frontmatterText);
          if (parsed && typeof parsed === 'object') {
            frontmatter = parsed;
          }
        } catch (err) {
          // Warn and continue with empty frontmatter
          process.stderr.write(`Warning: malformed YAML in ${filePath}: ${(err as Error).message}\n`);
          frontmatter = {};
        }
      }
    }
  }

  // Extract frontmatter fields
  const id = (frontmatter.id as string) || deriveId(normalizedPath);
  const type = frontmatter.type as string | undefined;
  const status = (frontmatter.status as 'vigente' | 'borrador' | 'obsoleto') || 'vigente';
  const area = frontmatter.area as string | undefined;
  const summary = frontmatter.summary as string | undefined;
  const updated = frontmatter.updated as string | undefined;

  // Hash the body (not the frontmatter)
  const contentHash = hashContent(body);

  // Chunk the body
  const bodyChunks = chunkBody(body);

  return {
    id,
    path: normalizedPath,
    type,
    status,
    area,
    summary,
    updated,
    contentHash,
    bodyChunks,
  };
}
