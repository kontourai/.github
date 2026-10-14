#!/usr/bin/env node

// Reports where a consumer's @kontourai/* dependency specs drift from the
// version set in version-set.json, the tested set the compatibility train
// advances by pull request.
//
// By default the check is advisory: it exits 0 whatever it finds.
// --fail-on stale fails only on a STALE spec, one that admits nothing as new as
// the previous train's compatibility floor (its major, or its minor for 0.x).
// Two guarantees follow. A consumer that was current when a train landed is
// never failed by the next train, so advancing the set never turns a current
// consumer red. And patch- or minor-only trains never stale an exact pin: a
// spec goes stale only once a breaking release has moved past it and a further
// train has elapsed. This is the mode a gate would use.
// --fail-on drift fails on any spec that does not admit the set's version
// (behind, stale, ahead or unrecognized). It answers "is every consumer on
// the train?" for a one-off audit and is not meant for a gate.
//
// Exit status: 0 reported with nothing failing, 1 a spec matched --fail-on,
// 2 the set, a manifest or the arguments could not be read.

import { execFileSync } from 'node:child_process';
import { appendFileSync, globSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import semver from 'semver';
import { parse as parseYaml } from 'yaml';

export const DEFAULT_SET_PATH = fileURLToPath(new URL('../version-set.json', import.meta.url));
export const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
]);
export const STATUSES = Object.freeze(['current', 'behind', 'stale', 'ahead', 'unrecognized', 'untracked']);
// Statuses each --fail-on mode fails on. `untracked` names a package outside
// the set, so no mode fails on it.
export const FAIL_ON = Object.freeze({
  none: Object.freeze([]),
  stale: Object.freeze(['stale']),
  drift: Object.freeze(['behind', 'stale', 'ahead', 'unrecognized']),
});

const PACKAGE_NAME = /^@kontourai\/[a-z0-9][a-z0-9._-]*$/u;
const TRAIN_ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CONSUMER = /^kontourai\/[A-Za-z0-9_.-]+$/u;
const LOCAL_SPEC = /^(file|link|workspace|portal):/u;

export class InputError extends Error {}

function validatePackages(packages, where) {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new InputError(`${where}: "packages" must be an object of package name to version`);
  }
  for (const [name, version] of Object.entries(packages)) {
    if (!PACKAGE_NAME.test(name)) throw new InputError(`${where}: "${name}" is not an @kontourai package name`);
    if (typeof version !== 'string' || semver.valid(version) !== version || semver.prerelease(version)) {
      throw new InputError(`${where}: ${name} must be an exact stable version, got ${JSON.stringify(version)}`);
    }
  }
}

export function validateVersionSet(set, where = 'version set') {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new InputError(`${where}: expected an object`);
  // schemaVersion is the compatibility gate: a breaking change to the set's
  // shape bumps it, and older pinned scripts refuse the file. Additive fields
  // keep schemaVersion 1 and are ignored here, so adding one never makes an
  // older pinned script exit 2.
  if (set.schemaVersion !== 1) throw new InputError(`${where}: schemaVersion must be 1`);
  if (typeof set.train !== 'string' || !TRAIN_ID.test(set.train)) throw new InputError(`${where}: "train" must be a train id`);
  if (typeof set.date !== 'string' || !ISO_DATE.test(set.date)) throw new InputError(`${where}: "date" must be YYYY-MM-DD`);
  validatePackages(set.packages, where);
  if (set.previous !== null) {
    if (!set.previous || typeof set.previous !== 'object' || Array.isArray(set.previous)) {
      throw new InputError(`${where}: "previous" must be null or { train, packages }`);
    }
    if (typeof set.previous.train !== 'string' || !TRAIN_ID.test(set.previous.train)) {
      throw new InputError(`${where}: "previous.train" must be a train id`);
    }
    if (set.previous.train === set.train) throw new InputError(`${where}: previous train repeats the current train id`);
    validatePackages(set.previous.packages, `${where} previous`);
  }
  if (!Array.isArray(set.consumers) || set.consumers.some((c) => typeof c !== 'string' || !CONSUMER.test(c))) {
    throw new InputError(`${where}: "consumers" must list kontourai/<repository> names`);
  }
  if (new Set(set.consumers).size !== set.consumers.length) throw new InputError(`${where}: "consumers" repeats a repository`);
  return set;
}

