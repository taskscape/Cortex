import type { Store, Vault } from '@matatbread/matbot-core';
import { MissingSecretError, applyCreateSecret } from '@matatbread/matbot-core';

const REF_RE  = /\$\{([^}]+)\}/g;
const DOC_ID  = 'secrets';

/**
 * The persisted secrets document: a single record in the `vault` namespace
 * mapping secret names to values (plaintext).
 */
interface VaultDoc {
  id:      string;
  version: string;
  secrets: Record<string, string>;
}

/**
 * A {@link Vault} whose secrets persist as a single document in a Drive-backed `Store` (the `vault`
 * namespace of the active StorageBackend — so once the Google Drive backend is registered, secrets
 * live in Drive and follow the user across machines). Secrets are held in memory for synchronous
 * `hasKey`/`findByValue`/`resolve`; every `writeSecret` flushes the whole map back to the store.
 * Supports `${NAME}`-style reference resolution and scrubbing of secret values from free text.
 *
 * Stored in plaintext (in memory and in the Drive document), matching the
 * localStorage vault's posture — adequate for a single-user realm, not for
 * shared storage. No encryption is wired in today; WebCryptoVault exports
 * standalone AES-GCM helpers as a possible future upgrade path.
 */
export class DriveVault implements Vault {
  private readonly store: Store<VaultDoc>;
  private readonly secrets: Map<string, string>;

  /**
   * Seeds the in-memory map from a loaded document (empty when absent). Use
   * {@link DriveVault.open} instead.
   * @param store - Store backing the `secrets` document.
   * @param doc - Previously loaded document, or null for a fresh vault.
   * @throws Never.
   */
  private constructor(store: Store<VaultDoc>, doc: VaultDoc | null) {
    this.store   = store;
    this.secrets = new Map(doc ? Object.entries(doc.secrets) : []);
  }

  /**
   * Loads the secrets document from `store` and builds the vault over it.
   * @param store - Store backing the `secrets` document.
   * @returns The vault (empty when no document exists yet).
   * @throws Propagates store read errors.
   */
  static async open(store: Store<VaultDoc>): Promise<DriveVault> {
    return new DriveVault(store, await store.get(DOC_ID));
  }

  /**
   * Merges any secrets not already present (e.g. migrating the localStorage
   * vault) and persists once. Existing values are never overwritten.
   * @param secrets - Default secret values keyed by name.
   * @returns Resolves when done; nothing is written when every name already
   *   exists.
   * @throws Propagates store write errors from persisting.
   */
  async seedMissing(secrets: Record<string, string>): Promise<void> {
    let changed = false;
    for (const [k, v] of Object.entries(secrets)) {
      if (!this.secrets.has(k)) { this.secrets.set(k, v); changed = true; }
    }
    if (changed) await this.persist();
  }

  /**
   * Creates a secret via the shared vault policy (`applyCreateSecret`):
   * returns the name already holding this value when one exists, otherwise
   * writes the secret and returns `name`.
   * @param name - Desired secret name.
   * @param value - Secret value.
   * @returns The name the value is stored under.
   * @throws Propagates write errors from {@link DriveVault.writeSecret}.
   */
  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  /**
   * Sets a secret in the in-memory map and flushes the whole map to the store
   * as a fresh document version (a plain `set`, not a CAS).
   * @param name - Secret name.
   * @param value - Secret value.
   * @returns Resolves once the document is persisted.
   * @throws Propagates store write errors.
   */
  async writeSecret(name: string, value: string): Promise<void> {
    this.secrets.set(name, value);
    await this.persist();
  }

  /**
   * Whether a secret with the given name exists.
   * @param name - Secret name.
   * @returns True when present.
   */
  hasKey(name: string): boolean {
    return this.secrets.has(name);
  }

  /**
   * Reverse lookup: the secret name holding this exact value.
   * @param value - Value to search for.
   * @returns The name, or undefined when unknown.
   */
  findByValue(value: string): string | undefined {
    for (const [k, v] of this.secrets) if (v === value) return k;
    return undefined;
  }

  /**
   * Resolves a `${NAME}` reference (or a bare name) to its stored value.
   * @param ref - Reference to resolve.
   * @returns The secret value.
   * @throws When the referenced secret does not exist.
   */
  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];
    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.secrets.get(name);
      if (value === undefined) { errors.push(name); return ''; }
      return value;
    });
    if (errors.length > 0) throw new MissingSecretError(errors);
    return result;
  }

  /**
   * Replaces every stored secret value occurring in `text` with a placeholder.
   * Values shorter than 4 characters are left alone, to avoid mangling prose.
   * @param text - Text to scrub.
   * @returns Text with known secret values redacted.
   */
  scrub(text: string): string {
    let result = text;
    for (const value of this.secrets.values()) {
      if (value.length >= 4) result = result.split(value).join('[REDACTED]');
    }
    return result;
  }

  /**
   * Writes the whole in-memory map back to the store as a fresh document
   * version (a plain `set`, not a CAS).
   * @returns Resolves once the document is persisted.
   * @throws Propagates store write errors.
   */
  private async persist(): Promise<void> {
    const next: VaultDoc = {
      id:      DOC_ID,
      version: crypto.randomUUID(),
      secrets: Object.fromEntries(this.secrets),
    };
    await this.store.set(DOC_ID, next);
  }
}
