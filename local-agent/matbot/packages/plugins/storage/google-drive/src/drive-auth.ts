// Browser OAuth for Google Drive via Google Identity Services (GIS).
//
// We use the GIS *token* model (OAuth 2.0 implicit/PKCE for SPAs): the only configuration a
// deployment needs is a public OAuth **client ID** (not a secret — it is embedded in every web
// client and scoped to an authorised JavaScript origin in the Google Cloud console). There is no
// client secret, no server, and no refresh token: GIS hands back a short-lived (~1h) access token
// and we silently re-request it (prompt: '') whenever it expires, which works as long as the user's
// Google session and prior consent are intact. The first request shows Google's account/consent
// popup; subsequent ones are invisible.
//
// CORS: the Drive REST + upload endpoints accept cross-origin requests bearing an `Authorization:
// Bearer` header, so the token is all the DriveClient needs. The bundle MUST be served from an
// http(s) origin registered with the client ID — OAuth refuses a `file://` origin.

const GSI_SRC = 'https://accounts.google.com/gsi/client';

// Persist the live token so a realm reload inside the token's lifetime skips a fresh popup.
const TOKEN_CACHE_KEY = 'matbot.gdrive.token';

/**
 * The OAuth token response Google Identity Services passes to the token client
 * callback. All fields are optional; an absent `access_token` or a present
 * `error` signals a failed request.
 */
interface TokenResponse {
  access_token?: string;
  expires_in?:   number;
  error?:        string;
}

/**
 * A GIS token client: requests an access token and receives the response
 * through its single `callback` slot (hence one client per in-flight request).
 */
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
  callback: (resp: TokenResponse) => void;
}

/** The subset of `google.accounts.oauth2` this plugin uses. */
interface GisOAuth2 {
  initTokenClient(cfg: {
    client_id:       string;
    scope:           string;
    prompt?:         string;
    callback:        (resp: TokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }): TokenClient;
}

/** Ambient shape of the GIS global, probed before and after the script loads. */
type GisGlobal = { google?: { accounts?: { oauth2?: GisOAuth2 } } };

let gsiLoad: Promise<GisOAuth2> | undefined;

// The resolved GIS API, kept module-level so a click handler can reach it *synchronously*
// (initTokenClient + requestAccessToken are both sync; only the script load is async, and that is
// done ahead of the gesture via preloadGsi()).
let gsiReady: GisOAuth2 | undefined;

/**
 * Injects the GIS client script once and resolves when `google.accounts.oauth2`
 * is available. Memoised module-wide: later calls reuse the same promise.
 * @returns The resolved GIS OAuth2 API.
 * @throws Error when the script fails to load, or loads without exposing
 *   `google.accounts.oauth2`.
 */
function loadGsi(): Promise<GisOAuth2> {
  if (gsiLoad !== undefined) return gsiLoad;
  gsiLoad = new Promise<GisOAuth2>((resolve, reject) => {
    /**
     * Stamps the module-level `gsiReady` cache and resolves the load promise.
     * @param oauth2 - The resolved GIS OAuth2 API.
     * @returns Nothing.
     * @throws Never.
     */
    const ready = (oauth2: GisOAuth2) => { gsiReady = oauth2; resolve(oauth2); };
    const existing = (globalThis as GisGlobal).google?.accounts?.oauth2;
    if (existing !== undefined) { ready(existing); return; }

    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const oauth2 = (globalThis as GisGlobal).google?.accounts?.oauth2;
      if (oauth2 === undefined) reject(new Error('GIS loaded but google.accounts.oauth2 is unavailable'));
      else ready(oauth2);
    };
    script.onerror = () => reject(new Error(`Failed to load Google Identity Services from ${GSI_SRC}`));
    document.head.appendChild(script);
  });
  return gsiLoad;
}

/**
 * Loads the GIS script ahead of any user gesture (call when the connect UI
 * mounts) so later token requests are instant.
 * @returns Resolves once the GIS client is available; rejects if the script
 *   fails to load (callers decide whether that is fatal).
 */
export function preloadGsi(): Promise<void> {
  return loadGsi().then(() => {});
}

/**
 * Reads the persisted token from `localStorage`, tolerating an unavailable
 * store or a corrupted payload.
 * @returns The cached token with its absolute expiry (epoch ms), or undefined
 *   when absent or malformed.
 * @throws Never.
 */
function loadCachedToken(): { token: string; expiresAt: number } | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_CACHE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { token: string; expiresAt: number };
    return typeof v.token === 'string' && typeof v.expiresAt === 'number' ? v : undefined;
  } catch { return undefined; }
}

/**
 * Browser-side Google Drive OAuth via Google Identity Services, with a
 * `localStorage` token cache and expiry tracking. One instance per backend;
 * {@link DriveAuth.token} is the single read path the DriveClient calls, and
 * {@link DriveAuth.invalidate} is what a 401 handler calls to force the next
 * `token()` to re-request.
 */
