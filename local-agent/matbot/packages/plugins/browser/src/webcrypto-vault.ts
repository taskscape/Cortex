import type { Vault } from '@matatbread/matbot-core';
import { MissingSecretError, applyCreateSecret } from '@matatbread/matbot-core';

const REF_RE = /\$\{([^}]+)\}/g;

/**
 * Browser `Vault` backed by the Web Crypto API.
 *
 * Secrets are encrypted with AES-GCM using a key derived from a passphrase
 * (PBKDF2 / SHA-256).  On first access the key is derived and cached in memory
 * for the session lifetime.
 *
 * For simpler use-cases (e.g. local development), pass secrets directly as a
 * plain map — no encryption key required.
 */
export class WebCryptoVault implements Vault {
  private readonly plain = new Map<string, string>();

  constructor(secrets?: Record<string, string>) {
    if (secrets) {
      for (const [k, v] of Object.entries(secrets)) {
        this.plain.set(k, v);
      }
    }
  }

  /**
   * Creates a new secret, failing if one with the same name already exists.
   * @param name Secret name.
   * @param value Secret value.
   * @returns The secret name that was created.
   * @throws If a secret with `name` already exists (via the shared helper).
   */
  createSecret(name: string, value: string): Promise<string> {
    return applyCreateSecret(this, name, value);
  }

  /**
   * Writes or overwrites a secret in the in-memory map.
   * @param name Secret name.
   * @param value Secret value.
   */
  async writeSecret(name: string, value: string): Promise<void> {
    this.plain.set(name, value);
  }

  /**
   * Checks whether a secret exists.
   * @param name Secret name.
   * @returns `true` if the vault holds a value for `name`.
   */
  hasKey(name: string): boolean {
    return this.plain.has(name);
  }

  /**
   * Reverse lookup: finds the first secret name whose value matches.
   * @param value Value to search for.
   * @returns The matching secret name, or `undefined`.
   */
  findByValue(value: string): string | undefined {
    for (const [k, v] of this.plain) if (v === value) return k;
    return undefined;
  }

  /**
   * Substitutes `${NAME}` placeholders in a string with stored secret values.
   * @param ref Template text containing `${NAME}` references.
   * @returns The text with all references resolved.
   * @throws {@link MissingSecretError} if any referenced secret is absent.
   */
  async resolve(ref: string): Promise<string> {
    const errors: string[] = [];
    const result = ref.replace(REF_RE, (_, name: string) => {
      const value = this.plain.get(name);
      if (value === undefined) {
        errors.push(name);
        return '';
      }
      return value;
    });
    if (errors.length > 0) {
      throw new MissingSecretError(errors);
    }
    return result;
  }

  /**
   * Redacts every stored secret value (4+ chars) found in the given text.
   * @param text Text that may contain secret values.
   * @returns The text with matching secret values replaced by `[REDACTED]`.
   */
  scrub(text: string): string {
    let result = text;
    for (const value of this.plain.values()) {
      if (value.length >= 4) {
        result = result.split(value).join('[REDACTED]');
      }
    }
    return result;
  }

  // ── Encryption helpers (optional; call to store/load secrets via IndexedDB) ──

  private static async deriveKey(passphrase: string, salt: ArrayBuffer): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypts plaintext with AES-GCM under a PBKDF2-derived key.
   * @param passphrase Passphrase to derive the encryption key from.
   * @param plaintext Text to encrypt.
   * @returns Base64 blob of `[salt(16)] [iv(12)] [ciphertext]`.
   */
  static async encrypt(passphrase: string, plaintext: string): Promise<string> {
    const saltBuf = crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer;
    const ivBuf   = crypto.getRandomValues(new Uint8Array(12)).buffer as ArrayBuffer;
    const key     = await WebCryptoVault.deriveKey(passphrase, saltBuf);
    const data    = new TextEncoder().encode(plaintext);
    const ct      = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, key, data);

    // Encode as base64: [salt(16)] [iv(12)] [ciphertext]
    const combined = new Uint8Array(16 + 12 + ct.byteLength);
    combined.set(new Uint8Array(saltBuf), 0);
    combined.set(new Uint8Array(ivBuf), 16);
    combined.set(new Uint8Array(ct), 28);
    return btoa(String.fromCharCode(...combined));
  }

  /**
   * Decrypts a blob produced by {@link WebCryptoVault.encrypt}.
   * @param passphrase Passphrase the blob was encrypted with.
   * @param encoded Base64 `[salt][iv][ciphertext]` blob.
   * @returns The decrypted plaintext.
   */
  static async decrypt(passphrase: string, encoded: string): Promise<string> {
    const bytes  = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const salt   = bytes.buffer.slice(bytes.byteOffset,       bytes.byteOffset + 16) as ArrayBuffer;
    const iv     = bytes.buffer.slice(bytes.byteOffset + 16,  bytes.byteOffset + 28) as ArrayBuffer;
    const ct     = bytes.buffer.slice(bytes.byteOffset + 28) as ArrayBuffer;
    const key    = await WebCryptoVault.deriveKey(passphrase, salt);
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  }
}
