#!/usr/bin/env node

// Advances version-set.json to a new train. The package list is the explicit,
// reviewed list already in the file (plus any --add); each version comes from
// that package's npm `latest` dist-tag. The current train moves to `previous`,
// which is the floor the drift check enforces against, so the result is a diff
// for a pull request to review, not something applied silently.
//
// Usage: node scripts/version-set-refresh.mjs --train <id> [--date YYYY-MM-DD]
//          [--add @kontourai/<name>]... [--set <file>] [--dry-run]

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import semver from 'semver';

import { DEFAULT_SET_PATH, InputError, loadVersionSet, printable, safeLine, validateVersionSet } from './version-set-drift.mjs';

export function npmLatest(name, run = execFileSync) {
  let output;
  try {
    output = run('npm', ['view', name, 'dist-tags', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new InputError(`${name}: npm view failed: ${(error.stderr || error.message).toString().trim()}`);
  }
  let tags;
  try {
    tags = JSON.parse(output);
  } catch {
    throw new InputError(`${name}: npm view returned ${JSON.stringify(output.slice(0, 200))}`);
  }
  const latest = tags?.latest;
  if (typeof latest !== 'string' || semver.valid(latest) !== latest || semver.prerelease(latest)) {
    throw new InputError(`${name}: npm latest is ${JSON.stringify(latest)}, not a stable version`);
  }
  return latest;
}

export function refreshVersionSet(current, { train, date, add = [], latest }) {
  const names = [...new Set([...Object.keys(current?.packages ?? {}), ...add])].sort();
  if (names.length === 0) throw new InputError('the set lists no packages; pass --add for each package');
  if (current && train === current.train) throw new InputError(`train ${train} is already the current train`);
  const packages = {};
  for (const name of names) {
    const version = latest(name);
    const held = current?.packages[name];
    if (held && semver.lt(version, held)) {
      throw new InputError(`${name}: npm latest ${version} is older than the set's ${held}; refusing to move the set backwards`);
    }
    packages[name] = version;
  }
  // Fields this script does not know are carried forward unchanged, so an
  // additive schema field survives a refresh.
  return validateVersionSet({
    ...current,
    schemaVersion: 1,
    train,
    date,
    packages,
    previous: current ? { train: current.train, packages: current.packages } : null,
    consumers: current?.consumers ?? [],
  }, 'refreshed set');
}

function parseArguments(argv) {
  const options = { set: DEFAULT_SET_PATH, train: null, date: new Date().toISOString().slice(0, 10), add: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const needValue = () => {
      if (value === undefined || value.startsWith('--')) throw new InputError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--train') options.train = needValue();
    else if (arg === '--date') options.date = needValue();
    else if (arg === '--set') options.set = needValue();
    else if (arg === '--add') {
      const name = needValue();
      if (!/^@kontourai\/[a-z0-9][a-z0-9._-]*$/u.test(name)) throw new InputError(`--add ${printable(name)} is not an @kontourai package name`);
      options.add.push(name);
    }
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new InputError(`unknown argument ${printable(arg)}`);
  }
  if (!options.train) throw new InputError('--train is required');
  return options;
}

export function main(argv = process.argv.slice(2), { latest = (name) => npmLatest(name), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    const current = existsSync(options.set) ? loadVersionSet(options.set) : null;
    const next = refreshVersionSet(current, { ...options, latest });
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (options.dryRun) stdout.write(text);
    else {
      writeFileSync(options.set, text);
      stdout.write(`Wrote train ${next.train} (previous: ${next.previous?.train ?? 'none'}) to ${options.set}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    stderr.write(`${safeLine(error.message)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
