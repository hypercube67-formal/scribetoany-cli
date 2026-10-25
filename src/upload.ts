import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Api } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { formatBytes, log, progress } from './output.ts';

/** Extensions the server accepts (src/transcription/constants.ts). */
export const ACCEPTED_EXTENSIONS = [
  'mp3', 'mp4', 'm4a', 'mov', 'aac', 'wav', 'ogg', 'opus', 'mpeg', 'mpg',
  'wma', 'wmv', 'webm', 'flac', 'mkv', 'avi',
];

/** R2's single-PUT limit. */
const MAX_BYTES = 5 * 1024 ** 3;

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
};

export const extensionOf = (path: string) =>
  extname(path).slice(1).toLowerCase();

/** Check a local file before spending any quota on it. */
export async function checkFile(path: string): Promise<number> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    throw new CliError(`No such file: ${path}`, EXIT.USAGE, 'NO_FILE');
  }
  const ext = extensionOf(path);
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new CliError(
      `Unsupported file type ".${ext}". Supported: ${ACCEPTED_EXTENSIONS.join(', ')}`,
      EXIT.USAGE,
      'UNSUPPORTED_FILE_TYPE'
    );
  }
  if (size === 0) throw new CliError(`${path} is empty.`, EXIT.USAGE, 'EMPTY');
  if (size > MAX_BYTES) {
    throw new CliError(
      `${path} is ${formatBytes(size)}; the upload limit is 5 GB.`,
      EXIT.USAGE,
      'TOO_LARGE'
    );
  }
  return size;
}

function md5File(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest()));
  });
}

/** Upload a local file straight to storage; returns the server's fileId. */
export async function uploadFile(
  api: Api,
  path: string,
  size: number
): Promise<string> {
  const name = basename(path);
  const contentType = MIME[extensionOf(path)] ?? 'application/octet-stream';
  const md5 = await md5File(path);

  const { fileId, uploadUrl } = await api.json<{
    fileId: string;
    uploadUrl: string;
  }>('/files', {
    method: 'POST',
    json: { name, size, contentType, md5: md5.toString('hex') },
  });

  log(`Uploading ${name} (${formatBytes(size)})…`);
  const bar = progress('Uploading');
  let sent = 0;
  const source = createReadStream(path);
  source.on('data', (chunk) => {
    sent += chunk.length;
    bar.update(sent / size);
  });

  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Content-MD5': md5.toString('base64'),
      },
      body: Readable.toWeb(source) as ReadableStream,
      // Required by Node's fetch for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (error) {
    bar.done();
    throw new CliError(
      `Upload failed: ${(error as Error).message}`,
      EXIT.NETWORK,
      'UPLOAD_FAILED'
    );
  }
  bar.done();
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new CliError(
      `Upload failed (${res.status}): ${detail}`,
      EXIT.NETWORK,
      'UPLOAD_FAILED'
    );
  }
  return fileId;
}
