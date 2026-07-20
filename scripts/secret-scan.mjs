#!/usr/bin/env node
/**
 * Deterministic, network-free secret + credential scanner (NFR-014, pack §17).
 *
 * Enforces two non-negotiables from the brief at CI time:
 *   1. No secrets in source — private keys, cloud API tokens, provider keys, or
 *      real passwords embedded in connection strings.
 *   2. Synthetic data only — no production hostnames or non-test credentials.
 *
 * Scans only git-tracked files (so it mirrors what would actually ship) and skips
 * lockfiles and this scanner itself. Known-synthetic test credentials
 * (localhost/127.0.0.1 with the `sancta:sancta` test role) are allow-listed — they
 * are fixtures, not secrets. Exits non-zero on any finding so the release gate fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/** High-signal secret patterns. Each: [label, regex]. */
const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['AWS secret access key', /\baws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+]{40}['"]/i],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{36,}\b/],
  ['Cloudflare API token', /\bcf-[A-Za-z0-9]{40,}\b/],
  ['Stripe secret key', /\bsk_(?:live|test)_[0-9A-Za-z]{20,}\b/],
  ['generic bearer secret', /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*['"][A-Za-z0-9_\-]{24,}['"]/i],
  ['private JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/** Credentials embedded in a DB/URL that are NOT the known synthetic test role. */
const CONN_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^:@\s/]+):([^@\s/]+)@([^/\s:]+)/gi;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_CRED = new Set(['sancta']); // synthetic test role/password used across suites

// Files never worth scanning (generated, binary, or the scanner/allowlist itself).
const SKIP = [/package-lock\.json$/, /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.ico$/, /\.pdf$/, /\.woff2?$/, /scripts\/secret-scan\.mjs$/];

function tracked() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const findings = [];
for (const file of tracked()) {
  if (SKIP.some((re) => re.test(file))) continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue; // skip very large blobs
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable/binary
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) findings.push({ file, line: i + 1, label, snippet: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(CONN_WITH_PASSWORD)) {
      const [, user, pass, host] = m;
      const hostname = host.split(':')[0];
      const isTest = ALLOWED_HOSTS.has(hostname) && ALLOWED_TEST_CRED.has(user) && ALLOWED_TEST_CRED.has(pass);
      if (!isTest) findings.push({ file, line: i + 1, label: 'credential in connection string', snippet: line.trim().slice(0, 120) });
    }
  });
}

if (findings.length > 0) {
  console.error(`\n✖ secret-scan: ${findings.length} potential secret(s) found:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.label}]  ${f.snippet}`);
  console.error('\nRemove the secret and rotate it. Use environment variables / a secrets manager (pack §17).');
  process.exit(1);
}
console.log('✓ secret-scan: no secrets or non-synthetic credentials in tracked source.');
