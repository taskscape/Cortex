// High-precision shapes. A match withholds the whole file: these effectively never appear by accident,
// so the conservative behaviour is right for them.
const FILE_LEVEL_SECRETS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "api-key-literal", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
];

// Lower precision: an assignment whose *name* suggests a credential. The name alone says nothing —
// `password: string` in an interface and `apiKey: "REPLACE_ME"` in a sample both match — so the value
// has to look like a real secret before anything is withheld, and only the value is removed.
const ASSIGNED_SECRET = /([\w.$-]*(?:password|passwd|api[_-]?key|secret|token|credential)[\w.$-]*)(\s*[:=]\s*)(["']?)([^"'\s,;]+)\3/gi;

// Values that are obviously stand-ins rather than credentials.
const PLACEHOLDER = /^(?:replace[_-]?me|change[_-]?me|your[_-]?.*|x{3,}|todo|none|null|nil|undefined|example|sample|test|dummy|string|number|boolean|<.*>|\$\{.*\}|\{\{.*\}\}|%\w+%)$/i;

function looksLikeSecretValue(value: string): boolean {
  // Short values are types, placeholders, or prose — never credentials worth withholding.
  if (value.length < 12) return false;
  if (PLACEHOLDER.test(value)) return false;
  // Credential-shaped: one opaque run of token characters, no prose.
  return /^[A-Za-z0-9_\-./+=~]{12,}$/.test(value);
}

/**
 * Detects credential shapes so unambiguous that the whole file should be
 * withheld from the index.
 *
 * @param content - Full file text to scan.
 * @returns The matched shape's name (e.g. "api-key-literal"), or undefined if none.
 */
export function fileLevelSecret(content: string): string | undefined {
  return FILE_LEVEL_SECRETS.find(secret => secret.pattern.test(content))?.name;
}

/**
 * Replaces credential-shaped assigned values with `[redacted]`, leaving the rest of the text
 * searchable. Previously a single match dropped the entire file from the index, which read to the
 * operator as "search cannot find something I know is there", with no visible cause.
 *
 * @param text - Chunk text to redact.
 * @returns The redacted text and how many values were replaced.
 */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const redacted = text.replace(ASSIGNED_SECRET, (match, name: string, separator: string, quote: string, value: string) => {
    if (!looksLikeSecretValue(value)) return match;
    redactions++;
    return `${name}${separator}${quote}[redacted]${quote}`;
  });

  return { text: redacted, redactions };
}
