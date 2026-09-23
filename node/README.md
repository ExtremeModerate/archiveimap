# archiveimap (Node.js / TypeScript)

A TypeScript port of `archiveimap.pl`. It moves IMAP messages into structured archive
folders, using the same configuration format as the Perl version. It adds **Gmail OAuth2
logins**, so Gmail works without an app password.

## Install

Requires Node.js 20+.

```sh
cd node
npm install
npm run build
npm link            # optional: puts `archiveimap` on your PATH
```

## Usage

```
archiveimap -[htvx] [-c file] imapsource ...
archiveimap --login imapsource ...

  -h, --help       Print help and list the sources in your config
  -v, --verbose    Verbose messaging
  -t, --test       SAFE mode - no changes applied (use with -v); ends by listing
                   the archive folders a real run would create
  -x, --expunge    Purge deleted items at end of each folder
  -c, --config     Use a config file other than ~/.archiveimap/config.yaml
      --login      (Re)authorize Gmail OAuth sources in a browser, then exit
      --debug      Log the IMAP protocol exchange
```

## Configuration

The configuration lives in `~/.archiveimap/config.yaml`, next to the Gmail OAuth files.
It uses the same YAML format as the Perl version's `~/.archiveimaprc`, so you can move
that file straight over:

```sh
mkdir -p ~/.archiveimap && mv ~/.archiveimaprc ~/.archiveimap/config.yaml
```

To use a file somewhere else, pass it with `-c`.

All the settings from the Perl version still work: `imaphost`, `imapssl`, `imapport`,
`auth`, `username`, `password`, `archiveroot`, `archiverange`, `sourcefolder`, `folder`,
`action`, `age`, `seen` and `ignorebaddates`. See `perldoc ../archiveimap.pl`.

New in this version:

| key | meaning |
| --- | --- |
| `auth: gmail` | Log in with Google OAuth2 (XOAUTH2). `oauth2` and `xoauth2` are accepted as aliases. `imaphost` defaults to `imap.gmail.com`, with SSL on port 993. |
| `oauthclient` | Path to the OAuth client JSON downloaded from Google Cloud. Defaults to `~/.archiveimap/google-client.json`. |
| `oauthclientid` / `oauthclientsecret` | The client credentials inline, instead of a file. You can also set the `ARCHIVEIMAP_GOOGLE_CLIENT_ID` and `ARCHIVEIMAP_GOOGLE_CLIENT_SECRET` environment variables. |

### Global settings

A top-level `global` section holds settings that apply to every source. `global` is
therefore a reserved name and can't be used as a source.

```yaml
global:
 fulladdressdomains:
  - gmail.com
  - yahoo.com
  - outlook.com
```

`fulladdressdomains` changes how `archiverange: from` names folders. Normally a message
is filed under the sender's domain, e.g. `Archives/2024/example.com`. That lumps every
sender from a shared webmail domain into one folder. For senders at a listed domain, or
any of its subdomains, the listed domain becomes a parent folder with a subfolder for
each sender address:

```
Archives/2024/gmail.com/bobuser@gmail.com
Archives/2024/gmail.com/anothersender@list.gmail.com
```

If both a domain and one of its subdomains are listed, the more specific one is used.

`@` is legal in IMAP folder names and works on Gmail, Dovecot and Exchange. If the server
refuses to create a folder containing `@` (e.g. Cyrus with virtual domains), it is
created with `_` instead: `Archives/2024/gmail.com/bobuser_gmail.com`. On servers whose folder
separator is `.`, dots in address-based names become `_` as well, so that
`bob.user@gmail.com` stays one folder rather than nesting.

### Keeping passwords in ~/.netrc

To keep passwords out of `config.yaml`, put them in `~/.netrc` and set `auth: netrc`.
`~/.netrc` is the standard credentials file also used by `ftp`, `curl` and Perl's
`Net::Netrc`, so the file you used with `archiveimap.pl` works unchanged.

