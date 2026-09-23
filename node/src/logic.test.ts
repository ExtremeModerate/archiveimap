import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveFolderRule, resolveGlobal, resolveSource } from './config.js';
import { dateParts, deliveredTo, destinationFor, fromFolders, headerValues, INVALID_TO, rootDomain, userPart } from './message.js';
import { parseNetrc } from './netrc.js';

const now = new Date(2026, 8, 22);
const base = { root: 'Archives', separator: '/', folder: 'INBOX', ignoreBadDates: false };

test('dateParts splits a date and rejects implausible years', () => {
  assert.deepEqual(dateParts(new Date(2024, 4, 7), now), { year: 2024, month: '05', quarter: 'Q2', day: '07' });
  assert.deepEqual(dateParts(new Date(2024, 11, 31), now).quarter, 'Q4');
  assert.deepEqual(dateParts(new Date(1975, 0, 1), now), {});
  assert.deepEqual(dateParts(new Date(2031, 0, 1), now), {});
  assert.deepEqual(dateParts('not a date', now), {});
  assert.deepEqual(dateParts(undefined, now), {});
});

test('destinationFor builds each archive range', () => {
  const date = dateParts(new Date(2024, 4, 7), now);
  const dest = (range: Parameters<typeof destinationFor>[0]['range']) =>
    destinationFor({ ...base, range, date, toUser: 'Bob', fromFolders: ['Example.com'] });
  assert.equal(dest('none'), 'Archives');
  assert.equal(dest('year'), 'Archives/2024/INBOX');
  assert.equal(dest('quarter'), 'Archives/2024/INBOX-Q2');
  assert.equal(dest('month'), 'Archives/2024/05/INBOX');
  assert.equal(dest('day'), 'Archives/2024/05/07/INBOX');
  assert.equal(dest('to'), 'Archives/bob');
  assert.equal(dest('from'), 'Archives/2024/example.com');
});

test('destinationFor handles bad dates', () => {
  assert.equal(destinationFor({ ...base, range: 'quarter', date: {} }), undefined);
  assert.equal(destinationFor({ ...base, range: 'quarter', date: {}, ignoreBadDates: true }), 'Archives/INBOX-Archive-BadDate');
  // "to" sorting doesn't depend on the date
  assert.equal(destinationFor({ ...base, range: 'to', date: {}, toUser: 'amy' }), 'Archives/amy');
});

test('deliveredTo matches Received headers against multiple recipients', () => {
  assert.equal(deliveredTo([], []), INVALID_TO);
  assert.equal(deliveredTo(['one@x.com'], []), 'one@x.com');
  const received = [
    'from mx.x.com by mail.me.com with ESMTP id abc for <Two@X.com>; Tue, 1 Sep 2026',
    'from a by b with SMTP id 1 for <one@x.com>',
  ];
  assert.equal(deliveredTo(['one@x.com', 'two@x.com'], received), 'two@x.com');
  assert.equal(deliveredTo(['one@x.com', 'three@x.com'], ['from a by b id 2 for <nobody@x.com>']), 'one@x.com');
});

test('address helpers', () => {
  assert.equal(userPart('bob@example.com'), 'bob');
  assert.equal(rootDomain('news@mail.news.example.co.uk'), 'example.co.uk');
  assert.equal(rootDomain(undefined), undefined);
});

test('headerValues unfolds and collects repeated headers', () => {
  const raw = 'Received: from a\r\n  by b\r\nReceived: from c by d\r\nX-Other: y\r\n\r\n';
  assert.deepEqual(headerValues(Buffer.from(raw), 'received'), ['from a by b', 'from c by d']);
});

test('parseNetrc reads machine and default entries', () => {
  const entries = parseNetrc(`
# comment
machine imap.gmail.com login home@gmail.com password "app pass"
machine imap.gmail.com
  login work@gmail.com
  password secret2
default login anon password guest
`);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { machine: 'imap.gmail.com', login: 'home@gmail.com', password: 'app pass' });
  assert.deepEqual(entries[2], { login: 'anon', password: 'guest' });
});

