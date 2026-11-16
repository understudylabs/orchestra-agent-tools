#!/usr/bin/env node
import { readFileSync, statSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { joinAudrWorkflow } from './join.mjs';

const help = 'node experiments/audr-workflow/run.mjs --audr records.jsonl --captures captures.jsonl --links links.jsonl --output report.json';
function readRows(path) {
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error('Input exceeds prototype 32 MiB per-file limit');
  const bytes = readFileSync(path);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Input exceeds prototype 32 MiB per-file limit');
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim());
  const rows = lines.map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at row ${i + 1}; input values omitted`); }
  });
  return { rows, sha256: createHash('sha256').update(bytes).digest('hex') };
}
try {
  const { values } = parseArgs({ options: {
    audr: { type: 'string' }, captures: { type: 'string' }, links: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log(help);
  else {
    if (!['audr', 'captures', 'links', 'output'].every(k => values[k])) throw new Error(help);
    const inputs = Object.fromEntries(['audr', 'captures', 'links'].map(k => [k, readRows(values[k])]));
    const report = joinAudrWorkflow({ records: inputs.audr.rows, captures: inputs.captures.rows, links: inputs.links.rows });
    report.input_sha256 = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.sha256]));
    // Never overwrite an input or earlier report. Payloads stay in the source files.
    const fd = openSync(resolve(values.output), 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); } finally { closeSync(fd); }
    console.log(JSON.stringify({ ...report.accounting, workflows: report.workflows.length, output_written: true }));
  }
} catch (error) {
  // Filesystem/argument errors may contain user paths; avoid echoing those values.
  console.error(error?.code ? `Local file/argument error: ${error.code}` : error.message);
  process.exitCode = 1;
}