export function loadVersionSet(path = DEFAULT_SET_PATH) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new InputError(`${path}: ${error.message}`);
  }
  let set;
  try {
    set = JSON.parse(text);
  } catch {
    throw new InputError(`${path}: not valid JSON`);
  }
  return validateVersionSet(set, path);
}

// The lowest version semver-compatible with `version`: x.0.0, or 0.y.0 for
// 0.x, where each minor is breaking (0.0.z for 0.0.x, where each patch is).
export function compatibilityFloor(version) {
  const { major, minor, patch } = semver.parse(version);
  if (major > 0) return `${major}.0.0`;
  if (minor > 0) return `0.${minor}.0`;
  return `0.0.${patch}`;
}

// Classifies one dependency spec against the set:
// - current: admits the set's version;
// - ahead: admits only versions newer than the set's;
// - stale: admits only versions older than the previous train's compatibility
//   floor, so the consumer has fallen a breaking release behind the previous
//   train;
// - behind: anything else that misses the set's version, including every miss
//   for a package that has no previous train yet. This is the headroom.
export function classifySpec(spec, version, previousVersion) {
  if (semver.validRange(spec) === null) return 'unrecognized';
  if (semver.satisfies(version, spec)) return 'current';
  if (semver.ltr(version, spec)) return 'ahead';
  if (previousVersion !== undefined && semver.gtr(compatibilityFloor(previousVersion), spec)) return 'stale';
  return 'behind';
}

// Every read stays inside the checkout. The root is resolved once; a file
// that is a symlink, or whose real path leaves the root (through a symlinked
// directory, for example), is refused rather than read. Parse errors never
// echo file content.
function confinedFile(root, path) {
  const absolute = join(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) throw new InputError(`${path}: is a symlink; refusing to follow it`);
  const real = realpathSync(absolute);
  if (!real.startsWith(`${root}${sep}`)) throw new InputError(`${path}: resolves outside the checkout`);
  if (!stat.isFile()) throw new InputError(`${path}: is not a file`);
  return real;
}

function readManifest(root, path) {
  const real = confinedFile(root, path);
  if (real === null) throw new InputError(`${path}: missing`);
  try {
    return JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    throw new InputError(`${path}: not valid JSON`);
  }
}

function workspacePatterns(root, rootManifest) {
  const patterns = [];
  const { workspaces } = rootManifest;
  if (Array.isArray(workspaces)) patterns.push(...workspaces);
  else if (workspaces && Array.isArray(workspaces.packages)) patterns.push(...workspaces.packages);
  const pnpmWorkspace = confinedFile(root, 'pnpm-workspace.yaml');
  if (pnpmWorkspace !== null) {
    let document;
    try {
      document = parseYaml(readFileSync(pnpmWorkspace, 'utf8'));
    } catch {
      throw new InputError('pnpm-workspace.yaml: not valid YAML');
    }
    if (Array.isArray(document?.packages)) patterns.push(...document.packages);
  }
  const strings = patterns.filter((pattern) => typeof pattern === 'string');
  for (const pattern of strings) {
    const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (isAbsolute(body) || body.split(/[\\/]/u).includes('..')) {
      throw new InputError(`workspace pattern ${JSON.stringify(pattern)} leaves the checkout`);
    }
  }
  return strings;
}

function expandWorkspaces(root, patterns) {
  const matched = new Set();
  const excluded = new Set();
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const target = negated ? excluded : matched;
    for (const entry of globSync(negated ? pattern.slice(1) : pattern, { cwd: root })) {
      const dir = entry.replace(/\/+$/u, '');
      if (dir.split('/').includes('node_modules')) continue;
      target.add(dir);
    }
  }
  return [...matched]
    .filter((dir) => !excluded.has(dir))
    .filter((dir) => statSync(join(root, dir), { throwIfNoEntry: false })?.isDirectory())
    .filter((dir) => confinedFile(root, join(dir, 'package.json')) !== null)
    .sort();
}

