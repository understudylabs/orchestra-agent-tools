#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinAudrWorkflow } from './join.mjs';
import { syntheticModelChoices } from './model-choice.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const readFixture = name => readFileSync(resolve(root, 'fixtures', `${name}.jsonl`), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

export function demoScenarios() {
  const records = readFixture('audr'), captures = readFixture('captures'), links = readFixture('links');
  const run = (records, links) => joinAudrWorkflow({ records, captures, links });
  return [
    { id: 'joined', name: 'Joined evidence', description: 'Explicit operation-to-request mappings connect harness economics to payload references. All values are synthetic.', report: run(records, links) },
    { id: 'missing-link', name: 'Missing correlation', description: 'One mapping is removed. The matching payload may exist, but we do not guess its relationship from time or model name.', report: run(records, links.slice(1)) },
    { id: 'missing-cost', name: 'Missing tool cost', description: 'The executed tool has no asserted cost. Known costs remain visible; the cohort ratio is withheld.', report: run(records.map(r => { const copy = structuredClone(r); if (copy.resource.type === 'tool') delete copy.cost; return copy; }), links) },
    { id: 'missing-outcome', name: 'Missing outcome', description: 'Harness outcome declarations are removed. Model-call completion alone cannot tell us whether the task succeeded.', report: run(records.map(r => { const copy = structuredClone(r); delete copy.run.outcome; return copy; }), links) },
  ];
}

export function buildDemo(output) {
  const data = JSON.stringify(demoScenarios()).replaceAll('<', '\\u003c');
  const html = readFileSync(resolve(root, 'demo.html'), 'utf8').replace('__AUDR_DEMO_DATA__', data)
    .replace('__MODEL_CHOICE_DATA__', JSON.stringify(syntheticModelChoices()).replaceAll('<', '\\u003c'));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, html, { flag: 'wx', mode: 0o600 });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = resolve(process.argv[2] ?? '.understudy/audr-workflow/demo.html');
    buildDemo(output);
    console.log('Synthetic local overview written. Open the output HTML in a browser.');
  } catch (error) {
    console.error(error?.code ? `Local file error: ${error.code}` : error.message);
    process.exitCode = 1;
  }
}
