/**
 * Application data store — accounts, consent, student activity, institutes.
 *
 * Backed by PostgreSQL. This was a single JSON file rewritten in full on every
 * mutation, which meant one process only, silent write failures, and nothing
 * surviving a deploy on an ephemeral filesystem.
 *
 * Scheme data does NOT live here — see catalog.js. The scraper owns that.
 *
 * Two operations are transactional because a half-written result is worse than
 * an error: creating an account together with its consent record, and importing
 * a batch of students together with their matches.
 */

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { query, rows, one, transaction, valuesList, chunk } from './db.js';

/** Rows come back snake_case; routes and templates expect camelCase. */
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function toCamel(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out;
}

const toCamelAll = (list) => list.map(toCamel);


/**
 * Kept so the shutdown handler in index.js still has something to await.
 * With Postgres a returned write is already durable; there is no queue to
 * drain the way there was with the file store.
 */
export async function flush() {}

// ---------------------------------------------------------------- OTP ------

export const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

/** Sign-up must follow verification within this window. */
const SIGNUP_WINDOW_MINUTES = 30;

const hashCode = (code) => createHash('sha256').update(String(code)).digest();

/**
 * Issues a 6-digit code and records it against the identifier.
 *
 * The code is stored as a SHA-256 hash. The plaintext is kept only when it is
 * going to be printed on the verify screen anyway — delivery failed, or
 * SHOW_DEV_OTP is on — so turning email on removes it from the database
 * entirely.
 *
 * Delivery is the caller's job (routes/auth.js). The outcome is recorded on the
 * row so the verify screen can state honestly whether the code was actually
 * sent.
 */
