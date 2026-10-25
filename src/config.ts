import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.6';
export const USER_AGENT = `scribetoany-cli/${VERSION}`;
export const DEFAULT_BASE_URL = 'https://scribetoany.com';

export function resolveBaseUrl(flag?: string): string {
  const raw = flag || process.env.SCRIBETOANY_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Where credentials live: $XDG_CONFIG_HOME/scribetoany, %APPDATA% on Windows. */
export function configDir(): string {
  if (process.env.SCRIBETOANY_CONFIG_DIR) {
    return process.env.SCRIBETOANY_CONFIG_DIR;
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'scribetoany');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'scribetoany');
}

const credentialsPath = () => join(configDir(), 'credentials.json');

export interface Profile {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
  email: string | null;
}

interface CredentialsFile {
  version: 1;
  profiles: Record<string, Profile>;
}

async function readAll(): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    if (parsed?.version === 1 && parsed.profiles) return parsed;
  } catch {
    // missing or unreadable: treat as signed out
  }
  return { version: 1, profiles: {} };
}

async function writeAll(data: CredentialsFile): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function loadProfile(baseUrl: string): Promise<Profile | null> {
  return (await readAll()).profiles[baseUrl] ?? null;
}

export async function saveProfile(
  baseUrl: string,
  profile: Profile
): Promise<void> {
  const data = await readAll();
  data.profiles[baseUrl] = profile;
  await writeAll(data);
}

export async function deleteProfile(baseUrl: string): Promise<boolean> {
  const data = await readAll();
  if (!data.profiles[baseUrl]) return false;
  delete data.profiles[baseUrl];
  await writeAll(data);
  return true;
}
