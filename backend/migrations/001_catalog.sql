-- Catalogue: the scheme data the scraper produces and ops corrects.
--
-- Written by `npm run scrape`, read by every page that shows a scheme. This
-- used to be a 278 KB JSON file committed to git, which meant a changed income
-- limit could only be fixed by a commit and a redeploy.

create extension if not exists citext;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- sources ---
-- Was config/sources.js. In the database so ops can add a state portal without
-- a deploy, and so a source's health is recorded rather than only logged.

create table sources (
  id            text primary key,
  url           text not null,
  domain        text not null,
  adapter       text not null,
  level         text not null default 'central' check (level in ('central', 'state')),
  state         text,
  enabled       boolean not null default true,
  -- An unreachable source stays here with its reason instead of being deleted,
  -- so a gap in the catalogue is always explainable.
  last_status   text,
  last_error    text,
  last_fetch_at timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------ scrape runs ---

create table scrape_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  stats        jsonb not null default '{}',
  rejections   jsonb not null default '[]',
  note         text
);

create index scrape_runs_started_idx on scrape_runs (started_at desc);

-- ---------------------------------------------------------------- schemes ---

create table schemes (
  id             text primary key,
  slug           text not null,
  name           text not null,
  summary        text,
  ministry       text,
  level          text not null check (level in ('central', 'state')),
  state          text,

  benefit        jsonb,
  benefit_text   text,
  eligibility    jsonb not null default '{}',
  documents      text[] not null default '{}',
  deadline       date,
  apply_url      text not null,

  source         jsonb not null,
  source_id      text references sources(id) on delete set null,
  alternate_sources jsonb not null default '[]',
  warnings       jsonb not null default '[]',

  -- The two-tier invariant, enforced by the database rather than only by code:
  -- a scheme may only be matchable if it actually carries criteria. This is
  -- what stops an absent criterion from ever being read as a pass.
  detail_level   text not null check (detail_level in ('full', 'listing')),
  constraint schemes_matchable_needs_criteria
    check (detail_level = 'listing' or eligibility <> '{}'::jsonb),

  confidence     numeric(3,2),
  last_verified  timestamptz not null,
  content_hash   text,

  first_seen_run uuid references scrape_runs(id) on delete set null,
  last_seen_run  uuid references scrape_runs(id) on delete set null,
  -- Set when a run no longer finds a scheme. It stays readable (someone may
  -- have saved it) but stops being offered as current.
  retired_at     timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index schemes_slug_idx on schemes (slug);
create index schemes_browse_idx on schemes (detail_level, level, state) where retired_at is null;
create index schemes_deadline_idx on schemes (deadline) where deadline is not null;
create index schemes_eligibility_idx on schemes using gin (eligibility jsonb_path_ops);

-- Ranked search, replacing an in-memory .includes() over every scheme.
-- 'simple' rather than 'english': scheme names are proper nouns and acronyms
-- where stemming does more harm than good.
alter table schemes add column search tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(ministry, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'C')
  ) stored;

create index schemes_search_idx on schemes using gin (search);
-- Trigram index for the short, misspelt queries a search box actually gets.
create index schemes_name_trgm_idx on schemes using gin (name gin_trgm_ops);

-- ------------------------------------------------------ criteria evidence ---
-- Every extracted criterion keeps the sentence it was read from, so a student
-- can check our reading against the original. This is the product's best
-- feature; it gets its own table rather than living inside a JSON column.

create table scheme_criteria_evidence (
  scheme_id  text not null references schemes(id) on delete cascade,
  field      text not null,
  quote      text not null,
  primary key (scheme_id, field)
);

-- -------------------------------------------------------------- overrides ---
-- An ops correction is an overlay, never an overwrite. The scraped row stays
-- intact, so "read from socialjustice.gov.in on 18 Aug" remains true, and the
-- UI can show a corrected field as human-corrected next to what was scraped.

create table scheme_overrides (
  scheme_id  text not null references schemes(id) on delete cascade,
  field      text not null,
  value      jsonb not null,
  reason     text not null,
  edited_by  uuid,
  edited_at  timestamptz not null default now(),
  primary key (scheme_id, field)
);

-- Full history of corrections, including reverts. Append-only.
create table scheme_revisions (
  id         bigserial primary key,
  scheme_id  text not null references schemes(id) on delete cascade,
  field      text not null,
  old_value  jsonb,
  new_value  jsonb,
  reason     text,
  edited_by  uuid,
  edited_at  timestamptz not null default now()
);

create index scheme_revisions_scheme_idx on scheme_revisions (scheme_id, edited_at desc);

-- ----------------------------------------------------------- coverage view ---
-- Derived, not stored. The old coverage.json could disagree with the catalogue
-- it described; a view cannot.

create view scheme_coverage as
  select
    state,
    count(*) filter (where detail_level = 'full')    as matchable_schemes,
    count(*)                                         as total_schemes,
    max(last_verified)                               as last_verified
  from schemes
  where retired_at is null and level = 'state'
  group by state;
