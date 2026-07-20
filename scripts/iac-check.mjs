#!/usr/bin/env node
/**
 * IaC integrity gate (CLD-012, NFR-037). The Cloudflare account surface is defined
 * in version-controlled Wrangler + Terraform. This checks — statically, with no
 * network — that those files exist, are git-tracked, isolate environments, use
 * variables/secret bindings for credentials, and carry NO inline secrets. It does
 * not apply the IaC (that needs a live account + the B2/B3 decisions); it enforces
 * the reproducibility inputs so a real apply is deterministic and secret-free.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const WRANGLER = 'apps/cloud-worker/wrangler.toml';
const TERRAFORM = 'infra/cloudflare/main.tf';
const errors = [];

function tracked(path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

for (const f of [WRANGLER, TERRAFORM]) {
  if (!existsSync(f)) { errors.push(`${f} is missing`); continue; }
  if (!tracked(f)) errors.push(`${f} is not version-controlled (git-tracked)`);
}

// Inline-secret patterns that must never appear in IaC.
const SECRET_PATTERNS = [
  ['Cloudflare API token literal', /\b[A-Za-z0-9_-]{40}\b\s*(#.*)?$/m], // bare 40-char token on a line
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['inline password in URL', /\b[a-z]+:\/\/[^:@\s]+:[^@\s]+@/i],
  ['api_token literal', /api[_-]?token\s*=\s*"[^"]{20,}"/i],
];

if (existsSync(WRANGLER)) {
  const w = readFileSync(WRANGLER, 'utf8');
  if (!/\[env\.production\]/.test(w) || !/\[env\.staging\]/.test(w)) errors.push(`${WRANGLER}: expected isolated [env.staging] and [env.production] sections`);
  // Secrets must be bindings set out-of-band, not committed vars.
  if (/(secret|token|password|connection_string)\s*=\s*"/i.test(w.replace(/#.*$/gm, ''))) errors.push(`${WRANGLER}: a secret appears to be assigned inline; use 'wrangler secret put' / secret bindings`);
}

if (existsSync(TERRAFORM)) {
  const t = readFileSync(TERRAFORM, 'utf8');
  if (!/variable\s+"cloudflare_account_id"/.test(t)) errors.push(`${TERRAFORM}: account id must come from a variable, not a literal`);
  if (!/sensitive\s*=\s*true/.test(t)) errors.push(`${TERRAFORM}: secret variables (e.g. connection string) must be marked 'sensitive = true'`);
  // A connection string must reference a variable, never a literal postgres URL.
  if (/postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/.test(t)) errors.push(`${TERRAFORM}: a literal PostgreSQL connection string with credentials is present`);
}

for (const f of [WRANGLER, TERRAFORM]) {
  if (!existsSync(f)) continue;
  const body = readFileSync(f, 'utf8');
  for (const [label, re] of SECRET_PATTERNS) {
    // Ignore comment lines (# … or // …) — documentation of the pattern is fine.
    const codeOnly = body.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
    if (re.test(codeOnly)) errors.push(`${f}: possible inline secret (${label})`);
  }
}

if (errors.length > 0) {
  console.error(`\n✖ iac-check: ${errors.length} issue(s) in the infrastructure-as-code:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ iac-check: Wrangler + Terraform are version-controlled, environment-isolated, and free of inline secrets.');
