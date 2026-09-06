/**
 * Minimal YAML parser for matbot config files.
 *
 * Supports:
 *   - Nested block mappings (key: value / key: followed by indented block)
 *   - Block sequences (- item)
 *   - Scalar types: string, number, boolean, null
 *   - Quoted strings (single and double)
 *   - Comments (# ...), ignored inside quoted scalars
 *   - Sequences of mappings (- name: x)
 *
 * Does NOT support anchors, aliases, flow syntax, or ${NAME} expansion.
 * ${NAME} placeholders are left intact for the Vault to resolve.
 * Supports literal block scalars (|) and folded block scalars (>), with
 * clip/strip/keep chomping indicators. Explicit-indentation digits are accepted
 * but indentation is always inferred from the first content line. Because the
 * tokenizer drops blank lines before block collection, `|+` cannot preserve
 * trailing blank lines beyond the final newline.
 */

type YamlScalar = string | number | boolean | null;
/** Any value representable in the supported YAML subset: scalars, sequences, or mappings. */
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
/** A string-keyed mapping of {@link YamlValue} — the top-level shape of a parsed YAML document. */
export type YamlMap   = { [key: string]: YamlValue };

/**
 * One significant source line: its indentation width and the trimmed remainder after comment
 * stripping. Blank lines are dropped by {@link tokenize}.
 */
interface Token {
  indent: number;
  raw:    string;
}

/**
 * Remove a trailing `#` comment from a line, honouring quoting so a `#` inside single- or
 * double-quoted scalars survives.
 *
 * @param line - The raw source line.
 * @returns The line up to the first unquoted `#` (or the whole line when none).
 * @throws Never.
 */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (quote === '"') {
        if (ch === '\\') i++;
        else if (ch === '"') quote = undefined;
      } else if (ch === "'") {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Split YAML source into significant tokens: comment-stripped, blank lines dropped, each reduced
 * to its indentation width plus trimmed content.
 *
 * @param text - The raw YAML source text.
 * @returns One token per non-blank line, in source order.
 * @throws Never.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const line of text.split('\n')) {
    const stripped = stripComment(line).trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    tokens.push({ indent, raw: stripped.trimStart() });
  }
  return tokens;
}

/**
 * Interpret one scalar token: quoted text becomes a string (quotes stripped, no escape
 * processing), `null`/`~` become null, `true`/`false` booleans, numeric-looking text a number,
 * and anything else a plain string.
 *
 * @param raw - The trimmed scalar text.
 * @returns The parsed scalar value.
 * @throws Never.
 */
function parseScalar(raw: string): YamlScalar {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    // JSON quoting is a strict subset of YAML double-quoted scalars and gives generated
    // configuration a reliable escape format without broadening this intentionally small parser.
    try { return JSON.parse(raw) as string; }
    catch { return raw.slice(1, -1); }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true')  return true;
  if (raw === 'false') return false;

  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') return num;

  return raw;
}

/**
 * Serialize one scalar in the supported YAML subset. Strings intentionally use JSON quoting,
 * which {@link parseScalar} understands, so comment characters, quotes, and control characters
 * cannot change the surrounding configuration structure.
 */
export function serializeYamlScalar(value: string | number | boolean | null): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

/**
 * Interpret the text after a `key:` as a literal (`|`) or folded (`>`) block-scalar header,
 * including chomping indicators (`-` strip, `+` keep) and ignored explicit-indentation digits.
 *
 * @param rest - The text following the key's colon (trimmed).
 * @returns The parsed header, or `undefined` when `rest` is not a block-scalar header.
 * @throws Never.
 */
function blockScalarHeader(rest: string): { folded: boolean; chomp: 'clip' | 'strip' | 'keep' } | undefined {
  if (rest === '') return undefined;
  const style = rest[0];
  if (style !== '|' && style !== '>') return undefined;
  let digits = '';
  let chomp: 'clip' | 'strip' | 'keep' = 'clip';
  for (const c of rest.slice(1)) {
    if (c === '-') chomp = 'strip';
    else if (c === '+') chomp = 'keep';
    else if (c >= '1' && c <= '9' && digits === '') digits = c;
    else return undefined;
  }
  return { folded: style === '>', chomp };
}

/**
 * Recursively parse a block of tokens at a given indentation into a mapping, a sequence, or a
 * single scalar, consuming tokens from `pos` while they belong to the current block. May
 * re-anchor a sequence-of-mappings token in place (mutating `tokens`) so continuation lines
 * bind to the same record.
 *
 * @param tokens - The token stream (mutated in place for `- key: value` re-anchoring).
 * @param pos - Index of the first token to parse.
 * @param baseIndent - Minimum indentation that still belongs to the current block mapping.
 * @returns The parsed value and the index of the first token after the block.
 * @throws Never.
 */
function parse(tokens: Token[], pos: number, baseIndent: number): { value: YamlValue; next: number } {
  if (pos >= tokens.length) return { value: null, next: pos };

  const first = tokens[pos]!;

  if (first.raw === '-' || first.raw.startsWith('- ')) {
    const items: YamlValue[] = [];
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < first.indent) break;
      if (tok.indent === first.indent && (tok.raw === '-' || tok.raw.startsWith('- '))) {
        const itemRaw = tok.raw === '-' ? '' : tok.raw.slice(2).trim();
        if (itemRaw === '') {
          const sub = parse(tokens, i + 1, tok.indent + 2);
          items.push(sub.value);
          i = sub.next;
        } else if (itemRaw.includes(': ') || itemRaw.endsWith(':')) {
          // Re-anchor the inline mapping start past the "- " prefix and reuse the
          // block-mapping parser, so continuation lines bind to the same record.
          tokens[i] = { indent: tok.indent + 2, raw: itemRaw };
          const sub = parse(tokens, i, tok.indent + 2);
          items.push(sub.value);
          i = sub.next;
        } else {
          items.push(parseScalar(itemRaw));
          i++;
        }
      } else {
        break;
      }
    }
    return { value: items, next: i };
  }

  if (first.raw.includes(':')) {
    const map: YamlMap = {};
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < baseIndent) break;
      if (!tok.raw.includes(':')) break;

      const colonIdx = tok.raw.indexOf(':');
      const key      = tok.raw.slice(0, colonIdx).trim();
      const rest     = tok.raw.slice(colonIdx + 1).trimStart();

      const header = blockScalarHeader(rest);
      if (header !== undefined) {
        const blockIndent = tok.indent + 2;
        const lines: string[] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j]!.indent >= blockIndent) {
          const t = tokens[j]!;
          lines.push(' '.repeat(t.indent - blockIndent) + t.raw);
          j++;
        }
        const joined = header.folded ? lines.join(' ') : lines.join('\n');
        map[key] = header.chomp === 'strip'
          ? joined
          : joined + (lines.length > 0 ? '\n' : '');
        i = j;
      } else if (rest === '') {
        const sub = parse(tokens, i + 1, tok.indent + 2);
        map[key]  = sub.value;
        i         = sub.next;
      } else {
        map[key] = parseScalar(rest);
        i++;
      }
    }
    return { value: map, next: i };
  }

  return { value: parseScalar(first.raw), next: pos + 1 };
}

/**
 * Parse a YAML document (the supported subset — nested mappings, block sequences, scalars,
 * quoted strings, comments, and literal/folded block scalars) into a string-keyed map.
 *
 * @param text - The raw YAML source text.
 * @returns The parsed top-level mapping; an empty map if the document is empty or its root
 *          is not a mapping.
 */
export function parseYaml(text: string): YamlMap {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  const { value } = parse(tokens, 0, 0);
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as YamlMap
    : {};
}
