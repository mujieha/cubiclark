// Text that is about to be printed to a terminal. Whatever was read from a transcript, a task folder
// or a configuration file may hold escape sequences (window titles, cleared lines, OSC 52), so
// every C0 and C1 control character is removed before it reaches `doctor` or `hooks status`.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

export function printable(text: string): string {
  return text.replace(CONTROL, '')
}

/** One printable line per input line. */
export function printableLines(lines: readonly string[]): string {
  return lines.map(printable).join('\n')
}