export async function issueOtp(identifier, { ip = null } = {}) {
  const code = String(randomInt(100000, 1000000));

  // Any outstanding code for this identifier is dead the moment a new one is
  // issued, so a user who taps "resend" cannot accidentally use the old one.
  await query(
    `update otp_codes set expires_at = now()
      where identifier = $1 and consumed_at is null and expires_at > now()`,
    [identifier]
  );

  await query(
    `insert into otp_codes (identifier, code_hash, expires_at, request_ip)
     values ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
    [identifier, hashCode(code), String(OTP_TTL_MINUTES), ip]
  );

  return code;
}

/** The most recent unconsumed code for an identifier. */
async function currentOtp(identifier) {
  return one(
    `select * from otp_codes
      where identifier = $1 and consumed_at is null
      order by issued_at desc limit 1`,
    [identifier]
  );
}

/** Records how an issued code was (or wasn't) delivered. */
export async function recordOtpDelivery(identifier, delivery) {
  const entry = await currentOtp(identifier);
  if (!entry) return null;

  const showOnScreen = delivery.sent !== true || process.env.SHOW_DEV_OTP === 'true';

  const updated = await one(
    `update otp_codes
        set channel = $2, delivered = $3, delivery_error = $4,
            delivered_from = $5, used_fallback = $6,
            dev_code = case when $7 then $8 else null end
      where id = $1
      returning channel, delivered as sent, delivery_error as error,
                delivered_from as from, used_fallback`,
    [
      entry.id,
      delivery.channel ?? null,
      delivery.sent === true,
      delivery.error ?? null,
      delivery.from ?? null,
      Boolean(delivery.usedFallback),
      showOnScreen,
      delivery.code ?? null,
    ]
  );

  return toCamel(updated);
}

export async function getOtpDelivery(identifier) {
  const entry = await currentOtp(identifier);
  if (!entry) return null;
  return {
    channel: entry.channel,
    sent: entry.delivered,
    error: entry.delivery_error,
    from: entry.delivered_from,
    usedFallback: entry.used_fallback,
  };
}

/**
 * Reads back an outstanding code, for the dev display only. Returns null once
 * email delivery works, because the plaintext is not stored in that case.
 */
export async function peekOtpCode(identifier) {
  const entry = await currentOtp(identifier);
  if (!entry || new Date(entry.expires_at) < new Date()) return null;
  return entry.dev_code;
}

export async function verifyOtp(identifier, code) {
  const entry = await currentOtp(identifier);
  if (!entry) return { ok: false, reason: 'No code was requested for this contact.' };
  if (new Date(entry.expires_at) < new Date()) {
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }
  if (entry.attempts >= MAX_OTP_ATTEMPTS) {
    return { ok: false, reason: 'Too many attempts. Request a new code.' };
  }

  await query('update otp_codes set attempts = attempts + 1 where id = $1', [entry.id]);

  const given = hashCode(String(code).trim());
  const stored = Buffer.from(entry.code_hash);
  const correct = given.length === stored.length && timingSafeEqual(given, stored);

  if (!correct) return { ok: false, reason: 'That code is not correct.' };

  // Mark consumed, and open the sign-up window. This row is the only proof
  // that the identifier was verified — sign-up reads it rather than trusting
  // a cookie the client could have written itself.
  await query(
    `update otp_codes
        set consumed_at = now(),
            signup_until = now() + ($2 || ' minutes')::interval
      where id = $1`,
    [entry.id, String(SIGNUP_WINDOW_MINUTES)]
  );

  return { ok: true };
}

/**
 * Confirms an identifier completed OTP verification recently and may now be
 * registered.
 *
 * This closes the sign-up bypass. Previously the verified identifier was
 * carried to the sign-up screen in an unsigned `sc_pending` cookie which the
 * server took at face value, so a hand-written Cookie header created a fully
 * verified account on any address without ever receiving a code.
 */
export async function identifierAwaitingSignup(identifier) {
  if (!identifier) return false;
  const row = await one(
    `select 1 from otp_codes
      where identifier = $1 and consumed_at is not null and signup_until > now()
      limit 1`,
    [identifier]
  );
  return Boolean(row);
}

/** Closes the sign-up window once the account exists. */
async function closeSignupWindow(client, identifier) {
  await client.query(
    'update otp_codes set signup_until = null where identifier = $1',
    [identifier]
  );
}

/** Deletes expired codes. Called on a timer; the old store never collected them. */
export async function sweepOtps() {
  const { rowCount } = await query(
    `delete from otp_codes
      where expires_at < now() - interval '1 day'
        and (signup_until is null or signup_until < now())`
  );
  return rowCount;
}

// ------------------------------------------------------------ passwords ----

const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;

/** Shortest password we will store. Long enough to matter, short enough to type. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * scrypt, from Node's own crypto — no native dependency, and memory-hard in a
 * way a plain hash is not. The salt is per-password and stored alongside the
 * key, so two people choosing the same password produce different rows.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check. Returns false for an account with no password set. */
export async function passwordMatches(stored, password) {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;

  const expected = Buffer.from(keyB64, 'base64');
  const derived = await scryptAsync(
    String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Verifies a sign-in.
 *
 * A missing account still pays the cost of a hash comparison, so the response
 * time does not reveal which addresses are registered.
 */
export async function verifyLogin(identifier, password) {
  const row = await one(
    'select id, password_hash from users where identifier = $1', [identifier]);

  const ok = await passwordMatches(
    row?.password_hash ?? DUMMY_HASH, password);

  if (!row || !ok) return null;
  return getUser(row.id);
}

// A real scrypt hash of a value nobody will guess, compared against when the
// account does not exist so that both paths take the same time.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$'
  + Buffer.alloc(SCRYPT_KEYLEN).toString('base64');

export async function setPassword(userId, password) {
  await query('update users set password_hash = $2 where id = $1',
    [userId, await hashPassword(password)]);
}

/** Whether this account can sign in with a password at all. */
export async function hasPassword(identifier) {
  const row = await one(
    'select password_hash is not null as has from users where identifier = $1',
    [identifier]);
  return row?.has ?? false;
}

// --------------------------------------------------------- rate limiting ---

/**
 * Fixed-window counter. Returns true when the caller is within its allowance.
 *
 * Used on OTP issuance, which was previously unthrottled — free email-bombing
 * of any address, and a burnt sending quota within minutes.
 */
export async function rateLimit(bucket, { limit, windowMinutes }) {
  const row = await one(
    `insert into rate_limits (bucket, window_start, count)
     values ($1, date_trunc('minute', now())
                 - (extract(minute from now())::int % $2) * interval '1 minute', 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, windowMinutes]
  );
  return { allowed: row.count <= limit, count: row.count, limit };
}

