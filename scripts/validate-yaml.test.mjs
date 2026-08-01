import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateYamlFiles } from './validate-yaml.mjs';

async function withTempRepo(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'validate-yaml-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, contents);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('valid workflow and plain YAML files produce no errors', async () => {
  await withTempRepo(
    {
      '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
      '.github/workflows/reusable.yml': 'on:\n  workflow_call:\njobs:\n  build:\n    uses: org/repo/.github/workflows/other.yml@main\n',
      'profile/README.md.yml': 'key: value\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.deepEqual(errors, []);
    },
  );
});

test('a YAML syntax error is reported with the offending file', async () => {
  await withTempRepo(
    {
      'broken.yml': 'key: [unterminated\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^broken\.yml:/);
    },
  );
});

test('a workflow job missing both runs-on and uses is reported', async () => {
  await withTempRepo(
    {
      '.github/workflows/broken.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: echo hi\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /job "test" has neither "runs-on" nor "uses"/);
    },
  );
});

test('a workflow missing the top-level "on" trigger is reported', async () => {
  await withTempRepo(
    {
      '.github/workflows/broken.yml': 'jobs:\n  test:\n    runs-on: ubuntu-latest\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /missing top-level "on" trigger/);
    },
  );
});

test('files under node_modules and .git are skipped', async () => {
  await withTempRepo(
    {
      'node_modules/pkg/broken.yml': 'key: [unterminated\n',
      '.git/broken.yml': 'key: [unterminated\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.deepEqual(errors, []);
    },
  );
});

test('duplicate keys in a YAML document are reported', async () => {
  await withTempRepo(
    {
      'dup.yml': 'key: one\nkey: two\n',
    },
    async (root) => {
      const errors = await validateYamlFiles(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^dup\.yml:/);
    },
  );
});
