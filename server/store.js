/**
 * Application data store (users, profiles, saved schemes, institute batches).
 *
 * A JSON file behind an async write queue. Adequate for a pilot, and it keeps
 * the project free of a native database dependency. Scheme data does NOT live
 * here — that comes only from the scraper's catalog.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { STORE_FILE, DATA_DIR } from '../config/paths.js';

const EMPTY = {
  users: [],
  profiles: {},
  saved: {},
  applied: {},
  institutes: [],
  batches: [],
  consents: [],
  otps: {},
  sessions: {},
};

let state = null;
let writeChain = Promise.resolve();

async function load() {
  if (state) return state;
  try {
    state = { ...EMPTY, ...JSON.parse(await readFile(STORE_FILE, 'utf8')) };
  } catch {
    state = structuredClone(EMPTY);
  }
  return state;
}

/** Serialised, atomic-ish write (temp file + rename). */
function persist() {
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.store.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, STORE_FILE);
  }).catch((err) => {
    console.error('store write failed:', err.message);
  });
  return writeChain;
}

export async function flush() {
  await writeChain;
}

// ---------------------------------------------------------------- OTP ------

export const OTP_TTL_MINUTES = 10;

/**
 * Issues a 6-digit code and records it against the identifier.
 *
 * Delivery is the caller's job (see routes/auth.js) — email goes out through
 * Resend, while mobile has no SMS provider wired up and falls back to showing
 * the code on screen. The delivery outcome is stored on the OTP record so the
 * verify screen can state honestly whether the code was actually sent.
 */
export async function issueOtp(identifier) {
  const s = await load();
  const code = String(randomInt(100000, 1000000));
  s.otps[identifier] = {
    code,
    issuedAt: Date.now(),
    expiresAt: Date.now() + OTP_TTL_MINUTES * 60 * 1000,
    attempts: 0,
    delivery: { channel: null, sent: false, error: null },
  };
  await persist();
  return code;
}

/** Records how an issued code was (or wasn't) delivered. */
export async function recordOtpDelivery(identifier, delivery) {
  const s = await load();
  const entry = s.otps[identifier];
  if (!entry) return null;
  entry.delivery = { channel: null, sent: false, error: null, ...delivery };
  await persist();
  return entry.delivery;
}

export async function getOtpDelivery(identifier) {
  const s = await load();
  return s.otps[identifier]?.delivery ?? null;
}

/**
 * Reads back an outstanding code. Only used to display it in dev mode, where
 * there is no SMS/email provider to deliver it.
 */
export async function peekOtpCode(identifier) {
  const s = await load();
  const entry = s.otps[identifier];
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.code;
}

export async function verifyOtp(identifier, code) {
  const s = await load();
  const entry = s.otps[identifier];
  if (!entry) return { ok: false, reason: 'No code was requested for this contact.' };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'That code has expired. Request a new one.' };
  if (entry.attempts >= 5) return { ok: false, reason: 'Too many attempts. Request a new code.' };

  entry.attempts++;
  if (entry.code !== String(code).trim()) {
    await persist();
    return { ok: false, reason: 'That code is not correct.' };
  }
  delete s.otps[identifier];
  await persist();
  return { ok: true };
}

// --------------------------------------------------------------- users -----

export async function findUser(identifier) {
  const s = await load();
  return s.users.find((u) => u.identifier === identifier) ?? null;
}

export async function createUser({ identifier, role, name = null, email = null }) {
  const s = await load();
  const user = {
    id: randomUUID(),
    identifier,
    role, // 'student' | 'institute'
    name,
    email,
    createdAt: new Date().toISOString(),
    verifiedContact: true,
    documentsVerified: {},
  };
  s.users.push(user);
  await persist();
  return user;
}

export async function updateUser(userId, patch) {
  const s = await load();
  const user = s.users.find((u) => u.id === userId);
  if (!user) return null;
  Object.assign(user, patch);
  await persist();
  return user;
}

export async function getUser(userId) {
  const s = await load();
  return s.users.find((u) => u.id === userId) ?? null;
}

