import assert from 'node:assert/strict';
import test from 'node:test';
import {validateBundledDependency} from '../scripts/bundled-dependency-policy.mjs';
const entry={version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-c3ludGhldGlj'};
test('only pinned public dependencies bypass first-party text rules',()=>{
 const root='node_modules/@example/client';
 const lock={packages:{[root]:entry}};
 const read=()=>JSON.stringify({name:'@example/client',version:'1.0.0'});
 assert.equal(validateBundledDependency('dist/node_modules/example.js',lock,read),false);
 assert.equal(validateBundledDependency(`${root}/examples/sample.js`,lock,read),true);
 assert.throws(()=>validateBundledDependency('node_modules/unknown/file',lock,read),/not pinned/);
 assert.throws(()=>validateBundledDependency(`${root}/../secret`,lock,read),/Invalid/);
 assert.throws(()=>validateBundledDependency(`${root}/index.js`,{packages:{[root]:{...entry,resolved:'file:../private'}}},read),/not pinned/);
 assert.throws(()=>validateBundledDependency(`${root}/index.js`,lock,()=>JSON.stringify({name:'@example/client',version:'2.0.0'})),/differs/);
});
test('nested dependency must have its own lockfile identity',()=>{
 const root='node_modules/parent/node_modules/child';
 const read=()=>JSON.stringify({name:'child',version:'1.0.0'});
 assert.equal(validateBundledDependency(`${root}/index.js`,{packages:{[root]:entry}},read),true);
 assert.throws(()=>validateBundledDependency(`${root}/index.js`,{packages:{'node_modules/parent':entry}},read),/not pinned/);
});
