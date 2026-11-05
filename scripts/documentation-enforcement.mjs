import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const RULE_NAME = 'Documentation freshness';
const API = 'https://api.github.com/';
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

async function request(endpoint, { method = 'GET', body } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');
  const response = await fetch(`${API}${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data.message ?? 'request failed'} (${endpoint})`);
  return data;
}

function desiredRule(context, appId) {
  return {
    name: RULE_NAME, target: 'branch', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'required_status_checks', parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context, integration_id: appId }],
    } }],
  };
}

export async function enforceDocumentation({ repo, head, context, apply = false }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '') ||
    typeof context !== 'string' || !context.trim() || context.includes('\n')) throw new Error('--repo owner/name, --head full-sha and --context exact-check-name are required.');
  const metadata = await request(`repos/${repo}`);
  if (apply && !metadata.permissions?.admin) throw new Error('Applying a repository ruleset requires verified repository-admin standing.');
  const branch = encodeURIComponent(metadata.default_branch);
  const current = await request(`repos/${repo}/commits/${branch}`);
  if (current.sha !== head) throw new Error(`Default branch moved: expected ${head}, observed ${current.sha}. Refresh the evidence first.`);
  const runs = await request(`repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(context)}&per_page=100`);
  const matching = runs.check_runs.filter((run) => run.name === context && run.app?.slug === 'github-actions').sort((a, b) => b.id - a.id);
  const latest = matching[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`The latest GitHub Actions check '${context}' has not succeeded at ${head}.`);
  const rule = desiredRule(context, latest.app.id);
  const before = await request(`repos/${repo}/rulesets?includes_parents=true`);
  const existing = before.find((item) => item.name === RULE_NAME);
  if (existing) {
    const actual = await request(`repos/${repo}/rulesets/${existing.id}`);
    if (actual.target !== rule.target || actual.enforcement !== 'active' ||
      !same(actual.conditions, rule.conditions) ||
      !same(actual.rules, rule.rules) || actual.bypass_actors?.length)
      throw new Error('An existing Documentation freshness policy differs; refusing to overwrite or weaken it.');
    return { repo, head, context, status: 'already-enforced', rulesetId: existing.id, changed: false };
  }
  if (!apply) return { repo, head, context, status: 'ready-to-enforce', changed: false, proposedRule: rule };
  const unchanged = await request(`repos/${repo}/commits/${branch}`);
  if (unchanged.sha !== head) throw new Error('Default branch moved during preflight; no policy was written.');
  const created = await request(`repos/${repo}/rulesets`, { method: 'POST', body: rule });
  const after = await request(`repos/${repo}/rulesets?includes_parents=true`);
  if (!before.every((old) => after.some((item) => item.id === old.id)) || !after.some((item) => item.id === created.id))
    throw new Error('Ruleset read-back did not preserve the previous policy inventory. Inspect GitHub before taking further action.');
  return { repo, head, context, status: 'enforced', rulesetId: created.id, changed: true, preservedRulesetIds: before.map((item) => item.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, head: { type: 'string' }, context: { type: 'string' }, apply: { type: 'boolean' } }, strict: true });
    console.log(JSON.stringify(await enforceDocumentation(values), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'not-enforced', error: error.message }));
    process.exitCode = 2;
  }
}
