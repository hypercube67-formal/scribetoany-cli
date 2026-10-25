import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Api, type Job } from './api.ts';
import { login } from './auth.ts';
import { deleteProfile, loadProfile, saveProfile } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import {
  formatDuration,
  log,
  print,
  printJson,
  warn,
} from './output.ts';
import { checkFile, uploadFile } from './upload.ts';

export const FORMATS = ['txt', 'srt', 'vtt', 'json'] as const;
export type Format = (typeof FORMATS)[number];

export interface Globals {
  json: boolean;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export async function authLogin(
  api: Api,
  g: Globals,
  opts: { browser: boolean }
): Promise<void> {
  const profile = await login(api.baseUrl, opts);
  const me = await api.me();
  await saveProfile(api.baseUrl, { ...profile, email: me.email });
  if (g.json) printJson({ signedIn: true, ...me, baseUrl: api.baseUrl });
  else print(`Signed in as ${me.email ?? 'unknown'} (plan: ${me.plan}).`);
}

export async function authStatus(api: Api, g: Globals): Promise<void> {
  const profile = await loadProfile(api.baseUrl);
  if (!profile && !process.env.SCRIBETOANY_TOKEN) {
    if (g.json) printJson({ signedIn: false, baseUrl: api.baseUrl });
    throw new CliError(
      'Not signed in. Run `scribetoany auth login`.',
      EXIT.AUTH,
      'UNAUTHORIZED'
    );
  }
  const me = await api.me();
  if (g.json) printJson({ signedIn: true, ...me, baseUrl: api.baseUrl });
  else print(`Signed in as ${me.email ?? 'unknown'} (plan: ${me.plan}) on ${api.baseUrl}.`);
}

export async function authLogout(api: Api, g: Globals): Promise<void> {
  const profile = await loadProfile(api.baseUrl);
  if (profile) {
    try {
      await api.request('/auth/revoke', { method: 'POST' });
    } catch (error) {
      log(`Could not revoke the token on the server: ${(error as Error).message}`);
    }
  }
  const removed = await deleteProfile(api.baseUrl);
  if (g.json) printJson({ signedOut: removed });
  else print(removed ? 'Signed out.' : 'Not signed in.');
}

// ---------------------------------------------------------------------------
// transcribe / get
// ---------------------------------------------------------------------------

export interface TranscribeOptions {
  language: string;
  speakers: boolean;
  numSpeakers?: number;
  translateToEnglish: boolean;
  mode: 'fast' | 'balanced' | 'accurate';
}

export interface OutputOptions {
  format: Format;
  timestamps: boolean;
  out?: string;
  force: boolean;
}

export interface WaitOptions {
  wait: boolean;
  timeoutMin: number;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** Safe file stem from a job or file name. */
function stem(name: string): string {
  const base = basename(name, extname(name));
  return base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim().slice(0, 120) || 'transcript';
}

/**
 * Where to write a result. `-` means stdout. A directory (existing, or a path
 * ending in "/", or any --out when several inputs are given) gets <stem>.<ext>.
 */
function outputPath(
  out: string | undefined,
  name: string,
  format: Format,
  many: boolean
): string {
  const file = `${stem(name)}.${format}`;
  if (!out) return resolve(file);
  if (out === '-') return '-';
  const isDir =
    many ||
    out.endsWith('/') ||
    (existsSync(out) && statSync(out).isDirectory());
  return resolve(isDir ? join(out, file) : out);
}

function assertWritable(path: string, force: boolean): void {
  if (path !== '-' && existsSync(path) && !force) {
    throw new CliError(
      `${path} already exists. Use --force to overwrite or --out to pick another path.`,
      EXIT.USAGE,
      'OUTPUT_EXISTS'
    );
  }
}

/** Poll a job until it is done or failed (or the timeout passes). */
async function waitForJob(api: Api, id: string, timeoutMin: number): Promise<Job> {
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let delay = 2000;
  let lastStatus = '';
  for (;;) {
    const job = await api.job(id);
    if (job.status !== lastStatus) {
      log(`${job.name}: ${job.status}`);
      lastStatus = job.status;
    }
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() + delay > deadline) {
      throw new CliError(
        `Still ${job.status} after ${timeoutMin} min. Check later with \`scribetoany get ${id} --wait\`.`,
        EXIT.NOT_READY,
        'NOT_READY'
      );
    }
    await sleep(delay);
    delay = Math.min(15000, Math.round(delay * 1.5));
  }
}

async function writeResult(
  api: Api,
  job: Job,
  o: OutputOptions,
  path: string
): Promise<string> {
  const body = await api.transcript(job.id, o.format, o.timestamps);
  if (path === '-') {
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  } else {
    await writeFile(path, body);
    log(`Saved ${path}`);
  }
  if (job.planLimit) warn(`${job.name}: ${job.planLimit.message}`);
  return path;
}

function failedError(job: Job): CliError {
  return new CliError(
    `Transcription of ${job.name} failed: ${job.error ?? 'unknown error'}`,
    EXIT.FAILED,
    'JOB_FAILED'
  );
}

const jobSummary = (job: Job, output: string | null) => ({
  id: job.id,
  name: job.name,
  status: job.status,
  language: job.language,
  durationSec: job.durationSec,
  planLimit: job.planLimit ?? null,
  url: job.url,
  output: output === '-' ? null : output,
});

/** Start one transcription; returns the job id. */
async function start(api: Api, input: string, t: TranscribeOptions): Promise<string> {
  const options = {
    language: t.language,
    mode: t.mode,
    diarize: t.speakers,
    numSpeakers: t.numSpeakers ?? null,
    translateToEn: t.translateToEnglish,
  };
  if (isUrl(input)) {
    const { id } = await api.json<{ id: string }>('/transcriptions', {
      method: 'POST',
      json: { url: input, ...options },
    });
    return id;
  }
  const size = await checkFile(input);
  const fileId = await uploadFile(api, input, size);
  const { id } = await api.json<{ id: string }>(
    `/files/${encodeURIComponent(fileId)}/transcribe`,
    { method: 'POST', json: options }
  );
  return id;
}

export async function transcribe(
  api: Api,
  g: Globals,
  inputs: string[],
  t: TranscribeOptions,
  o: OutputOptions,
  w: WaitOptions
): Promise<void> {
  if (!inputs.length) {
    throw new CliError('Give a file or a link to transcribe.', EXIT.USAGE, 'USAGE');
  }
  const many = inputs.length > 1;
  if (many && o.out === '-') {
    throw new CliError('--out - only works with one input.', EXIT.USAGE, 'USAGE');
  }

  // Fail fast on local problems (missing file, existing output) before any
  // upload spends the user's quota.
  for (const input of inputs) {
    if (isUrl(input)) continue;
    await checkFile(input);
    if (w.wait) assertWritable(outputPath(o.out, input, o.format, many), o.force);
  }

  const results: ReturnType<typeof jobSummary>[] = [];
  let worst: CliError | null = null;
  for (const input of inputs) {
    try {
      const id = await start(api, input, t);
      log(`Started ${id}`);
      if (!w.wait) {
        const job = await api.job(id);
        results.push(jobSummary(job, null));
        if (!g.json) print(id);
        continue;
      }
      const job = await waitForJob(api, id, w.timeoutMin);
      if (job.status === 'failed') throw failedError(job);
      const path = outputPath(o.out, isUrl(input) ? job.name : input, o.format, many);
      assertWritable(path, o.force);
      await writeResult(api, job, o, path);
      results.push(jobSummary(job, path));
      if (!g.json && path !== '-') print(path);
    } catch (error) {
      if (!(error instanceof CliError) || !many) throw error;
      log(`${input}: ${error.message}`);
      if (!worst || error.exitCode > worst.exitCode) worst = error;
    }
  }
  if (g.json) printJson(many ? results : results[0]);
  if (worst) throw worst;
}

export async function get(
  api: Api,
  g: Globals,
  id: string | undefined,
  o: OutputOptions,
  w: WaitOptions
): Promise<void> {
  if (!id) throw new CliError('Give a transcript id.', EXIT.USAGE, 'USAGE');
  let job = await api.job(id);
  if (job.status !== 'done' && job.status !== 'failed') {
    if (!w.wait) {
      if (g.json) printJson(jobSummary(job, null));
      throw new CliError(
        `${job.name} is ${job.status}. Add --wait to wait for it.`,
        EXIT.NOT_READY,
        'NOT_READY'
      );
    }
    job = await waitForJob(api, id, w.timeoutMin);
  }
  if (job.status === 'failed') throw failedError(job);
  const path = outputPath(o.out, job.name, o.format, false);
  assertWritable(path, o.force);
  await writeResult(api, job, o, path);
  if (g.json) printJson(jobSummary(job, path));
  else if (path !== '-') print(path);
}

// ---------------------------------------------------------------------------
// list / usage
// ---------------------------------------------------------------------------

export async function list(
  api: Api,
  g: Globals,
  q: { query?: string; limit: number }
): Promise<void> {
  const { total, transcriptions } = await api.list(q);
  if (g.json) {
    printJson({ total, transcriptions });
    return;
  }
  if (!transcriptions.length) {
    print('No transcripts.');
    return;
  }
  for (const j of transcriptions) {
    print(
      [
        j.id,
        j.status.padEnd(12),
        formatDuration(j.durationSec).padStart(8),
        j.createdAt.slice(0, 10),
        j.planLimit ? `${j.name} (cut at plan limit)` : j.name,
      ].join('  ')
    );
  }
  if (total > transcriptions.length) {
    log(`Showing ${transcriptions.length} of ${total}. Use --limit for more.`);
  }
}

export async function usage(api: Api, g: Globals): Promise<void> {
  const u = await api.usage();
  if (g.json) {
    printJson(u);
    return;
  }
  print(`Plan: ${u.plan}`);
  print(
    `Files today: ${u.filesToday}${u.filesPerDay === null ? ' (no daily limit)' : ` of ${u.filesPerDay}`}`
  );
  // No monthly allowance (e.g. a free account that bought minute packs):
  // "0 of 0" would read as "used up", so show only what can be spent.
  const monthly = u.minutesPerMonth !== 0;
  if (monthly) {
    print(
      `Minutes this month: ${u.minutesUsedThisMonth}${u.minutesPerMonth === null ? '' : ` of ${u.minutesPerMonth}`}`
    );
  }
  if (u.extraPackMinutes) {
    print(
      `Minute packs: ${u.extraPackMinutes} min left${monthly ? '' : ' (no monthly minutes on this plan)'}`
    );
  } else if (!monthly) {
    print('Minutes left: 0. Plans and minute packs: https://scribetoany.com/pricing');
  }
  if (monthly) print(`Monthly minutes reset: ${u.resetsAt}`);
}
