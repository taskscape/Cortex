import type { Vault } from '@matatbread/matbot-core';
import { MissingSecretError, applyCreateSecret } from '@matatbread/matbot-core';

const REF_RE = /\$\{([^}]+)\}/g;

/**
 * Default vault implementation: a single flat namespace of secrets keyed by name.
 *
 * Resolves ${NAME} placeholders by looking up `NAME`. There is no env/secret distinction —
 * an env var is simply a secret whose name happens to be its env-var name. A backend may
 * privately treat some prefixes specially, but the placeholder syntax and this interface do not.
 *
 * The caller loads any backing store (e.g. a .env file) into the snapshot passed to the
 * constructor; persistence beyond the current process is a subclass concern (see EnvFileVault).
 */
export class VaultImpl implements Vault {
  private readonly store = new Map<string, string>();

  /**
   * Build a vault over an in-memory snapshot.
   *
   * @param secrets - Explicit secret values; win over env on name clash.
   * @param env - Environment-style variables, seeded for any name not already present.
   */
  constructor(
    secrets?: Record<string, string>,
    env?:     Record<string, string | undefined>,
  ) {
    if (secrets) {
      for (const [k, v] of Object.entries(secrets)) {
        this.store.set(k, v);
      }
    }
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && !this.store.has(k)) this.store.set(k, v);
      }
    }
  }

  /**
   * Store a secret under the standard `createSecret` policy (reference/dedup-aware).
   *
   * @param name - The requested key name.
   * @param value - The value to store (or a reference to an existing key).
   * @returns The key name callers must reference — possibly not `name`.
   */
  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  /**
   * Store `value` under exactly `name`, overwriting any previous value.
   *
   * @param name - The key to write.
   * @param value - The literal value to store.
   * @returns Resolves when stored.
   */
  async writeSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }

  /**
   * Whether a secret is stored under this exact name.
   *
   * @param name - The key to test.
   * @returns True when the key exists in the snapshot.
   */
  hasKey(name: string): boolean {
    return this.store.has(name);
  }

  /**
   * Reverse-index a stored value to its key name.
   *
   * @param value - The value to search for.
   * @returns The first matching key name, or `undefined` when absent.
   */
  findByValue(value: string): string | undefined {
    for (const [k, v] of this.store) if (v === value) return k;
    return undefined;
  }

  /**
   * Replace every `${NAME}` placeholder in a string with its stored value.
   *
   * @param ref - Text containing zero or more `${NAME}` placeholders.
   * @returns The text with all references resolved.
   * @throws {MissingSecretError} Listing every unresolved placeholder name.
   */
  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];

    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.store.get(name);
      if (value === undefined) { errors.push(name); return ''; }
      return value;
    });

    if (errors.length > 0) {
      throw new MissingSecretError(errors);
    }
    return result;
  }

  /**
   * Redact every stored secret value (length ≥ 4) found in a text.
   *
   * @param text - Text that may contain literal secret values.
   * @returns The text with each occurrence replaced by `[REDACTED]`.
   */
  scrub(text: string): string {
    let result = text;
    // Longest first: a shorter secret that is a substring of a longer one must not pre-redact
    // (and so mask) the longer value's occurrences.
    const values = [...this.store.values()].filter(v => v.length >= 4).sort((a, b) => b.length - a.length);
    for (const value of values) {
      result = result.split(value).join('[REDACTED]');
    }
    return result;
  }
}
