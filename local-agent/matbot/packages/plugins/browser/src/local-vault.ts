import type { Vault } from '@matatbread/matbot-core';
import { WebCryptoVault } from './webcrypto-vault.js';

const STORAGE_KEY = 'matbot.vault';

/**
 * Read the persisted secret mirror from `localStorage`.
 * @returns Name-to-secret map parsed from the stored JSON, or an empty map when storage is
 *          unavailable or the payload is corrupt.
 * @throws Never.
 */
function load(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

/**
 * A browser `Vault` whose secrets persist in `localStorage`, so an API key entered once survives a
 * realm reload. It is a thin durability layer over {@link WebCryptoVault} (which holds secrets in
 * memory and does the `${NAME}` resolution and scrubbing); every write is mirrored to storage.
 *
 * Secrets are stored in plaintext under one key — acceptable for a single-user local demonstrator,
 * not for shared machines. `WebCryptoVault`'s static AES-GCM helpers are the upgrade path.
 */
export class LocalStorageVault extends WebCryptoVault implements Vault {
  // The base keeps secrets in a private map; we keep a parallel mirror purely to persist it.
  private readonly mirror: Record<string, string>;

  /**
   * Restores previously persisted secrets into the in-memory map (and primes the mirror) so
   * keys entered in an earlier realm still resolve after a reload.
   * @throws Never.
   */
  constructor() {
    const seed = load();
    super(seed);
    this.mirror = { ...seed };
  }

  /**
   * Writes a secret to the in-memory map and mirrors it to `localStorage`.
   * @param name Secret name.
   * @param value Secret value.
   * @returns Resolves once both the in-memory map and the mirror are updated; a failing
   *          `localStorage` write leaves the secret in memory only.
   * @throws Never — storage failures (quota/unavailable) are caught and ignored.
   */
  override async writeSecret(name: string, value: string): Promise<void> {
    await super.writeSecret(name, value);
    this.mirror[name] = value;
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.mirror)); } catch { /* storage full / unavailable */ }
  }
}
