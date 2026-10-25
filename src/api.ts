import { accessToken } from './auth.ts';
import { USER_AGENT } from './config.ts';
import { CliError, EXIT, exitCodeFor } from './errors.ts';

/** Calls to ScribeToAny's /api/v1 with the stored bearer token. */

export interface Job {
  id: string;
  name: string;
  status: 'queued' | 'transcribing' | 'done' | 'failed' | string;
  error: string | null;
  language: string | null;
  durationSec: number | null;
  sourceType: string | null;
  createdAt: string;
  url: string;
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class Api {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async send(
    path: string,
    opts: RequestOptions,
    forceRefresh: boolean
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = await accessToken(this.baseUrl, forceRefresh);
    try {
      return await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          ...(opts.json !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      });
    } catch (error) {
      throw new CliError(
        `Can't reach ${this.baseUrl}: ${(error as Error).message}`,
        EXIT.NETWORK,
        'NETWORK'
      );
    }
  }

  /** The raw response; API errors are thrown as CliError. */
  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    let res = await this.send(path, opts, false);
    // The token may have been revoked or expired early: refresh once.
    if (res.status === 401 && !process.env.SCRIBETOANY_TOKEN) {
      res = await this.send(path, opts, true);
    }
    if (res.ok) return res;

    let code = 'HTTP_ERROR';
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {}
    throw new CliError(message, exitCodeFor(code, res.status), code);
  }

  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await (await this.request(path, opts)).json()) as T;
  }

  me() {
    return this.json<{ email: string | null; plan: string }>('/me');
  }

  usage() {
    return this.json<{
      plan: string;
      filesToday: number;
      filesPerDay: number | null;
      minutesUsedThisMonth: number;
      minutesPerMonth: number | null;
      extraPackMinutes: number;
      resetsAt: string;
    }>('/usage');
  }

  job(id: string) {
    return this.json<Job>(`/transcriptions/${encodeURIComponent(id)}`);
  }

  list(query: { query?: string; limit?: number }) {
    return this.json<{ total: number; transcriptions: Job[] }>(
      '/transcriptions',
      { query }
    );
  }

  async transcript(
    id: string,
    format: string,
    timestamps: boolean
  ): Promise<string> {
    const res = await this.request(
      `/transcriptions/${encodeURIComponent(id)}/transcript`,
      { query: { format, timestamps: timestamps ? '1' : '0' } }
    );
    return res.text();
  }
}
