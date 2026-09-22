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
  -t, --test       SAFE mode - no changes applied (use with -v)
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
`imaphost: imap.gmail.com`.

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
- `from` sorting is implemented: `root/yyyy/<sender's registrable domain>`.
- To: address matching against Received: headers ignores case.
- `auth: md5` (CRAM-MD5) isn't supported by the IMAP library, so it falls back to a normal
  login with a warning.

## Development

```sh
npm test      # compiles and runs the unit tests
```
