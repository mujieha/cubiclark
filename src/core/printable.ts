// Text that is about to be printed to a terminal. Whatever was read from a transcript, a task folder
// or a configuration file may hold escape sequences (window titles, cleared lines, OSC 52), so
// every C0 and C1 control character is removed before it reaches `doctor` or `hooks status`.

import { reducePaths } from './adapters/task-log.js'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

export function printable(text: string): string {
  return text.replace(CONTROL, '')
}

/** Free text from a file (an API error message) as it may reach the page (S1-16): control
 * characters removed, paths reduced to their last segment, whitespace collapsed, capped. */
export function freeText(text: string, max: number): string {
  const clean = reducePaths(printable(text.replace(/\s+/g, ' '))).trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** One printable line per input line. */
export function printableLines(lines: readonly string[]): string {
  return lines.map(printable).join('\n')
}
