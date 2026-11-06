import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = path.resolve('scripts/documentation-enforcement.mjs');
const head = 'a'.repeat(40);
async function run(t, state, apply = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-enforcement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = path.join(root, 'calls.json');
  const preload = path.join(root, 'github.mjs');
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs';
    const calls=[]; let created;
    globalThis.fetch=async(url,options)=>{
      if (!String(url).startsWith('https://api.github.com/')) throw new Error('credential destination escaped GitHub');
      calls.push({url:String(url),method:options.method,body:options.body?JSON.parse(options.body):null});
      writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));
      if (${JSON.stringify(state)}==='plan-denied' && String(url).includes('/rulesets')) return Response.json({message:'Upgrade the account plan'}, {status:403});
      if (String(url).endsWith('/repos/example/product')) return Response.json({default_branch:'main',permissions:{admin:true}});
      if (String(url).includes('/commits/main')) return Response.json({sha:${JSON.stringify(state === 'moved' ? 'b'.repeat(40) : head)}});
      if (String(url).includes('/check-runs')) return Response.json({check_runs:[{id:1,name:'gate / Docs gate',status:'completed',conclusion:${JSON.stringify(state === 'failed-check' ? 'failure' : 'success')},app:{slug:'github-actions',id:15368}}]});
      if (options.method==='POST') {created={id:42,...JSON.parse(options.body)};return Response.json(created);}
      if (String(url).endsWith('/rulesets/8')) return Response.json({id:8,name:'Documentation freshness',target:'branch',enforcement:'disabled',rules:[],bypass_actors:[]});
      if (String(url).includes('/rulesets?')) {
        if (created && ${JSON.stringify(state)}==='readback-lost') throw new Error('read-back response lost');
        return Response.json([{id:7,name:'Existing source protection'},...(${JSON.stringify(state)}==='existing-different'?[{id:8,name:'Documentation freshness'}]:[]),...(created?[{id:42,name:'Documentation freshness'}]:[])]);
      }
      throw new Error('Unexpected API call '+url);
    };
  `);
  const args = [script, '--repo', 'example/product', '--head', head, '--context', 'gate / Docs gate', ...(apply ? ['--apply'] : [])];
  const result = await new Promise((resolve) => execFile(process.execPath, args, { env: { ...process.env, GH_TOKEN: 'fixture-token', NODE_OPTIONS: `--import=${preload}` }, encoding: 'utf8', windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  return { ...result, calls: JSON.parse(readFileSync(calls, 'utf8')) };
}

test('enforcement is read-only by default after exact-head check validation', async (t) => {
  const r = await run(t, 'good');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'ready-to-enforce');
  assert.ok(r.calls.every((call) => call.method === 'GET'));
});

test('applying adds one default-branch gate without bypass actors or replacing existing policies', async (t) => {
  const r = await run(t, 'good', true);
  assert.equal(r.code, 0, r.stderr);
  const writes = r.calls.filter((call) => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.deepEqual(writes[0].body.bypass_actors, []);
  assert.deepEqual(writes[0].body.conditions, { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } });
  assert.deepEqual(writes[0].body.rules[0].parameters.required_status_checks, [{ context: 'gate / Docs gate', integration_id: 15368 }]);
  assert.deepEqual(JSON.parse(r.stdout).preservedRulesetIds, [7]);
});

for (const state of ['failed-check', 'moved', 'plan-denied', 'existing-different']) test(`${state} refuses enforcement without a write`, async (t) => {
  const r = await run(t, state, true);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stderr).status, 'NOT_VERIFIED');
  assert.ok(r.calls.every((call) => call.method === 'GET'));
});

test('response loss after a policy write remains unverified and never claims that nothing changed', async (t) => {
  const r = await run(t, 'readback-lost', true);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stderr).status, 'NOT_VERIFIED');
  assert.equal(r.calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(r.stderr, /read-back response lost/);
});