// The root manifest plus every workspace that is published (not private).
// Private workspaces such as examples may pin old versions on purpose. Specs
// naming a package that lives in the same repository are intra-repo links,
// not train drift, so they are skipped like file:/workspace: specs.
export function collectManifests(checkout) {
  let root;
  try {
    root = realpathSync(checkout);
  } catch {
    throw new InputError(`${checkout}: no such directory`);
  }
  if (confinedFile(root, 'package.json') === null) throw new InputError(`${checkout}: no package.json`);
  const rootManifest = readManifest(root, 'package.json');
  const workspaces = expandWorkspaces(root, workspacePatterns(root, rootManifest)).map((dir) => {
    const path = join(dir, 'package.json');
    return { path, manifest: readManifest(root, path) };
  });
  const localNames = new Set([rootManifest.name, ...workspaces.map((w) => w.manifest.name)].filter(Boolean));
  const scanned = [{ path: 'package.json', manifest: rootManifest }, ...workspaces.filter((w) => w.manifest.private !== true)];
  return { manifests: scanned, localNames };
}

export function checkRepository(root, set, label = basename(resolve(root))) {
  const { manifests, localNames } = collectManifests(root);
  const findings = [];
  for (const { path, manifest } of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (!name.startsWith('@kontourai/') || localNames.has(name)) continue;
        if (!PACKAGE_NAME.test(name)) throw new InputError(`${label} ${path}: ${section} names an invalid package ${JSON.stringify(name)}`);
        if (typeof spec !== 'string') throw new InputError(`${label} ${path}: ${section}.${name} is not a string`);
        if (LOCAL_SPEC.test(spec)) continue;
        const version = set.packages[name];
        const previousVersion = set.previous?.packages[name];
        const status = version === undefined ? 'untracked' : classifySpec(spec, version, previousVersion);
        findings.push({ repository: label, manifest: path, section, package: name, spec, version: version ?? null, previousVersion: previousVersion ?? null, status });
      }
    }
  }
  return findings;
}

// The environment without the variables that point git at a particular
// repository. Inside a git hook GIT_DIR names the hook's repository, and a
// clone or checkout run with it would write there instead of the scratch dir.
export function isolatedGitEnvironment(env = process.env) {
  const local = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', cwd: tmpdir(), env: { PATH: env.PATH } })
    .split('\n').filter(Boolean);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !local.includes(key)));
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: isolatedGitEnvironment(), ...options });
}

// Shallow, sparse clone that holds only package manifests and the pnpm
// workspace file, which is all the drift check reads.
export function cloneManifests(repository, destination, gitBase) {
  git(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', `${gitBase}${repository}.git`, destination]);
  git(['-C', destination, 'sparse-checkout', 'set', '--no-cone', 'package.json', 'pnpm-workspace.yaml']);
  git(['-C', destination, 'checkout', '--quiet']);
}

export function summarize(findings) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const finding of findings) counts[finding.status] += 1;
  return counts;
}

function modeLine(failOn) {
  if (failOn === 'none') return 'Advisory: drift is reported, not enforced.';
  return `Failing on: ${FAIL_ON[failOn].join(', ')}.`;
}

function describeSet(set) {
  return `Version set ${set.train} (${set.date}); previous train: ${set.previous ? set.previous.train : 'none'}`;
}

// Printable ASCII passes through; anything else (a newline that could start a
// workflow command, a terminal escape) is shown JSON-quoted.
function printable(value) {
  const text = String(value);
  return /^[\x20-\x7e]*$/u.test(text) ? text : JSON.stringify(text);
}

