const TRAILING_COMMA = /,\s*(\]|\})/g;

function endOfLineComment(input: string, start: number): number {
  const eol = input.indexOf('\n', start + 2);
  return eol === -1 ? input.length : eol;
}

function endOfBlockComment(input: string, start: number): number {
  const close = input.indexOf('*/', start + 2);
  return close === -1 ? input.length : close + 2;
}

function endOfString(input: string, start: number): number {
  const quote = input[start];
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i++;
    if (ch === quote) break;
  }
  return i;
}

function nextSegment(input: string, i: number): { text: string; end: number } {
  const ch = input[i]!;
  const pair = ch + (input[i + 1] ?? '');
  if (pair === '//') return { text: '', end: endOfLineComment(input, i) };
  if (pair === '/*') return { text: '', end: endOfBlockComment(input, i) };
  if (ch === '"' || ch === "'") {
    const end = endOfString(input, i);
    return { text: input.slice(i, end), end };
  }
  return { text: ch, end: i + 1 };
}

export function stripJsonc(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const segment = nextSegment(input, i);
    out += segment.text;
    i = segment.end;
  }
  return out.replace(TRAILING_COMMA, '$1');
}
