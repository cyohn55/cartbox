/**
 * The playtest debugger's pure parts (see DebuggerPanel.tsx): the breakpoint
 * list and the code around a stop.
 */

/** Set or clear the breakpoint on `line`; the list stays sorted. */
export function toggleBreakpoint(list: readonly number[], line: number): number[] {
  return list.includes(line) ? list.filter((l) => l !== line) : [...list, line].sort((a, b) => a - b);
}

/** The cart's lines around `line` (`radius` either side), numbered from 1. */
export function codeExcerpt(code: string, line: number, radius = 4): { line: number; text: string }[] {
  const lines = code.split("\n");
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const out: { line: number; text: string }[] = [];
  for (let l = from; l <= to; l += 1) out.push({ line: l, text: lines[l - 1] ?? "" });
  return out;
}
