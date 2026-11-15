'use strict';
/* Minimal .env loader (no dependencies). Existing process.env wins. */
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  const p = file || path.join(__dirname, '..', '.env');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return process.env;
}

module.exports = { loadDotEnv };
