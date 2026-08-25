#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CapacityCoordinationError,
  parseConfig,
  recoverAbandonedRecord,
} from '../actions/physical-host-capacity/coordinator.mjs';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

function pairedArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0)
    throw new Error('Expected paired recovery arguments.');
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith('--') || value === undefined)
      throw new Error('Expected paired --name value recovery arguments.');
    if (values[flag.slice(2)] !== undefined)
      throw new Error(`Duplicate recovery argument ${flag}.`);
    values[flag.slice(2)] = value;
  }
  return values;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value ?? ''))
    throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${label} must be a safe integer.`);
  return parsed;
}

export function parseTerminalRecoveryArguments(argumentsList) {
  const values = pairedArguments(argumentsList);
  const [kind, ownerToken] = (values.recover ?? '').split(':', 2);
  if (!['lease', 'ticket'].includes(kind) || !UUID_PATTERN.test(ownerToken ?? ''))
    throw new Error('--recover must be lease:<uuid> or ticket:<uuid>.');
  if (!REPOSITORY_PATTERN.test(values.repository ?? ''))
    throw new Error('--repository must be an owner/repository slug.');
  return {
    config: parseConfig({
      PHYSICAL_HOST_CAPACITY_ROOT: values.root,
      PHYSICAL_HOST_CAPACITY_HOST_ID: values['host-id'],
      PHYSICAL_HOST_CAPACITY_UNITS: values['capacity-units'],
      PHYSICAL_HOST_CAPACITY_WEIGHT: '1',
      PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
      PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '1000',
      PHYSICAL_HOST_CAPACITY_OWNER_LIFETIME_SECONDS:
        values['owner-lifetime-seconds'] ?? '7800',
    }),
    kind,
    ownerToken,
    repository: values.repository,
    runId: String(positiveInteger(values['run-id'], '--run-id')),
    runAttempt: positiveInteger(values['run-attempt'], '--run-attempt'),
  };
}

function recordPath(config, kind, ownerToken) {
  return join(
    config.root,
    '.kontour-physical-host-capacity',
    kind === 'lease' ? 'leases' : 'tickets',
    `${ownerToken}.json`,
  );
}

async function readRecoveryRecord(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Recovery target must be a regular file: ${path}`);
  if (info.size < 2 || info.size > MAX_RECORD_BYTES)
    throw new Error(`Recovery target exceeds its byte contract: ${path}`);
  const raw = await readFile(path);
  let record;
  try {
    record = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Recovery target is not valid JSON: ${path}`, {
      cause: error,
    });
  }
  return {
    record,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

function assertExactOwner(record, expected) {
  const fields = [
    ['ownerToken', expected.ownerToken],
    ['repository', expected.repository],
    ['runId', expected.runId],
    ['runAttempt', String(expected.runAttempt)],
  ];
  for (const [field, value] of fields) {
    if (String(record?.[field] ?? '') !== value)
      throw new Error(
        `Recovery target ${field} does not match the explicitly confirmed owner.`,
      );
  }
}

async function responseJson(response) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error('GitHub run response exceeds its byte contract.');
  if (!response.body?.getReader)
    throw new Error('GitHub run response has no readable body.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('GitHub run response exceeds its byte contract.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

export async function verifyTerminalGitHubOwner({
  repository,
  runId,
  runAttempt,
  token,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('GITHUB_TOKEN is required for terminal owner proof.');
  const [owner, name] = repository.split('/');
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/actions/runs/${runId}/attempts/${runAttempt}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'kontour-physical-host-capacity-recovery',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`GitHub run proof failed with HTTP ${response.status}.`);
  const run = await responseJson(response);
  if (
    String(run?.id ?? '') !== runId ||
    Number(run?.run_attempt) !== runAttempt ||
    run?.repository?.full_name !== repository
  )
    throw new Error('GitHub run proof did not match the exact recorded owner.');
  if (run.status !== 'completed')
    throw new Error(`GitHub owner run is ${String(run.status)}; recovery refused.`);
  return { conclusion: String(run.conclusion ?? 'unknown') };
}

export async function recoverTerminalCapacityOwner({
  config,
  kind,
  ownerToken,
  repository,
  runId,
  runAttempt,
  token,
  fetchImpl = fetch,
  beforeRecover,
}) {
  const path = recordPath(config, kind, ownerToken);
  const snapshot = await readRecoveryRecord(path);
  assertExactOwner(snapshot.record, {
    ownerToken,
    repository,
    runId,
    runAttempt,
  });
  const proof = await verifyTerminalGitHubOwner({
    repository,
    runId,
    runAttempt,
    token,
    fetchImpl,
  });
  await beforeRecover?.({ path, snapshot });
  const recoveredPath = await recoverAbandonedRecord(config, {
    kind,
    ownerToken,
    expectedSha256: snapshot.sha256,
  });
  return { recoveredPath, conclusion: proof.conclusion };
}

async function main() {
  const options = parseTerminalRecoveryArguments(process.argv.slice(2));
  const result = await recoverTerminalCapacityOwner({
    ...options,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(
    `Recovered exact terminal ${options.kind} owner ${options.ownerToken.slice(0, 8)} ` +
      `(run=${options.repository}#${options.runId}/${options.runAttempt}; conclusion=${result.conclusion}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message =
      error instanceof CapacityCoordinationError || error instanceof Error
        ? error.message
        : String(error);
    console.error(`Terminal capacity owner recovery failed: ${message}`);
    process.exitCode = 1;
  });
}
