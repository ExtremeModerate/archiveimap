import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

export const ARCHIVE_RANGES = ['none', 'year', 'quarter', 'month', 'day', 'to', 'from'] as const;
export type ArchiveRange = (typeof ARCHIVE_RANGES)[number];

export type AuthType = 'password' | 'netrc' | 'md5' | 'cert' | 'oauth2';

/** One entry of the `sourcefolder` list, as written in the config file */
export interface RawFolderRule {
  folder?: string;
  action?: string;
  archiverange?: string;
  age?: number | string;
  seen?: number | boolean | string;
  ignorebaddates?: string | boolean;
}

/** One top-level account in the config file */
export interface RawSource {
  imaphost?: string;
  imapssl?: number | boolean;
  imapport?: number;
  auth?: string;
  username?: string;
  password?: string;
  archiveroot?: string;
  archiverange?: string;
  age?: number | string;
  ignorebaddates?: string | boolean;
  sourcefolder?: RawFolderRule[];
  /** Path to the OAuth client JSON downloaded from the Google Cloud console */
  oauthclient?: string;
  oauthclientid?: string;
  oauthclientsecret?: string;
}

/** The reserved top-level `global` section of the config file */
export interface RawGlobal {
  /** Senders at these domains are filed by full address under archiverange: from */
  fulladdressdomains?: string[];
}

export const GLOBAL_KEY = 'global';

export interface GlobalConfig {
  fullAddressDomains: string[];
}

export interface Config {
  global: GlobalConfig;
  sources: Record<string, RawSource>;
}

export interface FolderRule {
  folder: string;
  action: 'archive' | 'delete';
  archiveRange: ArchiveRange;
  /** 'ALL' selects everything; otherwise minimum age in days (always > 0) */
  age: number | 'ALL';
  seenOnly: boolean;
  ignoreBadDates: boolean;
}

export interface Source {
  name: string;
  host: string;
  secure: boolean;
  port: number;
  auth: AuthType;
  username?: string;
  password?: string;
  archiveRoot: string;
  gmail: boolean;
  oauth: { clientFile?: string; clientId?: string; clientSecret?: string };
  rawFolders: RawFolderRule[];
}

export const GMAIL_HOST = 'imap.gmail.com';

/** Holds the config file, the Google OAuth client and saved tokens */
export const stateDir = () => join(homedir(), '.archiveimap');

export function defaultConfigPath(): string {
  return join(stateDir(), 'config.yaml');
}

/** Where the Perl version (and earlier releases of this one) kept the config */
const legacyConfigPath = () => join(homedir(), '.archiveimaprc');

export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path) && path === defaultConfigPath() && existsSync(legacyConfigPath())) {
    throw new Error(`not found. Move your ${legacyConfigPath()} there, or pass it with -c`);
  }
  const doc = parse(readFileSync(path, 'utf8')) as unknown;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${path} does not contain a YAML mapping of sources`);
  }
  const { [GLOBAL_KEY]: rawGlobal, ...sources } = doc as Record<string, unknown>;
  return { global: resolveGlobal((rawGlobal ?? {}) as RawGlobal), sources: sources as Record<string, RawSource> };
}

export function resolveGlobal(raw: RawGlobal): GlobalConfig {
  const domains = raw.fulladdressdomains ?? [];
  if (!Array.isArray(domains)) throw new Error(`${GLOBAL_KEY}.fulladdressdomains must be a list of domains`);
  return {
    fullAddressDomains: domains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  };
}

function truthy(v: unknown): boolean {
  if (typeof v === 'string') return /^(1|yes|true|on)$/i.test(v.trim());
  return Boolean(v);
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Resolves a source's connection settings.  `auth: gmail` (or `oauth2`/`xoauth2`)
 * selects Google OAuth2 and defaults the host to imap.gmail.com.
 */
export function resolveSource(name: string, raw: RawSource): Source {
  let auth = (raw.auth ?? 'password').toString().toLowerCase();
  if (auth === 'gmail' || auth === 'xoauth2') auth = 'oauth2';
  if (!['password', 'netrc', 'md5', 'cert', 'oauth2'].includes(auth)) {
    throw new Error(`unknown auth type "${raw.auth}"`);
  }
  const host = raw.imaphost ?? (auth === 'oauth2' ? GMAIL_HOST : undefined);
  if (!host) throw new Error('imaphost is required');
  const gmail = host.toLowerCase() === GMAIL_HOST;
  // Gmail only accepts TLS on 993, so don't make users spell it out
  const secure = raw.imapssl === undefined ? gmail : truthy(raw.imapssl);
  const port = raw.imapport ? Number(raw.imapport) : secure ? 993 : 143;

  return {
    name,
    host,
    secure,
    port,
    auth: auth as AuthType,
    username: raw.username || undefined,
    password: raw.password || undefined,
    archiveRoot: raw.archiveroot ?? '',
    gmail,
    oauth: {
      clientFile: raw.oauthclient ? expandHome(raw.oauthclient) : undefined,
      clientId: raw.oauthclientid,
      clientSecret: raw.oauthclientsecret,
    },
    rawFolders: raw.sourcefolder ?? [],
  };
}

/**
 * Resolves one sourcefolder entry, applying account-level defaults the same way the
 * Perl version did.  Throws with a human readable reason when the rule should be skipped.
 */
export function resolveFolderRule(raw: RawFolderRule, source: RawSource): FolderRule {
  const folder = raw.folder || 'INBOX';

  const archiveRange = (raw.archiverange || source.archiverange || 'none').toString().toLowerCase();
  if (!(ARCHIVE_RANGES as readonly string[]).includes(archiveRange)) {
    throw new Error(`Invalid range (${archiveRange})`);
  }

  const action = (raw.action ?? '').toString().toLowerCase();
  if (action !== 'archive' && action !== 'delete') {
    throw new Error(`Invalid Action (${raw.action ?? ''})`);
  }
  if (action === 'archive' && !source.archiveroot) {
    throw new Error('archiveroot is required for the archive action');
  }

  const rawAge = raw.age || source.age;
  let age: number | 'ALL';
  if (typeof rawAge === 'string' && rawAge.trim().toUpperCase() === 'ALL') {
    age = 'ALL';
  } else {
    const n = Number(rawAge ?? 0);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid age (${rawAge})`);
    if (n === 0) throw new Error('Age is 0 or not set, nothing to archive');
    age = n;
  }

  return {
    folder,
    action,
    archiveRange: archiveRange as ArchiveRange,
    age,
    // documented default is to only archive messages that have been read
    seenOnly: raw.seen === undefined ? true : truthy(raw.seen),
    ignoreBadDates: truthy(raw.ignorebaddates) || truthy(source.ignorebaddates),
  };
}
