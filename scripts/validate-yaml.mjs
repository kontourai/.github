#!/usr/bin/env node

// Repo-owned replacement for the previous CI step that shelled out to
// python3 + PyYAML, a dependency this repository never declared anywhere
// (not in a requirements file, not pinned, not installed by `npm ci`).
// `yaml` is a pinned devDependency installed the same way every other
// dependency in this repo is: `npm ci`.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

const SKIP_DIRS = new Set(['node_modules', '.git']);

export async function findYamlFiles(root) {
  const results = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && ['.yml', '.yaml'].includes(extname(entry.name))) {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results.sort();
}

// GitHub Actions workflow files get a minimal structural check on top of
// syntax parsing, to the extent the YAML parser's own document model
// supports it: a workflow needs a top-level `on` and `jobs` mapping, and
// each job needs either `runs-on` (a normal job) or `uses` (a call to a
// reusable workflow).
function checkWorkflowStructure(path, doc) {
  const errors = [];
  const root = doc.contents;
  if (!root || typeof root.get !== 'function') {
    errors.push(`${path}: expected a top-level mapping`);
    return errors;
  }

  if (root.get('on', true) === undefined) {
    errors.push(`${path}: missing top-level "on" trigger`);
  }

  const jobs = root.get('jobs', true);
  if (jobs === undefined || typeof jobs.get !== 'function') {
    errors.push(`${path}: missing top-level "jobs" mapping`);
    return errors;
  }

  for (const jobPair of jobs.items ?? []) {
    const jobName = String(jobPair.key);
    const job = jobPair.value;
    if (!job || typeof job.get !== 'function') {
      errors.push(`${path}: job "${jobName}" is not a mapping`);
      continue;
    }
    const hasRunsOn = job.get('runs-on', true) !== undefined;
    const hasUses = job.get('uses', true) !== undefined;
    if (!hasRunsOn && !hasUses) {
      errors.push(`${path}: job "${jobName}" has neither "runs-on" nor "uses"`);
    }
  }

  return errors;
}

export async function validateYamlFiles(root) {
  const files = await findYamlFiles(root);
  const errors = [];

  for (const path of files) {
    const relPath = relative(root, path);
    const text = await readFile(path, 'utf8');

    let docs;
    try {
      docs = parseAllDocuments(text, { strict: true, uniqueKeys: true });
    } catch (err) {
      errors.push(`${relPath}: ${err.message}`);
      continue;
    }

    for (const doc of docs) {
      for (const err of doc.errors) {
        errors.push(`${relPath}: ${err.message}`);
      }
      for (const warning of doc.warnings) {
        errors.push(`${relPath}: ${warning.message}`);
      }

      if (doc.errors.length === 0 && relPath.startsWith('.github/workflows/')) {
        errors.push(...checkWorkflowStructure(relPath, doc));
      }
    }
  }

  return errors;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const errors = await validateYamlFiles(root);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log('YAML syntax and workflow structure OK');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
