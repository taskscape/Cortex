import { VaultImpl } from '@matatbread/matbot-security';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
/**
 * The default node Vault implementation: an in-memory VaultImpl whose writes are persisted to
 * the .env file next to matbot.yaml, so secrets stored at runtime (via the `plugin store-key`
 * tool or CLI bootstrap) survive a restart. Reads still come from the env snapshot loaded into
 * the constructor; this only adds persistence.
 *
 * Persistence hooks the write primitive, not createSecret — so the reference and dedup paths of
 * createSecret (which never call writeSecret) never append a dead line to .env.
 */
export class EnvFileVault extends VaultImpl {
    private readonly envPath: string;
    private queue: Promise<void> = Promise.resolve();
    /**
     * Create a vault persisting to the given .env file.
     * @param envPath Path of the .env file writes are appended to (typically next to matbot.yaml).
     * @param env Initial env snapshot backing reads; defaults to an empty snapshot.
     */
    constructor(envPath: string, env?: Record<string, string | undefined>) {
        super({}, env);
        this.envPath = envPath;
    }
    /**
     * Store a secret in memory and append/update it in the .env file so it survives restarts.
     * Writes are serialized through an internal queue, and the file update is atomic
     * (temp file + rename, mode 0600): the key must be a valid dotenv identifier and the
     * value single-line; an existing line for the key is replaced.
     *
     * @param name Secret key name.
     * @param value Secret value to persist.
     * @returns Resolves when the in-memory write and the .env update complete.
     * @throws Error When the name is not a valid dotenv key, the value contains a
     *   newline, or reading/writing the .env file fails.
     * @throws NodeJS system errors (e.g. from `rename`/`rm`) when the atomic file
     *   update fails; the in-memory write is not performed in that case.
     */
    override async writeSecret(name: string, value: string): Promise<void> {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value))
            throw new Error('Dotenv secrets require a valid key and a single-line value');
        const run = this.queue.catch(() => { }).then(async () => {
            let existing = '';
            try {
                existing = await readFile(this.envPath, 'utf8');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            const lines = existing
                ? existing.split('\n').filter(l => l !== '' && !l.startsWith(`${name}=`))
                : [];
            lines.push(`${name}=${value}`);
            const temporary = this.envPath + '.tmp-' + randomUUID();
            try {
                await writeFile(temporary, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
                await rename(temporary, this.envPath);
            }
            finally {
                await rm(temporary, { force: true });
            }
            await super.writeSecret(name, value);
        });
        this.queue = run;
        await run;
    }
}