export async function sweepRateLimits() {
  const { rowCount } = await query(
    "delete from rate_limits where window_start < now() - interval '1 day'"
  );
  return rowCount;
}

// --------------------------------------------------------------- users -----

const USER_COLUMNS = `
  u.id, u.identifier, u.role, u.name, u.email, u.created_at, u.last_login_at`;

/** Attaches the document-verification map the profile screen renders. */
async function withDocuments(user) {
  if (!user) return null;
  const docs = await rows(
    `select doc_type, status, submitted_at, reviewed_at
       from document_verifications where user_id = $1`,
    [user.id]
  );
  const documentsVerified = {};
  for (const d of docs) {
    documentsVerified[d.doc_type] = {
      status: d.status,
      submittedAt: d.submitted_at,
      reviewedAt: d.reviewed_at,
    };
  }
  return { ...toCamel(user), documentsVerified, verifiedContact: true };
}

export async function findUser(identifier) {
  return withDocuments(
    await one(`select ${USER_COLUMNS} from users u where u.identifier = $1`, [identifier])
  );
}

export async function getUser(userId) {
  return withDocuments(
    await one(`select ${USER_COLUMNS} from users u where u.id = $1`, [userId])
  );
}

/**
 * Creates an account together with its consent record, and an institute row
 * when the account is one.
 *
 * One transaction, because a crash between the two previously left a user with
 * no consent record — exactly the state the terms gate exists to prevent.
 */
