// Synthetic fixture only. All credentials are ephemeral, received over stdin, not logged.
import {readFileSync} from 'node:fs';
import {openSqliteTestAuthority} from '../../scripts/hq-sqlite-test-adapter.mjs';
import {createGitHubActionsOidcAuthorizer} from '../../scripts/hq-oidc-auth.mjs';
import {createAuthorityWorker} from '../../workers/state-authority/worker.mjs';

let store;
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  store = openSqliteTestAuthority(input.databasePath);
  const authorize = createGitHubActionsOidcAuthorizer(input.policy, {
    fetch: async url => url === 'https://token.actions.githubusercontent.com/.well-known/jwks'
      ? Response.json({keys: [input.publicJwk]}) : Response.json({}, {status: 404})
  });
  const worker = createAuthorityWorker({
    repository: 'haji84/PERSONAL-AI-HQ', goal: 'synthetic-goal', authorize
  });
  const request = new Request('https://synthetic.invalid/v1/' + input.operation, {
    method: 'POST',
    headers: {authorization: 'Bearer ' + input.token, ...input.headers},
    body: JSON.stringify(input.body)
  });
  const response = await worker.fetch(request, {HQ_STATE: store.authority});
  process.stdout.write(JSON.stringify({status: response.status, body: await response.json()}));
} catch {
  // Do not print tokens, request bodies, keys, or exception details to CI.
  process.exitCode = 1;
} finally {
  store?.close();
}
