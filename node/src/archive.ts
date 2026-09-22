import type { FetchMessageObject } from 'imapflow';
import { resolveFolderRule, type FolderRule, type GlobalConfig, type RawSource, type Source } from './config.js';
import type { ImapSession, Log } from './imap.js';
import { dateParts, deliveredTo, destinationFor, fromFolderName, headerValues, userPart } from './message.js';

const DAY_MS = 86400_000;
const FETCH_BATCH = 500;

export interface RunOptions {
  dryRun: boolean;
  /** In dry-run mode, collects the folders that a real run would create */
  wouldCreate: Set<string>;
  global: GlobalConfig;
  expunge: boolean;
  verbose: Log;
  warn: Log;
}

interface FolderContext {
  separator: string;
  mailboxes: Set<string>;
  /** Archive folders the server refused, mapped to the name used instead */
  renamed: Map<string, string>;
  trash?: string;
  junk?: string;
}

export async function archiveSource(session: ImapSession, source: Source, raw: RawSource, opts: RunOptions): Promise<void> {
  const { verbose } = opts;
  const list = await session.run(() => session.client.list());
  verbose(`Available Folders:\n${list.map((m) => m.path).join('\n')}`);

  const separator = list.find((m) => m.path.toUpperCase() === 'INBOX')?.delimiter ?? list[0]?.delimiter;
  if (!separator) throw new Error('Could not get folder separator');
  verbose(`The folder separator is ${separator}`);

  const ctx: FolderContext = {
    separator,
    mailboxes: new Set(list.map((m) => m.path)),
    renamed: new Map(),
    trash: list.find((m) => m.specialUse === '\\Trash')?.path,
    junk: list.find((m) => m.specialUse === '\\Junk')?.path,
  };

  for (const rawRule of source.rawFolders) {
    let rule: FolderRule;
    try {
      rule = resolveFolderRule(rawRule, raw);
    } catch (err) {
      opts.warn(`ERROR: ${(err as Error).message}. Skipping folder ${rawRule.folder ?? 'INBOX'}.`);
      continue;
    }
    try {
      await session.select(rule.folder);
    } catch (err) {
      opts.warn(`ERROR: cannot select the folder ${rule.folder}: ${(err as Error).message}`);
      continue;
    }
    await archiveFolder(session, source, rule, ctx, opts);
  }
}

async function archiveFolder(session: ImapSession, source: Source, rule: FolderRule, ctx: FolderContext, opts: RunOptions) {
  const { verbose, warn } = opts;
  const { folder } = rule;
  const now = new Date();
  // Gmail only truly deletes from Trash/Spam; elsewhere EXPUNGE just removes a label
  const gmailTrash = session.isGmail && folder !== ctx.trash && folder !== ctx.junk ? ctx.trash : undefined;

  verbose(`I will ${rule.action} items in folder ${folder}.`);
  if (rule.ignoreBadDates) verbose(`Ignoring bad dates for ${folder}`);
  if (rule.action === 'delete' && gmailTrash) verbose(`Gmail: deleted items will be moved to ${gmailTrash}`);

  const cutoff = rule.age === 'ALL' ? new Date(now.getTime() + DAY_MS) : new Date(now.getTime() - rule.age * DAY_MS);
  verbose(rule.age === 'ALL' ? 'ALL messages selected.' : `Age for ${folder} is ${rule.age} days, ${cutoff.toDateString()}`);
  verbose(`Searching ${folder} for ${rule.seenOnly ? 'READ' : 'ALL'} messages sent before ${cutoff.toDateString()}`);

  const uids =
    (await session.run(() =>
      session.client.search({ deleted: false, sentBefore: cutoff, ...(rule.seenOnly ? { seen: true } : {}) }, { uid: true }),
    )) || [];
  verbose(`Search found ${uids.length} items`);

  let processed = 0;
  try {
    for (let i = 0; i < uids.length; i += FETCH_BATCH) {
      const batch = uids.slice(i, i + FETCH_BATCH);
      const messages = await session.run(() =>
        session.client.fetchAll(
          batch.join(','),
          { uid: true, envelope: true, ...(rule.archiveRange === 'to' ? { headers: ['received'] } : {}) },
          { uid: true },
        ),
      );

      // group by destination so each folder gets one MOVE per batch
      const plan = new Map<string, number[]>();
      for (const msg of messages) {
        const dest = planMessage(msg, source, rule, ctx, cutoff, now, opts);
        if (dest === undefined) continue;
        plan.set(dest, [...(plan.get(dest) ?? []), msg.uid]);
      }

      for (const [dest, group] of plan) {
        if (!opts.dryRun) await apply(session, rule, ctx, dest, group, gmailTrash);
        else if (rule.action === 'archive') noteWouldCreate(ctx, dest, opts.wouldCreate);
        processed += group.length;
      }
    }
  } catch (err) {
    warn(`ERROR: ${rule.action} failed in ${folder}: ${(err as Error).message}`);
  }

  console.log(`Folder ${folder}: ${rule.action === 'delete' ? 'deleted' : 'moved'} ${processed} out of ${uids.length}`);

  if (!opts.expunge) {
    console.log(`Retaining deleted items in folder ${folder}.`);
    return;
  }
  console.log(`Expunging deleted items from folder ${folder}.`);
  if (opts.dryRun) return;
  const deleted = (await session.run(() => session.client.search({ deleted: true }, { uid: true }))) || [];
  if (deleted.length) await session.run(() => session.client.messageDelete(deleted.join(','), { uid: true }));
}

