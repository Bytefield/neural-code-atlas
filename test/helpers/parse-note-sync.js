#!/usr/bin/env node
/**
 * Synchronous test helper for parseNote.
 * Accepts a file path as argument, executes parseNote asynchronously,
 * and outputs the result as JSON.
 */

const { parseNote } = require('../../dist/vault/parser.js');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node parse-note-sync.js <filePath>');
  process.exit(1);
}

parseNote(filePath)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
