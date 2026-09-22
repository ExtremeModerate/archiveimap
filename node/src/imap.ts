import { ImapFlow, type AuthOptions } from 'imapflow';
import type { Source } from './config.js';
import { lookupNetrc } from './netrc.js';
import { gmailTokenProvider, type OAuthOptions } from './oauth.js';

export type Log = (msg: string) => void;

/**
 * Builds a function producing IMAP credentials for a source.  It's a function (rather
 * than a value) so reconnects pick up a freshly refreshed OAuth access token.
 */
export async function credentialsFor(source: Source, oauth: OAuthOptions, verbose: Log): Promise<() => Promise<AuthOptions>> {
  if (source.auth === 'oauth2') {
    const user = source.username!;
    const token = await gmailTokenProvider(source, oauth);
    return async () => ({ user, accessToken: await token() });
  }

  if (source.auth === 'md5' || source.auth === 'cert') {
    console.error(`WARNING: auth=${source.auth} is not supported, using a regular login for ${source.name}`);
  }

  let user = source.username;
  let pass = source.password;
  if (!(user && pass)) {
    verbose(`.netrc lookup for ${source.host} and ${user ?? ''}`);
    const entry = lookupNetrc(source.host, user);
    if (!entry) throw new Error(`${source.host} not found in .netrc`);
    user ||= entry.login;
    pass ||= entry.password;
  }
  if (!(user && pass)) throw new Error(`I don't seem to have a username/password for ${source.name}`);
  const auth = { user, pass };
  return async () => auth;
}

/** An IMAP connection that transparently reconnects (and reselects its folder) when dropped. */
export class ImapSession {
  client!: ImapFlow;
  private selected?: string;

  constructor(
    private readonly source: Source,
    private readonly auth: () => Promise<AuthOptions>,
    readonly verbose: Log,
    private readonly debug = false,
  ) {}

  async connect(): Promise<void> {
    const client = new ImapFlow({
      host: this.source.host,
      port: this.source.port,
      secure: this.source.secure,
      auth: await this.auth(),
      logger: this.debug ? undefined : false,
      disableAutoIdle: true,
    });
    // without a listener, a dropped socket would crash the process
    client.on('error', (err: Error) => this.verbose(`IMAP connection error: ${err.message}`));
    await client.connect();
    this.client = client;
    if (this.selected) await client.mailboxOpen(this.selected);
  }

  get isGmail(): boolean {
    return this.client.capabilities.has('X-GM-EXT-1') || this.source.gmail;
  }

  async select(folder: string): Promise<void> {
    this.selected = undefined;
    await this.run(() => this.client.mailboxOpen(folder));
    this.selected = folder;
  }

  /** Runs an IMAP operation, reconnecting and retrying once if the connection has dropped. */
  async run<T>(op: () => Promise<T>): Promise<T> {
    if (!this.client.usable) {
      this.verbose('Reconnecting');
      await this.connect();
    }
    try {
      return await op();
    } catch (err) {
      if (this.client.usable) throw err;
      this.verbose('Connection lost, reconnecting');
      await this.connect();
      return await op();
    }
  }

  async logout(): Promise<void> {
    if (this.client?.usable) await this.client.logout();
    else this.client?.close();
  }
}