/** Records `dest` and any missing parent folders, since creating it creates them too. */
function noteWouldCreate(ctx: FolderContext, dest: string, wouldCreate: Set<string>) {
  const parts = dest.split(ctx.separator);
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join(ctx.separator);
    if (!ctx.mailboxes.has(path)) wouldCreate.add(path);
  }
}

/** Decides where one message goes; undefined means leave it alone. */
function planMessage(
  msg: FetchMessageObject,
  source: Source,
  rule: FolderRule,
  ctx: FolderContext,
  cutoff: Date,
  now: Date,
  { verbose, global }: RunOptions,
): string | undefined {
  const env = msg.envelope ?? {};
  const subject = env.subject ?? '';
  const sent = env.date ? new Date(env.date) : undefined;
  const parts = dateParts(sent, now);
  if (!parts.year) verbose(`WARNING: Message ${msg.uid} has a missing or out of range date (${env.date ?? 'none'})\n\tSUBJECT: ${subject}`);

  const toAddrs = (env.to ?? []).map((a) => a.address ?? '').filter(Boolean);
  const toAddress = deliveredTo(toAddrs, headerValues(msg.headers, 'received'));
  const fromAddress = env.from?.[0]?.address;
  const fromName = fromFolderName(fromAddress, global.fullAddressDomains);
  verbose(`To: ${toAddress}  From: ${fromAddress ?? ''} (${fromName ?? ''})`);

  let dest: string | undefined;
  if (rule.action === 'archive') {
    dest = destinationFor({
      range: rule.archiveRange,
      root: source.archiveRoot,
      separator: ctx.separator,
      folder: rule.folder,
      date: parts,
      toUser: userPart(toAddress),
      fromName,
      ignoreBadDates: rule.ignoreBadDates,
    });
  } else {
    dest = parts.year || rule.ignoreBadDates ? '' : undefined;
  }
  if (dest === undefined) {
    verbose('WARNING: Skipping the bad date.');
    return undefined;
  }

  const valid = sent && !Number.isNaN(sent.getTime());
  if (valid && sent >= cutoff && !rule.ignoreBadDates) {
    verbose(`Keeping ${env.date} newer than ${cutoff.toDateString()}`);
    return undefined;
  }

  verbose(rule.action === 'archive' ? `Moving ${msg.uid}, ${env.date} to ${dest}` : `Deleting ${msg.uid}, ${subject}`);
  return dest;
}

async function apply(session: ImapSession, rule: FolderRule, ctx: FolderContext, dest: string, uids: number[], gmailTrash?: string) {
  const range = uids.join(',');

  if (rule.action === 'delete') {
    const ok = gmailTrash
      ? await session.run(() => session.client.messageMove(range, gmailTrash, { uid: true }))
      : await session.run(() => session.client.messageFlagsAdd(range, ['\\Deleted'], { uid: true }));
    if (!ok) throw new Error(`could not delete messages ${range}`);
    return;
  }

  const target = await ensureMailbox(session, ctx, ctx.renamed.get(dest) ?? dest);
  if (target !== dest) ctx.renamed.set(dest, target);
  const ok = await session.run(() => session.client.messageMove(range, target, { uid: true }));
  if (!ok) throw new Error(`could not move messages to ${target}`);
}

/**
 * Creates an archive folder if needed and returns the name to use.  Some servers (e.g.
 * Cyrus with virtual domains) reject '@' in folder names; those get '_' instead.
 */
async function ensureMailbox(session: ImapSession, ctx: FolderContext, path: string): Promise<string> {
  if (ctx.mailboxes.has(path)) return path;
  try {
    // imapflow treats ALREADYEXISTS as success, so a failure here is a real refusal
    await session.run(() => session.client.mailboxCreate(path.split(ctx.separator)));
  } catch (err) {
    const alt = path.replaceAll('@', '_');
    if (alt !== path) {
      session.verbose(`Server refused ${path} (${(err as Error).message}), using ${alt}`);
      return ensureMailbox(session, ctx, alt);
    }
    // the MOVE will report anything that really matters
    session.verbose(`Could not create ${path}: ${(err as Error).message}`);
  }
  ctx.mailboxes.add(path);
  return path;
}
