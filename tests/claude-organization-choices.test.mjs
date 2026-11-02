import assert from 'node:assert/strict';
import test from 'node:test';
import { organizationChoices } from '../dist/commands/claude-setup.js';
const credentials = { orgs: {
  org_alpha: { api_key: 'synthetic-a', gateway_url: 'https://example.com' },
  org_beta: { api_key: 'synthetic-b', gateway_url: 'https://example.com' },
} };
test('organization names retain IDs for selection and duplicate-name disambiguation', async () => {
  assert.deepEqual(await organizationChoices(credentials, async () => 'Example Team'), [
    { name: 'Example Team (org_alpha)', value: 'org_alpha' },
    { name: 'Example Team (org_beta)', value: 'org_beta' },
  ]);
});
test('one unavailable name does not block the other organization', async () => {
  const choices = await organizationChoices(credentials, async id => {
    if (id === 'org_alpha') throw new Error('unavailable');
    return 'Example Team';
  });
  assert.equal(choices[0].value, 'org_alpha');
  assert.match(choices[0].name, /name unavailable/);
  assert.equal(choices[1].name, 'Example Team (org_beta)');
});
test('organization labels cannot inject terminal control sequences', async () => {
  const choices = await organizationChoices(credentials, async () => '\x1b[31mExample\x1b[0m\nTeam');
  assert.equal(choices[0].name, 'Example Team (org_alpha)');
});