export async function deleteUser(userId) {
  const s = await load();
  s.users = s.users.filter((u) => u.id !== userId);
  delete s.profiles[userId];
  delete s.saved[userId];
  delete s.applied[userId];
  s.consents = s.consents.filter((c) => c.userId !== userId);
  await persist();
}

// ------------------------------------------------------------ sessions -----

export async function createSession(userId) {
  const s = await load();
  const token = randomUUID();
  s.sessions[token] = { userId, createdAt: Date.now() };
  await persist();
  return token;
}

export async function getSession(token) {
  const s = await load();
  return s.sessions[token] ?? null;
}

export async function destroySession(token) {
  const s = await load();
  delete s.sessions[token];
  await persist();
}

// ------------------------------------------------------------- profile -----

export async function getProfile(userId) {
  const s = await load();
  return s.profiles[userId] ?? {};
}

export async function saveProfile(userId, patch) {
  const s = await load();
  s.profiles[userId] = { ...(s.profiles[userId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
  await persist();
  return s.profiles[userId];
}

// --------------------------------------------------- saved / applied -------

export async function toggleSaved(userId, schemeId) {
  const s = await load();
  const list = (s.saved[userId] ??= []);
  const idx = list.indexOf(schemeId);
  if (idx === -1) list.push(schemeId);
  else list.splice(idx, 1);
  await persist();
  return list;
}

export async function getSaved(userId) {
  const s = await load();
  return s.saved[userId] ?? [];
}

export async function markApplied(userId, schemeId) {
  const s = await load();
  const list = (s.applied[userId] ??= []);
  if (!list.some((a) => a.schemeId === schemeId)) {
    list.push({ schemeId, markedAt: new Date().toISOString(), status: 'submitted' });
  }
  await persist();
  return list;
}

export async function getApplied(userId) {
  const s = await load();
  return s.applied[userId] ?? [];
}

// ------------------------------------------------------------ consent ------

/**
 * Consent records, including the DPDP Act parental-consent flag the PRD
 * requires for the large share of users who are under 18.
 */
export async function recordConsent({ userId, role, termsVersion, isMinor, guardianName, guardianContact }) {
  const s = await load();
  const record = {
    id: randomUUID(),
    userId,
    role,
    termsVersion,
    isMinor: Boolean(isMinor),
    guardianName: guardianName || null,
    guardianContact: guardianContact || null,
    acceptedAt: new Date().toISOString(),
  };
  s.consents.push(record);
  await persist();
  return record;
}

export async function getConsent(userId) {
  const s = await load();
  return s.consents.filter((c) => c.userId === userId).at(-1) ?? null;
}

// ---------------------------------------------------------- institutes -----

export async function createInstitute({ name, pocUserId, pocName }) {
  const s = await load();
  const inst = {
    id: randomUUID(),
    name,
    pocUserId,
    pocName,
    createdAt: new Date().toISOString(),
  };
  s.institutes.push(inst);
  await persist();
  return inst;
}

export async function getInstituteByUser(userId) {
  const s = await load();
  return s.institutes.find((i) => i.pocUserId === userId) ?? null;
}

export async function saveBatch(batch) {
  const s = await load();
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...batch };
  s.batches.push(record);
  await persist();
  return record;
}

/**
 * Updates a batch in place. Import promotes the draft created at upload time
 * rather than writing a second record — otherwise the preview URL's id stops
 * resolving after import and the draft is orphaned.
 */
export async function updateBatch(batchId, patch) {
  const s = await load();
  const batch = s.batches.find((b) => b.id === batchId);
  if (!batch) return null;
  Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return batch;
}

export async function getBatches(instituteId) {
  const s = await load();
  return s.batches.filter((b) => b.instituteId === instituteId);
}

export async function getBatch(batchId) {
  const s = await load();
  return s.batches.find((b) => b.id === batchId) ?? null;
}

export async function stats() {
  const s = await load();
  return {
    users: s.users.length,
    students: s.users.filter((u) => u.role === 'student').length,
    institutes: s.institutes.length,
    batches: s.batches.length,
    consents: s.consents.length,
    minorConsents: s.consents.filter((c) => c.isMinor).length,
  };
}
