#!/usr/bin/env bash
set -euo pipefail

if [ ! -d "results" ]; then
  echo "Directory results/ does not exist."
  exit 0
fi

node -e "
const fs = require('fs');
const path = require('path');

function getFiles(dir) {
  let entries = [];
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      entries = entries.concat(getFiles(full));
    } else {
      entries.push({ path: full, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  }
  return entries;
}

const files = getFiles('results');
files.sort((a, b) => a.path.localeCompare(b.path));

console.log('Path'.padEnd(50) + ' | ' + 'Size (B)'.padEnd(10) + ' | ' + 'Modified Time'.padEnd(25));
console.log('-'.repeat(90));
for (const f of files) {
  console.log(f.path.padEnd(50) + ' | ' + String(f.size).padEnd(10) + ' | ' + f.mtime);
}

const summaries = files.filter((f) => f.path.endsWith('-summary.txt'));
for (const s of summaries) {
  console.log('\n=== ' + s.path + ' ===');
  console.log(fs.readFileSync(s.path, 'utf8'));
}
"