// Escapes Markdown and table syntax so manifest text renders as text.
export function markdownText(value) {
  return printable(value).replace(/[\\`*_~[\]<>|]/gu, (ch) => `\\${ch}`);
}

export function formatText(set, results, failOn = 'none') {
  const lines = [describeSet(set)];
  for (const { repository, findings } of results) {
    const counts = summarize(findings);
    lines.push(`${repository}: ${findings.length} @kontourai specs; ${STATUSES.map((s) => `${counts[s]} ${s}`).join(', ')}`);
    for (const f of findings) {
      if (f.status === 'current') continue;
      const target = f.version ? ` (set ${f.version}${f.previousVersion ? `, previous ${f.previousVersion}` : ''})` : ' (not in the set)';
      lines.push(`  ${f.status.toUpperCase().padEnd(12)} ${printable(f.manifest)} ${f.section} ${f.package} ${printable(f.spec)}${target}`);
    }
  }
  lines.push(modeLine(failOn));
  return `${lines.join('\n')}\n`;
}

export function formatMarkdown(set, results, failOn = 'none') {
  const lines = [`### ${describeSet(set)}`, '', modeLine(failOn), ''];
  for (const { repository, findings } of results) {
    const counts = summarize(findings);
    lines.push(`**${markdownText(repository)}**: ${STATUSES.map((s) => `${counts[s]} ${s}`).join(', ')}`, '');
    const drift = findings.filter((f) => f.status !== 'current');
    if (drift.length === 0) continue;
    lines.push('| Status | Manifest | Section | Package | Spec | Set | Previous |', '|---|---|---|---|---|---|---|');
    for (const f of drift) {
      lines.push(`| ${f.status} | ${markdownText(f.manifest)} | ${f.section} | ${markdownText(f.package)} | ${markdownText(f.spec)} | ${f.version ?? 'not in set'} | ${f.previousVersion ?? '-'} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = `Usage: node scripts/version-set-drift.mjs [--set <file>] [--fail-on none|stale|drift] [--json]
         [--markdown-summary <file>] (--all [--git-base <url>] | [--label <name>] <dir>...)
`;

export function parseArguments(argv) {
  const options = { set: DEFAULT_SET_PATH, failOn: 'none', json: false, all: false, gitBase: 'https://github.com/', label: null, summary: null, dirs: [] };
  const valueFlags = { '--fail-on': 'failOn', '--set': 'set', '--git-base': 'gitBase', '--label': 'label', '--markdown-summary': 'summary' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in valueFlags) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError(`${arg} needs a value`);
      options[valueFlags[arg]] = value;
      i += 1;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--all') options.all = true;
    else if (arg.startsWith('--')) throw new InputError(`unknown option ${arg}`);
    else options.dirs.push(arg);
  }
  if (!Object.hasOwn(FAIL_ON, options.failOn)) throw new InputError(`--fail-on must be one of ${Object.keys(FAIL_ON).join(', ')}`);
  if (options.all === (options.dirs.length > 0)) throw new InputError('give either --all or one or more directories');
  if (options.label !== null && options.dirs.length !== 1) throw new InputError('--label names exactly one directory');
  return options;
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  let set;
  try {
    options = parseArguments(argv);
    set = loadVersionSet(options.set);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  const results = [];
  let scratch = null;
  try {
    if (options.all) {
      scratch = mkdtempSync(join(tmpdir(), 'version-set-drift-'));
      for (const repository of set.consumers) {
        const destination = join(scratch, repository.replace('/', '__'));
        try {
          cloneManifests(repository, destination, options.gitBase);
        } catch (error) {
          throw new InputError(`${repository}: clone failed: ${(error.stderr || error.message).toString().trim()}`);
        }
        results.push({ repository, findings: checkRepository(destination, set, repository) });
      }
    } else {
      for (const dir of options.dirs) {
        const label = options.label ?? basename(resolve(dir));
        results.push({ repository: label, findings: checkRepository(dir, set, label) });
      }
    }
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    stderr.write(`${error.message}\n`);
    return 2;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  stdout.write(options.json
    ? `${JSON.stringify({ train: set.train, previousTrain: set.previous?.train ?? null, failOn: options.failOn, results }, null, 2)}\n`
    : formatText(set, results, options.failOn));
  if (options.summary) appendFileSync(options.summary, formatMarkdown(set, results, options.failOn));
  const failing = results.flatMap((r) => r.findings).filter((f) => FAIL_ON[options.failOn].includes(f.status));
  return failing.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
