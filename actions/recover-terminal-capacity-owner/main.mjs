import { pathToFileURL } from 'node:url';

import {
  parseTerminalRecoveryArguments,
  recoverTerminalCapacityOwner,
} from '../../scripts/recover-terminal-capacity-owner.mjs';

function input(env, name) {
  const githubName = `INPUT_${name.toUpperCase()}`;
  const portableName = `INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
  const value = env[githubName] ?? env[portableName];
  if (typeof value !== 'string' || value === '')
    throw new Error(`Missing required action input ${name}.`);
  return value;
}

export async function runTerminalRecoveryAction({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const repository = input(env, 'owner-repository');
  if (repository !== env.GITHUB_REPOSITORY)
    throw new Error(
      'owner-repository must equal the invoking GitHub repository so github-token has authoritative access.',
    );
  const options = parseTerminalRecoveryArguments([
    '--root',
    input(env, 'coordination-root'),
    '--host-id',
    input(env, 'host-id'),
    '--capacity-units',
    input(env, 'capacity-units'),
    '--owner-lifetime-seconds',
    input(env, 'owner-lifetime-seconds'),
    '--recover',
    input(env, 'recover'),
    '--repository',
    repository,
    '--run-id',
    input(env, 'owner-run-id'),
    '--run-attempt',
    input(env, 'owner-run-attempt'),
  ]);
  return recoverTerminalCapacityOwner({
    ...options,
    token: input(env, 'github-token'),
    fetchImpl,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTerminalRecoveryAction().catch((error) => {
    console.error(`Terminal capacity owner recovery failed: ${error.message}`);
    process.exitCode = 1;
  });
}