test('resolveSource applies Gmail defaults for auth: gmail', () => {
  const s = resolveSource('g', { auth: 'gmail', username: 'me@gmail.com' });
  assert.equal(s.host, 'imap.gmail.com');
  assert.equal(s.auth, 'oauth2');
  assert.equal(s.secure, true);
  assert.equal(s.port, 993);
  const plain = resolveSource('p', { imaphost: 'mail.example.com', auth: 'netrc' });
  assert.equal(plain.port, 143);
  assert.equal(plain.secure, false);
});

test('resolveFolderRule applies defaults and validation', () => {
  const src = { archiveroot: 'Archives', archiverange: 'quarter', age: 30 };
  const rule = resolveFolderRule({ folder: 'INBOX', action: 'Archive' }, src);
  assert.equal(rule.archiveRange, 'quarter');
  assert.equal(rule.age, 30);
  assert.equal(rule.seenOnly, true);
  assert.equal(rule.ignoreBadDates, false);
  assert.equal(resolveFolderRule({ action: 'delete', age: 'ALL', seen: 0, ignorebaddates: 'YES' }, {}).age, 'ALL');
  assert.throws(() => resolveFolderRule({ action: 'shred', age: 3 }, src), /Invalid Action/);
  assert.throws(() => resolveFolderRule({ action: 'archive', archiverange: 'week', age: 3 }, src), /Invalid range/);
  assert.throws(() => resolveFolderRule({ action: 'archive', age: 3 }, {}), /archiveroot/);
  assert.throws(() => resolveFolderRule({ action: 'delete' }, {}), /nothing to archive/);
});

test('fromFolders files fulladdressdomains senders under the listed domain', () => {
  const full = ['gmail.com', 'example.org'];
  assert.deepEqual(fromFolders('BobUser@Gmail.com', full), ['gmail.com', 'bobuser@gmail.com']);
  assert.deepEqual(fromFolders('another@list.gmail.com', full), ['gmail.com', 'another@list.gmail.com']);
  assert.deepEqual(fromFolders('news@lists.example.org', full), ['example.org', 'news@lists.example.org']);
  assert.deepEqual(fromFolders('news@mail.news.example.co.uk', full), ['example.co.uk']);
  assert.deepEqual(fromFolders('someone@notgmail.com', full), ['notgmail.com']);
  assert.deepEqual(fromFolders('x@list.gmail.com', [...full, 'list.gmail.com']), ['list.gmail.com', 'x@list.gmail.com']);
  assert.equal(fromFolders(undefined, full), undefined);
});

test('destinationFor keeps address-derived names to a single folder level', () => {
  const date = dateParts(new Date(2024, 4, 7), now);
  const from = (separator: string) =>
    destinationFor({ ...base, separator, range: 'from', date, fromFolders: ['gmail.com', 'bob.user@gmail.com'] });
  assert.equal(from('/'), 'Archives/2024/gmail.com/bob.user@gmail.com');
  assert.equal(from('.'), 'Archives.2024.gmail_com.bob_user@gmail_com');
  assert.equal(destinationFor({ ...base, separator: '.', range: 'to', date, toUser: 'Jane.Doe' }), 'Archives.jane_doe');
});

test('loadConfig separates the global section from sources', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'archiveimap-')), 'config.yaml');
  writeFileSync(file, 'global:\n fulladdressdomains: [Gmail.com, "@yahoo.com"]\nhome:\n imaphost: mail.example.com\n');
  const config = loadConfig(file);
  assert.deepEqual(config.global.fullAddressDomains, ['gmail.com', 'yahoo.com']);
  assert.deepEqual(Object.keys(config.sources), ['home']);
  assert.deepEqual(resolveGlobal({}).fullAddressDomains, []);
  assert.throws(() => resolveGlobal({ fulladdressdomains: 'gmail.com' as unknown as string[] }), /must be a list/);
});
