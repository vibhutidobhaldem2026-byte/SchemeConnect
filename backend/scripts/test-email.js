#!/usr/bin/env node
/**
 * Sends one real OTP email through Resend, to prove delivery works.
 *
 *   node scripts/test-email.js you@example.com
 *
 * Deliberately requires the recipient on the command line — this sends a real
 * email, so it should never fire at an address nobody chose.
 */

import path from 'node:path';
import { ROOT } from '../config/paths.js';
import { sendOtpEmail, isEmailConfigured, senderAddress } from '../server/mailer.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  console.error('No .env file found.');
}

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('\nusage: node scripts/test-email.js <recipient@example.com>\n');
  process.exit(1);
}

if (!isEmailConfigured()) {
  console.error('\nRESEND_API_KEY is not set in .env — nothing to test.\n');
  process.exit(1);
}

console.log('');
console.log(`  from : ${senderAddress()}`);
console.log(`  to   : ${to}`);
console.log('  sending...');

const code = String(Math.floor(100000 + Math.random() * 900000));
const result = await sendOtpEmail(to, code, { minutes: 10 });

if (result.ok) {
  console.log(`\n  SENT — resend id ${result.id}`);
  console.log(`  sent from : ${result.from}`);
  console.log(`  The email contains the code ${code}.`);
  if (result.usedFallback) {
    console.log('');
    console.log('  NOTE: your configured domain is not verified yet, so this went out from');
    console.log('  Resend\'s shared sender. That means Resend sandbox limits still apply —');
    console.log('  delivery only to the address your Resend account is registered with.');
    console.log('  Add the DNS records at https://resend.com/domains to finish verification.');
  }
  console.log('  Check the inbox, and the spam folder (new sender).\n');
} else {
  console.error(`\n  FAILED (HTTP ${result.status ?? '?'}): ${result.error}\n`);
  if (result.status === 403 || /verify a domain|testing emails|own email/i.test(result.error || '')) {
    console.error('  Resend restricts unverified accounts to sending only to the address the');
    console.error('  Resend account itself is registered with. To email anyone else, verify a');
    console.error('  domain at https://resend.com/domains and set RESEND_FROM to an address on it.\n');
  }
  process.exitCode = 1;
}