1. Create `~/.netrc` with one `machine` entry per account. The `machine` name must match
   the source's `imaphost`:

   ```
   machine exchangeserver.mydomain.com
     login    kcraig
     password s3cret

   # two accounts on the same server
   machine imap.gmail.com login homeaddress@gmail.com password "abcd efgh ijkl mnop"
   machine imap.gmail.com login workaddress@gmail.com password qrstuvwxyzabcdef
   ```

   Entries can span several lines or share one. Put a value in double quotes if it
   contains spaces, as Gmail app passwords do when copied. Lines starting with `#` are
   comments.

2. Make it readable only by you:

   ```sh
   chmod 600 ~/.netrc
   ```

3. Point the source at it:

   ```yaml
   exchange:
    imaphost: exchangeserver.mydomain.com
    auth: netrc
    archiveroot: Archives
    ...

   gmail_work:
    imaphost: imap.gmail.com
    auth: netrc
    username: workaddress@gmail.com
    ...
   ```

How the lookup works:

- The first entry whose `machine` matches `imaphost` (ignoring case) is used.
- If the source sets `username`, the entry's `login` must match it exactly (case
  matters). This is how you choose between several accounts on the same server.
- If no `machine` entry matches, a `default login ... password ...` entry is used if
  there is one.
- Anything set in `config.yaml` wins: `username` and `password` there override the
  `.netrc` values. `.netrc` is consulted whenever either one is missing, whatever
  `auth` is set to (except `auth: gmail`, which uses OAuth instead).
- Run with `-v` to see the lookup (`.netrc lookup for <host> and <username>`). If nothing
  matches, the source fails with `<host> not found in .netrc`.

### Gmail setup (one time)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and
   enable the **Gmail API**.
2. Under *APIs & Services → OAuth consent screen*, configure an **External** app and add
   your Gmail address(es) as test users.
3. Under *Credentials → Create credentials → OAuth client ID*, choose **Desktop app** and
   download the JSON to `~/.archiveimap/google-client.json`.
4. Run `archiveimap --login <source>`. A browser opens so you can approve access. The
   refresh token is saved to `~/.archiveimap/tokens/<username>.json` with mode 0600.
   Sources with the same `username` share one token.

Once that's done, runs are non-interactive, which suits cron. The first time you run a
Gmail source in a terminal without a saved token, the browser login starts automatically.

> Note: Google expires refresh tokens after 7 days while the consent screen's publishing
> status is *Testing*. Set it to *In production* to keep them. For personal use you
> don't need to submit it for verification.

```yaml
gmail_personal:
 auth: gmail
 username: homeaddress@gmail.com
 archiveroot: Archives
 archiverange: year
 sourcefolder:
  - folder : INBOX
    age    : 180
    seen   : 1
    action : archive
  - folder : "[Gmail]/Spam"
    age    : ALL
    seen   : 0
    ignorebaddates : YES
    action : delete
```

App passwords also still work: use `auth: password` or `auth: netrc` with
`imaphost: imap.gmail.com` (see [Keeping passwords in ~/.netrc](#keeping-passwords-in-netrc)).

### Gmail behaviour

Gmail folders are labels, and expunging a message from a label only removes that label.
For Gmail accounts, the `delete` action moves messages to `[Gmail]/Trash`, which Google
empties after 30 days. Deleting from Trash or Spam flags the messages as deleted, and
`-x` then purges them permanently. Archiving moves the message to its archive label.

## Differences from the Perl version

- The config file is `~/.archiveimap/config.yaml` instead of `~/.archiveimaprc`.
- Messages are addressed by UID and moved in batches, one MOVE per destination folder,
  instead of one command per message. Dropped connections reconnect and retry
  automatically.
- If `seen` is omitted it defaults to `1` (only archive read messages), as the Perl
  documentation says. The Perl code actually defaulted to all messages.
- An `age` of `0` or no `age` skips the folder, as the Perl documentation says.
- `from` sorting is implemented: `root/yyyy/<sender's registrable domain>`, or
  `root/yyyy/<domain>/<sender address>` for domains listed in `global.fulladdressdomains`.
- Folder names built from addresses (`to` and `from`) never contain the server's folder
  separator; it is replaced with `_`.
- To: address matching against Received: headers ignores case.
- `auth: md5` (CRAM-MD5) isn't supported by the IMAP library, so it falls back to a normal
  login with a warning.

## Development

```sh
npm test      # compiles and runs the unit tests
```
