/**
 * NCA_MODE central reader
 *
 * Determines whether NCA context compiler hooks are active.
 * - Reads process.env.NCA_MODE
 * - Default 'on' (undefined, empty, or any value except literal 'off')
 * - Only the value 'off' (case-insensitive) returns 'off'
 */

export function getMode(): 'on' | 'off' {
  const modeEnv = process.env.NCA_MODE ?? '';

  // Only exact match 'off' (case-insensitive) returns 'off'
  if (modeEnv.toLowerCase() === 'off') {
    return 'off';
  }

  // Everything else defaults to 'on'
  return 'on';
}
