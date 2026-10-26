#!/usr/bin/env node
'use strict';
// Literal source check: the count-only harness must contain no rate logic.
// Fails on forbidden words (case-insensitive, anywhere in the file, comments included)
// and on any slash character left after comments and string literals are removed
// (a slash there would be a division between counts).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'v2-count-audit.js');
const FORBIDDEN_WORDS = ['rate', 'ratio', 'threshold', 'percent', 'tofixed'];

const source = fs.readFileSync(FILE, 'utf-8').replace(/^#!.*\n/, '');
const lower = source.toLowerCase();
const problems = [];

for (const word of FORBIDDEN_WORDS) {
  if (lower.includes(word)) problems.push('forbidden word: ' + word);
}

let code = '';
let i = 0;
while (i < source.length) {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    while (i < source.length && source[i] !== '\n') i++;
  } else if (ch === "'" || ch === '"' || ch === '`') {
    i++;
    while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
    i++;
  } else {
    code += ch;
    i++;
  }
}
if (code.includes('/')) problems.push('slash operator outside comments and strings');

if (problems.length) {
  console.log('FAIL v2-count-audit source check');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('PASS v2-count-audit source check: no rate words, no division');
