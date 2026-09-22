#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { archiveSource } from './archive.js';
import { defaultConfigPath, loadConfig, resolveSource, type RawConfig } from './config.js';
import { credentialsFor, ImapSession } from './imap.js';

const USAGE = `Usage: archiveimap -[htvx] [--config file] imapsource ...
       archiveimap --login imapsource ...

Moves IMAP hosted messages to structured archive folders, per the sources
defined in ~/.archiveimaprc.

  -h, --help       Print this help message
  -v, --verbose    Use verbose messaging during execution
  -t, --test       SAFE mode - no changes applied. Usually used with -v
  -x, --expunge    Purge deleted items at end of run
  -c, --config     Use a configuration file other than ~/.archiveimaprc
      --login      (Re)authorize Gmail OAuth sources in a browser, then exit
      --debug      Log the IMAP protocol exchange`;

async function main(): Promise<number> {
  const { values: opt, positionals: sources } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      verbose: { type: 'boolean', short: 'v' },
      test: { type: 'boolean', short: 't' },
      expunge: { type: 'boolean', short: 'x' },
      config: { type: 'string', short: 'c' },
      login: { type: 'boolean' },
      debug: { type: 'boolean' },
    },
  });

  const configPath = opt.config ?? defaultConfigPath();
  let config: RawConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`ERROR: cannot read ${configPath}: ${(err as Error).message}`);
    return 1;
  }

  if (opt.help || sources.length === 0) {
    console.log(`${USAGE}\n\nYour ${configPath} file contains the following sources:\n\t${Object.keys(config).join('\n\t')}`);
    return opt.help ? 0 : 1;
  }

  const verbose = opt.verbose ? (msg: string) => console.log(msg) : () => {};
  const warn = (msg: string) => console.error(msg);
  if (opt.test) console.log('---------- SAFE MODE ----------');

  let failures = 0;
  for (const name of sources) {
    const raw = config[name];
    if (!raw) {
      warn(`ERROR: ${name} is not defined in ${configPath}`);
      failures++;
      continue;
    }

    let session: ImapSession | undefined;
    try {
      const source = resolveSource(name, raw);
      if (opt.login) {
        if (source.auth !== 'oauth2') {
          console.log(`${name} does not use Gmail OAuth, nothing to authorize`);
          continue;
        }
        await credentialsFor(source, { interactive: true, forceLogin: true }, verbose);
        continue;
      }

      console.log(`Processing ${name}`);
      const auth = await credentialsFor(source, { interactive: Boolean(process.stdin.isTTY) }, verbose);
      session = new ImapSession(source, auth, verbose, opt.debug);
      await session.connect();
      await archiveSource(session, source, raw, {
        dryRun: Boolean(opt.test),
        expunge: Boolean(opt.expunge),
        verbose,
        warn,
      });
    } catch (err) {
      warn(`ERROR: ${name}: ${(err as Error).message}`);
      failures++;
    } finally {
      await session?.logout().catch(() => {});
    }
  }
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
