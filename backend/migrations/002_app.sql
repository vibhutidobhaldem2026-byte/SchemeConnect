-- Application data: accounts, consent, student activity, institute batches.
--
-- Two guarantees the old JSON store could not make, both structural here:
--   * "Delete my account and data" is one statement that cascades. It cannot
--     miss a table the way five hand-written array deletions did.
--   * A consent record cannot exist without its user, and a self-declared
--     minor cannot be recorded without guardian details.

-- ------------------------------------------------------------------ users ---

create table users (
  id            uuid primary key default gen_random_uuid(),
  -- The email address or +91 number they sign in with. citext so
  -- Ananya@example.com and ananya@example.com are one account, not two.
  identifier    citext not null unique,
  role          text not null check (role in ('student', 'institute', 'ops')),
  name          text,
  email         citext,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table student_profiles (
  user_id       uuid primary key references users(id) on delete cascade,
  state         text,
  course_level  text,
  category      text,
  income_band   text,
  gender        text,
  disability    boolean,
  updated_at    timestamptz not null default now()
);

-- --------------------------------------------------------------- sessions ---
-- Server-side expiry. The old store had a 30-day cookie but no server record
-- of expiry, so a leaked token stayed valid forever.

create table sessions (
  token         uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  ip            inet,
  user_agent    text
);

create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

-- ------------------------------------------------------------------- OTPs ---
-- code_hash, never the code.
--
-- consumed_at is what closes the sign-up bypass: after verification the
-- identifier was previously carried to the sign-up screen in an unsigned
-- cookie that the server trusted. Sign-up now reads a consumed row here
-- instead, so an identifier that never received a code cannot be registered.

create table otp_codes (
  id             bigserial primary key,
  identifier     citext not null,
  code_hash      bytea not null,
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  attempts       smallint not null default 0,
  consumed_at    timestamptz,
  -- Set on the consumed row and cleared once the account exists. While it is
  -- set, and only until it expires, sign-up may use this identifier.
  signup_until   timestamptz,
  channel        text,
  delivered      boolean not null default false,
  delivery_error text,
  delivered_from text,
  used_fallback  boolean not null default false,
  request_ip     inet,
  -- The plaintext code, kept ONLY when we are going to print it on the verify
  -- screen anyway: delivery failed, or SHOW_DEV_OTP is on. When email works in
  -- production this stays null and code_hash is the only record.
  dev_code       text
);

create index otp_codes_lookup_idx on otp_codes (identifier, issued_at desc);
create index otp_codes_expiry_idx on otp_codes (expires_at);

-- Rate limiting for OTP issuance, per identifier and per IP. Without this,
-- POST /login was free email-bombing of any address and would burn the
-- sending quota in minutes.
create table rate_limits (
  bucket      text not null,
  window_start timestamptz not null,
  count       integer not null default 0,
  primary key (bucket, window_start)
);

create index rate_limits_window_idx on rate_limits (window_start);

-- ---------------------------------------------------------------- consent ---

create table consents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  role             text not null,
  terms_version    text not null,
  is_minor         boolean not null default false,
  guardian_name    text,
  guardian_contact text,
  accepted_at      timestamptz not null default now(),
  accepted_ip      inet,
  -- The DPDP Act requirement, enforced by the schema rather than by a route
  -- that could be bypassed.
  constraint consents_minor_needs_guardian
    check (not is_minor or (guardian_name is not null and guardian_contact is not null))
);

create index consents_user_idx on consents (user_id, accepted_at desc);

-- ------------------------------------------------------- student activity ---

create table saved_schemes (
  user_id    uuid not null references users(id) on delete cascade,
  scheme_id  text not null references schemes(id) on delete cascade,
  saved_at   timestamptz not null default now(),
  primary key (user_id, scheme_id)
);

create table applications (
  user_id    uuid not null references users(id) on delete cascade,
  scheme_id  text not null references schemes(id) on delete cascade,
  marked_at  timestamptz not null default now(),
  status     text not null default 'on_portal',
  primary key (user_id, scheme_id)
);

-- The P0 document readiness checklist. The checkboxes on the scheme page had
-- no name and no form, so ticking one saved nothing.
create table document_checklist (
  user_id    uuid not null references users(id) on delete cascade,
  scheme_id  text not null references schemes(id) on delete cascade,
  label      text not null,
  have_it    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, scheme_id, label)
);

-- storage_key points at object storage; a document file never enters the
-- database. Until a human or an API actually checks one, status stays
-- 'submitted' — the profile no longer claims "Verified" for an unchecked file.
create table document_verifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  doc_type     text not null check (doc_type in ('identity', 'income', 'education')),
  status       text not null default 'submitted'
                 check (status in ('submitted', 'verified', 'rejected')),
  storage_key  text,
  filename     text,
  submitted_at timestamptz not null default now(),
  reviewed_at  timestamptz,
  purge_after  timestamptz
);

create unique index document_verifications_user_type_idx
  on document_verifications (user_id, doc_type);

-- ------------------------------------------------------------- institutes ---

create table institutes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  poc_user_id  uuid references users(id) on delete set null,
  poc_name     text,
  created_at   timestamptz not null default now()
);

create index institutes_poc_idx on institutes (poc_user_id);

create table batches (
  id             uuid primary key default gen_random_uuid(),
  institute_id   uuid not null references institutes(id) on delete cascade,
  label          text not null,
  status         text not null check (status in ('draft', 'imported', 'archived')),
  headers        text[] not null default '{}',
  -- Raw uploaded rows, held only between upload and import so the preview
  -- screen can show them. Cleared on import.
  draft_rows     jsonb,
  column_mapping jsonb,
  row_count      integer not null default 0,
  created_at     timestamptz not null default now(),
  imported_at    timestamptz
);

create index batches_institute_idx on batches (institute_id, created_at desc);

-- One row per student. This was an array of up to 5,000 objects inside a
-- single record, rewritten in full on every change; now it paginates and
-- searches in SQL.
create table batch_students (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references batches(id) on delete cascade,
  row_index    integer not null,
  name         text,
  external_id  text,
  profile      jsonb not null default '{}',
  match_count  integer,
  top_match    text,
  nearest_deadline date,
  -- Which catalogue produced those matches. Null means never matched. A
  -- completed scrape makes stale rows identifiable instead of letting a
  -- coordinator read old counts under a "catalogue is current" banner.
  matched_run  uuid references scrape_runs(id) on delete set null,
  matched_at   timestamptz
);

create index batch_students_batch_idx on batch_students (batch_id, row_index);
create index batch_students_name_idx on batch_students using gin (name gin_trgm_ops);

create table batch_student_matches (
  batch_student_id uuid not null references batch_students(id) on delete cascade,
  scheme_id        text not null references schemes(id) on delete cascade,
  kind             text not null check (kind in ('match', 'near_miss')),
  rank             smallint not null,
  reason           jsonb not null default '{}',
  primary key (batch_student_id, scheme_id)
);

create index batch_student_matches_lookup_idx
  on batch_student_matches (batch_student_id, kind, rank);