export class DriveAuth {
  private readonly clientId: string;
  private readonly scope:    string;
  private accessToken: string | undefined;
  private expiresAt = 0;            // epoch ms; 0 ⇒ no token
  private pending:   Promise<string> | undefined;

  /**
   * Creates the auth helper and seeds it from the persisted token cache, so a
   * reload within the token's lifetime can skip the consent popup.
   * @param clientId - Public OAuth client ID (no secret; browser token model).
   * @param scope - OAuth scope string to request.
   * @throws Never.
   */
  constructor(clientId: string, scope: string) {
    this.clientId = clientId;
    this.scope    = scope;
    const cached = loadCachedToken();
    if (cached !== undefined) { this.accessToken = cached.token; this.expiresAt = cached.expiresAt; }
  }

  /**
   * Whether a cached token exists that is still within its validity window —
   * i.e. Drive is reachable with no popup. A 30s skew guard keeps us from
   * handing out a token that would die mid-request.
   * @returns True when a fresh cached token is available.
   * @throws Never.
   */
  hasFreshToken(): boolean {
    // 30s skew guard so we don't hand out a token that dies mid-request.
    return this.accessToken !== undefined && Date.now() < this.expiresAt - 30_000;
  }

  /**
   * Open the Google consent/account popup and resolve with the token. **Must be called from within a
   * user gesture (a click), after `preloadGsi()` has resolved.** It opens the popup synchronously
   * (no `await` before `requestAccessToken`) so the gesture's transient activation is still live —
   * Chrome blocks a popup opened after an await. Throws if the GIS script hasn't preloaded yet.
   * @returns Resolves with the access token once Google responds.
   * @throws Error when called before {@link preloadGsi} has resolved; the
   *   returned promise rejects when Google authorisation fails.
   */
  requestInteractive(): Promise<string> {
    if (gsiReady === undefined) throw new Error('preloadGsi() must resolve before requestInteractive()');
    return this.awaitToken(gsiReady, '');
  }

  /**
   * Returns a valid access token for non-interactive callers (the
   * {@link DriveClient}). Serves the cached token when fresh; otherwise
   * attempts a silent renewal (empty prompt), coalescing concurrent callers
   * onto one in-flight request. Renewal may surface a popup if the Google
   * session has lapsed; that path is best-effort (a 401 mid-session is rare)
   * and the user can always re-run the setup flow, which re-authorises from a
   * real gesture.
   * @returns A valid access token.
   * @throws Error when no interactive consent is possible or the request
   *   fails.
   */
  async token(): Promise<string> {
    if (this.hasFreshToken()) return this.accessToken!;
    if (this.pending !== undefined) return this.pending;
    this.pending = (async () => {
      const oauth2 = await loadGsi();
      return this.awaitToken(oauth2, '');
    })();
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }

  /**
   * Drops the current token (e.g. after a 401) so the next `token()`
   * re-requests. Cache removal from `localStorage` is best effort.
   * @returns Nothing.
   * @throws Never.
   */
  invalidate(): void {
    this.accessToken = undefined;
    this.expiresAt = 0;
    try { globalThis.localStorage?.removeItem(TOKEN_CACHE_KEY); } catch { /* unavailable */ }
  }

  /**
   * Runs one GIS token request and resolves with the token. A fresh
   * {@link TokenClient} is created per request: GIS routes the response through
   * the client's single callback slot, so reusing one client across overlapping
   * awaits lets the second `callback =` clobber the first and wedge it forever.
   * An empty `prompt` is silent when a prior grant and live session allow it,
   * otherwise GIS shows the popup.
   * @param oauth2 - The loaded GIS OAuth2 API.
   * @param prompt - GIS prompt parameter ('' for silent-if-possible).
   * @returns The access token; also refreshes the in-memory and `localStorage`
   *   caches on success.
   * @throws Error when Google reports an error or returns no `access_token`.
   */
  private awaitToken(oauth2: GisOAuth2, prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope:     this.scope,
        callback: (resp: TokenResponse) => {
          if (resp.error !== undefined || resp.access_token === undefined) {
            reject(new Error(`Google authorisation failed: ${resp.error ?? 'no access_token returned'}`));
            return;
          }
          this.accessToken = resp.access_token;
          this.expiresAt   = Date.now() + (resp.expires_in ?? 3600) * 1000;
          try {
            globalThis.localStorage?.setItem(
              TOKEN_CACHE_KEY,
              JSON.stringify({ token: this.accessToken, expiresAt: this.expiresAt }),
            );
          } catch { /* unavailable */ }
          resolve(resp.access_token);
        },
      });
      // Empty prompt: silent if a prior grant + live session allow it, otherwise GIS shows the popup.
      client.requestAccessToken({ prompt });
    });
  }
}
