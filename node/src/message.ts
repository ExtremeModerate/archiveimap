import * as psl from 'psl';
import type { ArchiveRange } from './config.js';

export interface DateParts {
  year?: number;
  month?: string; // 01-12
  quarter?: string; // Q1-Q4
  day?: string; // 01-31
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Breaks a message's Date: header into archive path components.  Components that are
 * missing or implausible (year before 1980 or after next week's year) are left undefined.
 */
export function dateParts(date: Date | string | undefined, now: Date = new Date()): DateParts {
  const d = date instanceof Date ? date : date ? new Date(date) : undefined;
  if (!d || Number.isNaN(d.getTime())) return {};
  const maxYear = new Date(now.getTime() + 7 * 86400_000).getFullYear();
  const year = d.getFullYear();
  if (year < 1980 || year > maxYear) return {};
  const month = d.getMonth();
  return {
    year,
    month: pad2(month + 1),
    quarter: `Q${Math.floor(month / 3) + 1}`,
    day: pad2(d.getDate()),
  };
}

export interface DestinationInput {
  range: ArchiveRange;
  root: string;
  separator: string;
  folder: string;
  date: DateParts;
  toUser?: string;
  /** Sender's registrable domain, or [listed domain, address] for fulladdressdomains senders */
  fromFolders?: string[];
  ignoreBadDates: boolean;
}

/**
 * Computes the archive folder for a message, or undefined when the message has a bad
 * date and bad dates aren't being ignored (the message should then be skipped).
 */
export function destinationFor(i: DestinationInput): string | undefined {
  const { year, month, quarter, day } = i.date;
  const join = (...parts: (string | number)[]) => [i.root, ...parts].join(i.separator);
  // an address-derived name is one folder, so it mustn't contain the hierarchy separator
  const leaf = (name: string) => name.toLowerCase().split(i.separator).join('_');

  switch (i.range) {
    case 'none':
      return i.root;
    case 'year':
      if (year) return join(year, i.folder);
      break;
    case 'quarter':
      if (year && quarter) return join(year, `${i.folder}-${quarter}`);
      break;
    case 'month':
      if (year && month) return join(year, month, i.folder);
      break;
    case 'day':
      if (year && month && day) return join(year, month, day, i.folder);
      break;
    case 'to':
      if (i.toUser) return join(leaf(i.toUser));
      break;
    case 'from':
      if (year && i.fromFolders?.length) return join(year, ...i.fromFolders.map(leaf));
      break;
  }
  return i.ignoreBadDates ? join(`${i.folder}-Archive-BadDate`) : undefined;
}

const EMAIL_RE = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

export const INVALID_TO = 'INVALID_TO@invalidaddress.com';

/**
 * Picks the recipient a message was actually delivered to.  With several To: addresses,
 * the first Received: header naming one of them wins; otherwise the first To: address.
 */
export function deliveredTo(toAddresses: string[], receivedHeaders: string[]): string {
  const to = toAddresses.filter(Boolean);
  if (to.length === 0) return INVALID_TO;
  if (to.length === 1) return to[0]!;
  const byLower = new Map(to.map((a) => [a.toLowerCase(), a]));
  for (const header of receivedHeaders) {
    const found = header.match(EMAIL_RE)?.[0].toLowerCase();
    if (found && byLower.has(found)) return byLower.get(found)!;
  }
  return to[0]!;
}

export const userPart = (address: string) => address.slice(0, address.lastIndexOf('@')) || address;
export const hostPart = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** Registrable domain of an address's host, e.g. mail.news.example.co.uk -> example.co.uk */
export function rootDomain(address: string | undefined): string | undefined {
  if (!address || !address.includes('@')) return undefined;
  return psl.get(hostPart(address).toLowerCase()) ?? undefined;
}

/**
 * Folder path for `from` filing: the sender's registrable domain, or, when the sender's
 * domain (or a parent of it) is in `fullAddressDomains`, that listed domain with a
 * subfolder per sender address, e.g. ['gmail.com', 'bob@list.gmail.com'].
 */
export function fromFolders(address: string | undefined, fullAddressDomains: string[]): string[] | undefined {
  if (!address || !address.includes('@')) return undefined;
  const host = hostPart(address).toLowerCase();
  // the most specific listed domain wins, so list.gmail.com can be listed beside gmail.com
  const listed = fullAddressDomains
    .filter((d) => host === d || host.endsWith(`.${d}`))
    .sort((a, b) => b.length - a.length)[0];
  if (listed) return [listed, address.toLowerCase()];
  const domain = rootDomain(address);
  return domain ? [domain] : undefined;
}

/** Returns the unfolded values of every occurrence of `name` in a raw header block. */
export function headerValues(raw: Buffer | string | undefined, name: string): string[] {
  if (!raw) return [];
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const prefix = name.toLowerCase() + ':';
  return unfolded
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}
