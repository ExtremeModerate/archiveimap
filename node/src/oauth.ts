import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { stateDir, type Source } from './config.js';

/** Full IMAP access; Gmail's IMAP server accepts no narrower scope. */
const GMAIL_SCOPE = 'https://mail.google.com/';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const defaultClientFile = () => join(stateDir(), 'google-client.json');
const tokenFile = (username: string) =>
  join(stateDir(), 'tokens', `${username.toLowerCase().replace(/[^a-z0-9@._-]/g, '_')}.json`);

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Finds the OAuth "Desktop app" client credentials, in order of preference: inline
 * oauthclientid/oauthclientsecret, the oauthclient JSON file, environment variables,
 * then ~/.archiveimap/google-client.json.
 */
function clientCredentials(source: Source): ClientCredentials {
  const { clientId, clientSecret, clientFile } = source.oauth;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const envId = process.env.ARCHIVEIMAP_GOOGLE_CLIENT_ID;
  const envSecret = process.env.ARCHIVEIMAP_GOOGLE_CLIENT_SECRET;
  const file = clientFile ?? (envId && envSecret ? undefined : defaultClientFile());
  if (file) {
    if (!existsSync(file)) {
      throw new Error(
        `Google OAuth client file ${file} not found. Create a "Desktop app" OAuth client in the ` +
          'Google Cloud console and download its JSON there (see README).',
      );
    }
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const c = json.installed ?? json.web ?? json;
    if (!c.client_id || !c.client_secret) throw new Error(`${file} has no client_id/client_secret`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  return { clientId: envId!, clientSecret: envSecret! };
}

function loadTokens(username: string): Credentials | undefined {
  try {
    return JSON.parse(readFileSync(tokenFile(username), 'utf8')) as Credentials;
  } catch {
    return undefined;
  }
}

function saveTokens(username: string, tokens: Credentials) {
  const file = tokenFile(username);
  mkdirSync(join(stateDir(), 'tokens'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // the URL is printed as well, so a missing opener is fine
  }
}

/** Runs the installed-app authorization code flow with PKCE and a loopback redirect. */
async function interactiveLogin(creds: ClientCredentials, username: string): Promise<Credentials> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const client = new OAuth2Client({ ...creds, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(16).toString('hex');
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // always hand back a refresh token
      scope: [GMAIL_SCOPE],
      login_hint: username,
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
    });

    console.log(`\nAuthorize archiveimap to access ${username} by opening:\n\n  ${url}\n`);
    openBrowser(url);

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Google authorization')), LOGIN_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const params = new URL(req.url ?? '/', redirectUri).searchParams;
        if (!params.has('code') && !params.has('error')) {
          res.writeHead(404).end();
          return;
        }
        const ok = params.get('state') === state && params.has('code');
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' });
        res.end(ok ? 'archiveimap is authorized. You can close this window.' : 'Authorization failed.');
        clearTimeout(timer);
        if (ok) resolve(params.get('code')!);
        else reject(new Error(`Google authorization failed: ${params.get('error') ?? 'state mismatch'}`));
      });
    });

    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
    return tokens;
  } finally {
    server.close();
  }
}

export interface OAuthOptions {
  /** Discard any saved token and log in again */
  forceLogin?: boolean;
  /** Allow opening a browser when no usable token exists */
  interactive: boolean;
}

/**
 * Returns a function yielding a fresh Gmail access token for the source's account,
 * refreshing it as needed.  Tokens are cached per username in ~/.archiveimap/tokens.
 */
export async function gmailTokenProvider(source: Source, opts: OAuthOptions): Promise<() => Promise<string>> {
  const username = source.username;
  if (!username) throw new Error('username (the Gmail address) is required for auth: gmail');
  const creds = clientCredentials(source);

  let tokens = opts.forceLogin ? undefined : loadTokens(username);
  if (!tokens?.refresh_token) {
    if (!opts.interactive) {
      throw new Error(`No saved Google authorization for ${username}. Run: archiveimap --login ${source.name}`);
    }
    tokens = await interactiveLogin(creds, username);
    saveTokens(username, tokens);
    console.log(`Saved Google authorization for ${username}`);
  }

  const client = new OAuth2Client(creds);
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    // Google omits refresh_token on refresh responses; keep the one we have
    tokens = { ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens!.refresh_token };
    saveTokens(username, tokens);
  });

  return async () => {
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('empty access token');
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not refresh Google access token for ${username} (${msg}). ` +
          `Re-authorize with: archiveimap --login ${source.name}`,
      );
    }
  };
}