export async function createAccount({
  identifier, role, name = null, email = null, ip = null,
  termsVersion, isMinor = false, guardianName = null, guardianContact = null,
  instituteName = null, password = null,
}) {
  const passwordHash = password ? await hashPassword(password) : null;
  return transaction(async (client) => {
    const { rows: [user] } = await client.query(
      `insert into users (identifier, role, name, email, password_hash, last_login_at)
       values ($1, $2, $3, $4, $5, now())
       returning ${USER_COLUMNS.replaceAll('u.', '')}`,
      [identifier, role, name, email, passwordHash]
    );

    await client.query(
      `insert into consents
         (user_id, role, terms_version, is_minor, guardian_name, guardian_contact, accepted_ip)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user.id, role, termsVersion, Boolean(isMinor),
        isMinor ? guardianName : null,
        isMinor ? guardianContact : null,
        ip,
      ]
    );

    let institute = null;
    if (role === 'institute') {
      const { rows: [inst] } = await client.query(
        `insert into institutes (name, poc_user_id, poc_name)
         values ($1, $2, $3) returning *`,
        [instituteName || 'Unnamed institute', user.id, name]
      );
      institute = toCamel(inst);
    }

    await closeSignupWindow(client, identifier);

    return { user: { ...toCamel(user), documentsVerified: {}, verifiedContact: true }, institute };
  });
}

export async function updateUser(userId, patch) {
  const allowed = ['name', 'email'];
  const sets = [];
  const params = [userId];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return getUser(userId);
  await query(`update users set ${sets.join(', ')} where id = $1`, params);
  return getUser(userId);
}

export async function touchLogin(userId) {
  await query('update users set last_login_at = now() where id = $1', [userId]);
}

/**
 * Erases an account and everything attached to it.
 *
 * One statement. Every table that references a user does so with
 * `on delete cascade`, so completeness is a property of the schema rather than
 * of remembering to add a line here — the previous version deleted five arrays
 * by hand and missed the user's sessions and institute rows.
 */
export async function deleteUser(userId) {
  await query('delete from users where id = $1', [userId]);
}

// ------------------------------------------------------------ sessions -----

const SESSION_DAYS = 30;

export async function createSession(userId, { ip = null, userAgent = null } = {}) {
  const row = await one(
    `insert into sessions (user_id, expires_at, ip, user_agent)
     values ($1, now() + ($2 || ' days')::interval, $3, $4)
     returning token`,
    [userId, String(SESSION_DAYS), ip, userAgent?.slice(0, 400) ?? null]
  );
  return row.token;
}

/**
 * Looks up a live session and refreshes its last-seen stamp.
 *
 * Expiry is checked here, server-side. The old store trusted the cookie's
 * max-age alone, so a leaked token stayed valid indefinitely.
 */
export async function getSession(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token))) return null;
  const row = await one(
    `update sessions set last_seen_at = now()
      where token = $1 and expires_at > now()
      returning token, user_id, created_at, expires_at`,
    [token]
  );
  return toCamel(row);
}

export async function destroySession(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token))) return;
  await query('delete from sessions where token = $1', [token]);
}

export async function sweepSessions() {
  const { rowCount } = await query('delete from sessions where expires_at < now()');
  return rowCount;
}

// ------------------------------------------------------------- profile -----

const PROFILE_FIELDS = {
  state: 'state',
  courseLevel: 'course_level',
  category: 'category',
  income: 'income_band',
  gender: 'gender',
  disability: 'disability',
};

export async function getProfile(userId) {
  const row = await one('select * from student_profiles where user_id = $1', [userId]);
  if (!row) return {};
  return {
    state: row.state,
    courseLevel: row.course_level,
    category: row.category,
    income: row.income_band,
    gender: row.gender,
    disability: row.disability,
    updatedAt: row.updated_at,
  };
}

export async function saveProfile(userId, patch) {
  const cols = [];
  const params = [userId];
  for (const [key, column] of Object.entries(PROFILE_FIELDS)) {
    if (!(key in patch)) continue;
    params.push(patch[key]);
    cols.push([column, `$${params.length}`]);
  }

  if (!cols.length) return getProfile(userId);

  const names = cols.map(([c]) => c).join(', ');
  const values = cols.map(([, p]) => p).join(', ');
  const updates = cols.map(([c, p]) => `${c} = ${p}`).join(', ');

  await query(
    `insert into student_profiles (user_id, ${names}) values ($1, ${values})
     on conflict (user_id) do update set ${updates}, updated_at = now()`,
    params
  );
  return getProfile(userId);
}

// --------------------------------------------------- saved / applied -------

export async function toggleSaved(userId, schemeId) {
  const removed = await one(
    'delete from saved_schemes where user_id = $1 and scheme_id = $2 returning scheme_id',
    [userId, schemeId]
  );
  if (!removed) {
    // A scheme id that is not in the catalogue would violate the foreign key.
    // Ignore it rather than 500 — the id came from a URL.
    await query(
      `insert into saved_schemes (user_id, scheme_id) values ($1, $2)
       on conflict do nothing`,
      [userId, schemeId]
    ).catch(() => {});
  }
  return getSaved(userId);
}

export async function getSaved(userId) {
  return (await rows(
    'select scheme_id from saved_schemes where user_id = $1 order by saved_at desc',
    [userId]
  )).map((r) => r.scheme_id);
}

export async function markApplied(userId, schemeId) {
  await query(
    `insert into applications (user_id, scheme_id) values ($1, $2)
     on conflict (user_id, scheme_id) do nothing`,
    [userId, schemeId]
  ).catch(() => {});
  return getApplied(userId);
}

export async function getApplied(userId) {
  return (await rows(
    `select scheme_id, marked_at, status from applications
      where user_id = $1 order by marked_at desc`,
    [userId]
  )).map((r) => ({ schemeId: r.scheme_id, markedAt: r.marked_at, status: r.status }));
}

// ------------------------------------------------- document checklist ------

/** The student's ticked-off documents for one scheme. */
export async function getChecklist(userId, schemeId) {
  const list = await rows(
    'select label, have_it from document_checklist where user_id = $1 and scheme_id = $2',
    [userId, schemeId]
  );
  return Object.fromEntries(list.map((r) => [r.label, r.have_it]));
}

export async function setChecklistItem(userId, schemeId, label, haveIt) {
  await query(
    `insert into document_checklist (user_id, scheme_id, label, have_it)
     values ($1, $2, $3, $4)
     on conflict (user_id, scheme_id, label)
       do update set have_it = excluded.have_it, updated_at = now()`,
    [userId, schemeId, label, Boolean(haveIt)]
  ).catch(() => {});
}

// --------------------------------------------- document verification ------

/**
 * Records a submitted document.
 *
 * Status is 'submitted', not 'verified'. Nothing checks the file yet, and the
 * profile used to render a "Verified" badge for a document that was discarded
 * on upload.
 */
export async function submitDocument(userId, docType, { storageKey = null, filename = null } = {}) {
  await query(
    `insert into document_verifications (user_id, doc_type, storage_key, filename)
     values ($1, $2, $3, $4)
     on conflict (user_id, doc_type) do update
       set storage_key = excluded.storage_key,
           filename = excluded.filename,
           status = 'submitted',
           submitted_at = now(),
           reviewed_at = null`,
    [userId, docType, storageKey, filename]
  );
}

// ------------------------------------------------------------ consent ------

export async function getConsent(userId) {
  return toCamel(await one(
    'select * from consents where user_id = $1 order by accepted_at desc limit 1',
    [userId]
  ));
}

// ---------------------------------------------------------- institutes -----

export async function getInstituteByUser(userId) {
  return toCamel(await one('select * from institutes where poc_user_id = $1', [userId]));
}

export async function getInstitute(instituteId) {
  return toCamel(await one('select * from institutes where id = $1', [instituteId]));
}

// -------------------------------------------------------------- batches ----

export async function createDraftBatch({ instituteId, label, headers, rows: draftRows }) {
  const row = await one(
    `insert into batches (institute_id, label, status, headers, draft_rows, row_count)
     values ($1, $2, 'draft', $3, $4, $5)
     returning *`,
    [instituteId, label, headers, JSON.stringify(draftRows), draftRows.length]
  );
  return { ...toCamel(row), rows: draftRows };
}

export async function getBatch(batchId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(batchId))) return null;
  const row = await one('select * from batches where id = $1', [batchId]);
  if (!row) return null;
  return { ...toCamel(row), rows: row.draft_rows ?? [] };
}

export async function getBatches(instituteId) {
  return toCamelAll(await rows(
    `select id, institute_id, label, status, row_count, created_at, imported_at
       from batches where institute_id = $1 order by created_at desc`,
    [instituteId]
  ));
}

/**
 * Promotes a draft batch to imported, writing one row per student plus their
 * matches, all in one transaction.
 *
 * The draft is promoted in place so the preview URL's id stays valid, and the
 * raw rows are dropped once mapped.
 */
export async function importBatch(batchId, { mapping, students, runId }) {
  return transaction(async (client) => {
    await client.query(
      `update batches
          set status = 'imported', column_mapping = $2, draft_rows = null,
              row_count = $3, imported_at = now()
        where id = $1`,
      [batchId, JSON.stringify(mapping), students.length]
    );

    // A re-import replaces the previous roster rather than appending to it.
    await client.query('delete from batch_students where batch_id = $1', [batchId]);

    // Students first, in chunks, keeping row_index so the returned ids can be
    // matched back to the student they came from.
    const idByIndex = new Map();
    // Every student in one import was matched against the same catalogue at the
    // same moment, so they share a timestamp.
    const matchedAt = new Date();
    for (const group of chunk(students.map((student, index) => [
      batchId, index, student.name ?? null,
      student.externalId ?? student.studentId ?? null,
      JSON.stringify(student.profile ?? {}),
      student.matchCount ?? 0, student.topMatch ?? null,
      student.nearestDeadline ?? null, runId ?? null, matchedAt,
    ]), 500)) {
      const { text, params } = valuesList(group);
      const { rows: inserted } = await client.query(
        `insert into batch_students
           (batch_id, row_index, name, external_id, profile,
            match_count, top_match, nearest_deadline, matched_run, matched_at)
         values ${text}
         returning id, row_index`,
        params
      );
      for (const r of inserted) idByIndex.set(r.row_index, r.id);
    }

    // Then every match row for the whole batch.
    const matchRows = [];
    for (const [index, student] of students.entries()) {
      const studentId = idByIndex.get(index);
      if (!studentId) continue;
      const entries = [
        ...(student.matches ?? []).map((m, i) => ['match', i, m]),
        ...(student.nearMisses ?? []).map((m, i) => ['near_miss', i, m]),
      ];
      for (const [kind, rank, m] of entries) {
        matchRows.push([studentId, m.id, kind, rank, JSON.stringify(m)]);
      }
    }

    for (const group of chunk(matchRows, 1000)) {
      const { text, params } = valuesList(group);
      await client.query(
        `insert into batch_student_matches (batch_student_id, scheme_id, kind, rank, reason)
         values ${text}
         on conflict (batch_student_id, scheme_id) do nothing`,
        params
      );
    }

    return students.length;
  });
}

/** One page of a batch's students, searched in SQL rather than in memory. */
export async function listBatchStudents(instituteId, { q = '', batchId = null, limit = 100, offset = 0 } = {}) {
  const term = q.trim();
  return toCamelAll(await rows(
    `select bs.id, bs.batch_id, bs.name, bs.external_id, bs.match_count,
            bs.top_match, bs.nearest_deadline, bs.matched_run,
            b.label as batch_label, b.imported_at
       from batch_students bs
       join batches b on b.id = bs.batch_id
      where b.institute_id = $1 and b.status = 'imported'
        and ($2 = '' or bs.name ilike '%' || $2 || '%')
        -- Compared as text on purpose. The id arrives from a query string, and
        -- casting the parameter to uuid would turn "?batch=nonsense" into a
        -- 500 rather than an empty list. The institute is still matched above,
        -- so naming another institute's batch finds nothing either way.
        and ($5::text is null or b.id::text = $5)
      order by bs.match_count desc nulls last, bs.name
      limit $3 offset $4`,
    [instituteId, term, limit, offset, batchId]
  ));
}

export async function countBatchStudents(instituteId, { q = '', batchId = null } = {}) {
  const row = await one(
    `select count(*)::int as n
       from batch_students bs join batches b on b.id = bs.batch_id
      where b.institute_id = $1 and b.status = 'imported'
        and ($2 = '' or bs.name ilike '%' || $2 || '%')
        and ($3::text is null or b.id::text = $3)`,
    [instituteId, q.trim(), batchId]
  );
  return row.n;
}

/** One student with their stored match reasoning. */
export async function getBatchStudent(instituteId, studentId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(studentId))) return null;
  const student = await one(
    `select bs.*, b.label as batch_label, b.institute_id
       from batch_students bs join batches b on b.id = bs.batch_id
      where bs.id = $1 and b.institute_id = $2`,
    [studentId, instituteId]
  );
  if (!student) return null;

  const found = await rows(
    `select kind, rank, reason from batch_student_matches
      where batch_student_id = $1 order by kind, rank`,
    [studentId]
  );

  return {
    ...toCamel(student),
    matches: found.filter((m) => m.kind === 'match').map((m) => m.reason),
    nearMisses: found.filter((m) => m.kind === 'near_miss').map((m) => m.reason),
  };
}

/**
 * Per-batch student and match counts, aggregated in SQL.
 *
 * The overview used to sum over every student object held in memory just to
 * render five numbers.
 */
export async function batchSummaries(instituteId) {
  return toCamelAll(await rows(
    `select b.id, b.label, b.status, b.created_at, b.imported_at,
            count(bs.id)::int                                    as student_count,
            count(bs.id) filter (where bs.match_count > 0)::int   as matched_count
       from batches b
       left join batch_students bs on bs.batch_id = b.id
      where b.institute_id = $1 and b.status = 'imported'
      group by b.id
      order by b.created_at desc`,
    [instituteId]
  ));
}

/**
 * Batches whose matches predate the newest completed scrape.
 *
 * The coordinator view previously showed frozen import-time counts under a
 * banner claiming the catalogue was current. Now the staleness is knowable.
 */
export async function staleBatchCount(instituteId) {
  const row = await one(
    `select count(distinct bs.batch_id)::int as n
       from batch_students bs
       join batches b on b.id = bs.batch_id
      where b.institute_id = $1
        and bs.matched_run is distinct from (
          select id from scrape_runs where finished_at is not null
           order by finished_at desc limit 1)`,
    [instituteId]
  );
  return row.n;
}

// ----------------------------------------------------------------- ops -----

export async function stats() {
  const row = await one(`
    select
      (select count(*) from users)                              as users,
      (select count(*) from users where role = 'student')       as students,
      (select count(*) from institutes)                         as institutes,
      (select count(*) from batches where status = 'imported')  as batches,
      (select count(*) from batch_students)                     as batch_students,
      (select count(*) from consents)                           as consents,
      (select count(*) from consents where is_minor)            as minor_consents,
      (select count(*) from sessions where expires_at > now())  as active_sessions,
      (select count(*) from saved_schemes)                      as saved,
      (select count(*) from applications)                       as applications`);
  return toCamel(row);
}
