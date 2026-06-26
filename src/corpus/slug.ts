/**
 * Resolves a project path to its Claude Code corpus slug.
 * Verified algorithm: all non-alphanumeric characters → '-'
 * Examples:
 *   /mnt/c/dev/synio  → -mnt-c-dev-synio
 *   C:\dev\synio      → C--dev-synio
 */
export function resolveProjectSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}
