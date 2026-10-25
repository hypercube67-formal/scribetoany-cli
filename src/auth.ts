import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Profile, USER_AGENT, loadProfile, saveProfile } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { log } from './output.ts';

/**
 * OAuth 2.1 sign-in against ScribeToAny's MCP authorization server: dynamic
 * client registration, PKCE (S256) and a loopback redirect. The redirect URI
 * must match exactly, so every login registers a client for its own port.
 * The user approves "ScribeToAny CLI" on /auth/connect in the browser.
 */

const CLIENT_NAME = 'ScribeToAny CLI';
const SCOPE = 'openid profile email offline_access';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60 * 1000;

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const base64url = (buf: Buffer) => buf.toString('base64url');

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
    });
  } catch (error) {
    throw new CliError(
      `Can't reach ${new URL(url).origin}: ${(error as Error).message}`,
      EXIT.NETWORK,
      'NETWORK'
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text);
      detail = body.error_description || body.error || detail;
    } catch {}
    throw new CliError(
      `${new URL(url).pathname} failed (${res.status}): ${detail}`,
      res.status >= 500 ? EXIT.NETWORK : EXIT.AUTH,
      'AUTH_FAILED'
    );
  }
  return JSON.parse(text) as T;
}

const metadata = (baseUrl: string) =>
  fetchJson<ServerMetadata>(`${baseUrl}/.well-known/oauth-authorization-server`);

function tokenRequest(endpoint: string, params: Record<string, string>) {
  return fetchJson<TokenResponse>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the URL is printed too
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

/** Wait for the browser to come back to http://127.0.0.1:<port>/callback. */
function startCallbackServer() {
  let resolveCode: (v: { code: string; state: string }) => void;
  let rejectCode: (e: Error) => void;
  const result = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (error || !code) {
      res.end(PAGE('Sign-in cancelled', 'You can close this tab.'));
      rejectCode(
        new CliError(
          error === 'access_denied'
            ? 'Sign-in was cancelled in the browser.'
            : `Sign-in failed: ${error ?? 'no code returned'}`,
          EXIT.AUTH,
          'AUTH_FAILED'
        )
      );
      return;
    }
    res.end(
      PAGE(
        'Signed in to ScribeToAny',
        'You can close this tab and go back to the terminal.'
      )
    );
    resolveCode({ code, state });
  });
  const listening = new Promise<number>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () =>
      res((server.address() as AddressInfo).port)
    );
  });
  return { server, listening, result };
}

export async function login(
  baseUrl: string,
  opts: { browser: boolean }
): Promise<Profile> {
  const meta = await metadata(baseUrl);
  const { server, listening, result } = startCallbackServer();
  const port = await listening;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const client = await fetchJson<{ client_id: string }>(
      meta.registration_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }
    );

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const authorize = new URL(meta.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: SCOPE,
      state,
    }).toString();

    log(
      `Open this link to sign in and approve "${CLIENT_NAME}":\n  ${authorize}`
    );
    if (opts.browser) openBrowser(authorize.toString());
    log('Waiting for the browser…');

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new CliError(
              'Timed out waiting for sign-in (5 minutes).',
              EXIT.AUTH,
              'AUTH_TIMEOUT'
            )
          ),
        LOGIN_TIMEOUT_MS
      );
    });
    const callback = await Promise.race([result, timeout]).finally(() =>
      clearTimeout(timer)
    );
    if (callback.state !== state) {
      throw new CliError(
        'Sign-in response did not match this login (state mismatch).',
        EXIT.AUTH,
        'AUTH_FAILED'
      );
    }

    const token = await tokenRequest(meta.token_endpoint, {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    const profile: Profile = {
      clientId: client.client_id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      email: null,
    };
    await saveProfile(baseUrl, profile);
    return profile;
  } finally {
    server.close();
  }
}

/** Exchange the refresh token for a new pair; null when it no longer works. */
export async function refresh(
  baseUrl: string,
  profile: Profile
): Promise<Profile | null> {
  if (!profile.refreshToken) return null;
  const meta = await metadata(baseUrl);
  let token: TokenResponse;
  try {
    token = await tokenRequest(meta.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: profile.refreshToken,
      client_id: profile.clientId,
    });
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.AUTH) return null;
    throw error;
  }
  const next: Profile = {
    ...profile,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? profile.refreshToken,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  await saveProfile(baseUrl, next);
  return next;
}

/** A usable access token: SCRIBETOANY_TOKEN, or the stored one (refreshed). */
export async function accessToken(
  baseUrl: string,
  forceRefresh = false
): Promise<string> {
  if (process.env.SCRIBETOANY_TOKEN) return process.env.SCRIBETOANY_TOKEN;
  const profile = await loadProfile(baseUrl);
  if (!profile) {
    throw new CliError(
      'Not signed in. Run `scribetoany auth login`.',
      EXIT.AUTH,
      'UNAUTHORIZED'
    );
  }
  if (!forceRefresh && profile.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return profile.accessToken;
  }
  const next = await refresh(baseUrl, profile);
  if (!next) {
    throw new CliError(
      'Your sign-in has expired. Run `scribetoany auth login`.',
      EXIT.AUTH,
      'UNAUTHORIZED'
    );
  }
  return next.accessToken;
}
