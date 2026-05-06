/**
 * ANSI color codes for terminal output.
 * Use sparingly and consistently across all CLI commands.
 */

export const colors = {
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
} as const;

/**
 * Format a label: value pair with consistent styling.
 * Label in cyan, value in default terminal colour.
 */
export function formatField(label: string, value: string | number, padding = 15): string {
  const paddedLabel = (label + ':').padEnd(padding);
  return `${colors.cyan}${paddedLabel}${colors.reset}${value}`;
}

/**
 * Format test results with colour-coded pass/fail.
 */
export function formatTests(pass: number, fail: number): string {
  const passStr = `${pass} ${colors.green}pass${colors.reset}`;
  const failStr = fail > 0
    ? ` / ${fail} ${colors.yellow}fail${colors.reset}`
    : '';
  return passStr + failStr;
}

/**
 * Format a separator line in cyan.
 */
export function separator(char = '━', width = 60): string {
  return colors.cyan + char.repeat(width) + colors.reset;
}

/**
 * Format a section header in cyan bold.
 */
export function header(text: string): string {
  return `${colors.cyan}${colors.bold}${text}${colors.reset}`;
}

/**
 * Format a machine-readable tag line in gray.
 * Keeps pipe-separated identifiers present for test assertions
 * whilst visually de-emphasising them in the terminal.
 */
export function formatStatus(status: string): string {
  return colors.gray + status + colors.reset;
}
