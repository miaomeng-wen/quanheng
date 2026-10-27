'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sha = value => createHash('sha256').update(value).digest('hex');
function verifyChain(entries) {
  let previous = '';
  for (let i = 0; i < entries.length; i++) { const { hash, ...entry } = entries[i]; if (entry.seq !== i + 1 || entry.prevHash !== previous || hash !== sha(previous + JSON.stringify(entry))) return false; previous = hash; }
  return true;
}
function createAudit({ filePath = path.join(__dirname, '../data/audit.log.jsonl'), clock = require('./clock') } = {}) {
  const entries = filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  if (!verifyChain(entries)) throw new Error('Audit chain invalid');
  return Object.freeze({ append(fields) { const entry = { seq: entries.length + 1, ts: clock.now(), prevHash: entries.at(-1)?.hash || '', actor: 'u1', ...fields }; const record = { ...entry, hash: sha(entry.prevHash + JSON.stringify(entry)) }; if (filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.appendFileSync(filePath, JSON.stringify(record) + '\n'); } entries.push(record); return structuredClone(record); }, list: (sinceSeq = 0) => structuredClone(entries.filter(e => e.seq > sinceSeq)), verify: () => verifyChain(entries) });
}
module.exports = { createAudit, verifyChain, sha };
