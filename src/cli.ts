#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Api } from './api.ts';
import * as commands from './commands.ts';
import { FORMATS, type Format } from './commands.ts';
import { VERSION, resolveBaseUrl } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { setQuiet } from './output.ts';

const HELP = `scribetoany ${VERSION}: transcribe audio and video with ScribeToAny

Usage:
  scribetoany auth login [--no-browser]   Sign in (opens the browser)
  scribetoany auth logout                 Sign out and revoke the token
  scribetoany auth status                 Show the signed-in account
  scribetoany transcribe <file|url>...    Upload, transcribe, save the result
  scribetoany get <id>                    Save a finished transcript
  scribetoany list                        Recent transcripts
  scribetoany usage                       Plan allowance left

Transcribe options:
  --language <code>       Spoken language (Whisper code, e.g. en, zh), default auto
  --speakers [n]          Label speakers; optionally the number of speakers (2-8)
  --translate-to-english  Transcribe straight into English
  --mode <mode>           fast | balanced | accurate (default accurate)
  --no-wait               Print the transcript id and exit; fetch later with get

Output options (transcribe, get):
  --format <f>            txt | srt | vtt | json (default txt)
  --no-timestamps         txt without [m:ss] prefixes
  --out <path|->          File or directory to write; - for stdout
                          (default ./<name>.<format>)
  --force                 Overwrite an existing output file
  --wait                  get: wait until the transcript is ready
  --timeout <min>         How long to wait (default 60)

List options:
  --query <text>          Only names containing this text
  --limit <n>             How many (default 20, max 100)

Global:
  --json                  Machine-readable output on stdout
  --quiet                 No progress on stderr
  --base-url <url>        Server (default https://scribetoany.com, or
                          SCRIBETOANY_BASE_URL)
  -v, --version           Print the version
  -h, --help              This help

Exit codes: 0 ok, 2 bad input, 3 not signed in, 4 quota or concurrency
limit, 5 transcription failed, 6 network or server error, 7 not ready yet.
`;

/** `--speakers 3` → `--speakers --num-speakers 3` (parseArgs has no optional values). */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = /^--speakers=(\d+)$/.exec(arg);
    if (eq) {
      out.push('--speakers', '--num-speakers', eq[1]);
    } else if (arg === '--speakers' && /^\d+$/.test(argv[i + 1] ?? '')) {
      out.push('--speakers', '--num-speakers', argv[++i]);
    } else {
      out.push(arg);
    }
  }
  return out;
}

function parse(argv: string[]) {
  return parseArgs({
    args: normalizeArgv(argv),
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      'no-browser': { type: 'boolean', default: false },
      language: { type: 'string', default: 'auto' },
      speakers: { type: 'boolean', default: false },
      'num-speakers': { type: 'string' },
      'translate-to-english': { type: 'boolean', default: false },
      mode: { type: 'string', default: 'accurate' },
      'no-wait': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '60' },
      format: { type: 'string', default: 'txt' },
      'no-timestamps': { type: 'boolean', default: false },
      out: { type: 'string', short: 'o' },
      force: { type: 'boolean', default: false },
      query: { type: 'string' },
      limit: { type: 'string', default: '20' },
    },
  });
}

const usageError = (message: string) =>
  new CliError(`${message}\nRun \`scribetoany --help\` for usage.`, EXIT.USAGE, 'USAGE');

function intOption(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`--${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw usageError((error as Error).message);
  }
  const { values: v, positionals } = parsed;
  setQuiet(v.quiet);

  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [command, ...rest] = positionals;
  if (v.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const api = new Api(resolveBaseUrl(v['base-url']));
  const g = { json: v.json };

  const format = v.format as Format;
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw usageError(`--format must be one of ${FORMATS.join(', ')}.`);
  }
  const output = {
    format,
    timestamps: !v['no-timestamps'],
    out: v.out,
    force: v.force,
  };
  const timeoutMin = intOption(v.timeout, 'timeout', 1, 24 * 60);

  switch (command) {
    case 'auth': {
      const [sub] = rest;
      if (sub === 'login') {
        return commands.authLogin(api, g, { browser: !v['no-browser'] });
      }
      if (sub === 'logout') return commands.authLogout(api, g);
      if (sub === 'status') return commands.authStatus(api, g);
      throw usageError('Use `auth login`, `auth logout` or `auth status`.');
    }
    case 'transcribe': {
      if (!['fast', 'balanced', 'accurate'].includes(v.mode)) {
        throw usageError('--mode must be fast, balanced or accurate.');
      }
      return commands.transcribe(
        api,
        g,
        rest,
        {
          language: v.language,
          speakers: v.speakers,
          numSpeakers: v['num-speakers']
            ? intOption(v['num-speakers'], 'speakers', 2, 8)
            : undefined,
          translateToEnglish: v['translate-to-english'],
          mode: v.mode as 'fast' | 'balanced' | 'accurate',
        },
        output,
        { wait: !v['no-wait'], timeoutMin }
      );
    }
    case 'get':
      return commands.get(api, g, rest[0], output, {
        wait: v.wait,
        timeoutMin,
      });
    case 'list':
      return commands.list(api, g, {
        query: v.query,
        limit: intOption(v.limit, 'limit', 1, 100),
      });
    case 'usage':
      return commands.usage(api, g);
    default:
      throw usageError(`Unknown command "${command}".`);
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(EXIT.OK),
  (error: unknown) => {
    const cli =
      error instanceof CliError
        ? error
        : new CliError(
            (error as Error)?.message ?? String(error),
            EXIT.NETWORK,
            'INTERNAL'
          );
    const json = process.argv.includes('--json');
    // With --json the error goes to stderr as JSON too, so stdout stays clean.
    if (json) {
      process.stderr.write(
        `${JSON.stringify({ error: { code: cli.code, message: cli.message } })}\n`
      );
    } else {
      process.stderr.write(`Error: ${cli.message}\n`);
    }
    process.exit(cli.exitCode);
  }
);

