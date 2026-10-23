
export function wordAt(line: string, column: number): { start: number; end: number } | undefined {
  if (column < 0 || column >= line.length || /\s/.test(line[column]!)) return undefined;
  let start = column;
  let end = column + 1;
  while (start > 0 && !/\s/.test(line[start - 1]!)) start--;
  while (end < line.length && !/\s/.test(line[end]!)) end++;
  const word = line.slice(start, end);
  const leading = /^[("'`[{<]+/.exec(word)?.[0].length ?? 0;
  const trailing = /[)"'`\]}>,;:.!?]+$/.exec(word)?.[0].length ?? 0;
  if (leading + trailing >= word.length) return { start, end };
  return { start: start + leading, end: end - trailing };
}
