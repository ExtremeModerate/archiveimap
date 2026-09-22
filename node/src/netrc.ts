import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface NetrcEntry {
  machine?: string; // undefined for the `default` entry
  login?: string;
  password?: string;
}

export function parseNetrc(text: string): NetrcEntry[] {
  // strip comments, then tokenize; quoted tokens may contain whitespace
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/(^|\s)#.*$/, '');
    for (const m of clean.matchAll(re)) {
      tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
    }
  }

  const entries: NetrcEntry[] = [];
  let current: NetrcEntry | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok) {
      case 'machine':
        current = { machine: tokens[++i] };
        entries.push(current);
        break;
      case 'default':
        current = {};
        entries.push(current);
        break;
      case 'login':
        if (current) current.login = tokens[++i];
        break;
      case 'password':
        if (current) current.password = tokens[++i];
        break;
      case 'account':
        i++;
        break;
      case 'macdef':
        // macro bodies run to the next blank line, which we've already discarded
        current = undefined;
        i++;
        break;
    }
  }
  return entries;
}

/**
 * Same semantics as Perl's Net::Netrc->lookup(machine, login): first entry for the
 * machine (and login, if given), falling back to a `default` entry.
 */
export function lookupNetrc(machine: string, login?: string, path = join(homedir(), '.netrc')): NetrcEntry | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const entries = parseNetrc(text);
  const host = machine.toLowerCase();
  return (
    entries.find((e) => e.machine?.toLowerCase() === host && (!login || e.login === login)) ??
    entries.find((e) => e.machine === undefined && (!login || e.login === login))
  );
}
