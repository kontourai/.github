import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/secret-scan.yml', import.meta.url),
);

test('secret scan is limited to complete history reachable from checkout HEAD', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // gitleaks v8.30.1 passes --log-opts directly to `git log`; HEAD therefore
  // replaces its default --all traversal while retaining all HEAD ancestors.
  assert.match(
    workflow,
    /gitleaks git \. --log-opts=HEAD --redact --no-banner --verbose/,
  );
  assert.match(
    workflow,
    /fetch-depth: \$\{\{ inputs\.fetch-depth \|\| 0 \}\}/,
  );
  assert.doesNotMatch(workflow, /gitleaks git \. .*--all/);
  assert.doesNotMatch(workflow, /--exit-code(?:=|\s+)0/);
});
