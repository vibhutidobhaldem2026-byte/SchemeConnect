/**
 * The scheme catalogue, read from PostgreSQL.
 *
 * This is still the website's only source of scheme data, and nothing here is
 * hand-authored — the scraper writes every row. What changed is that a human
 * can now correct a scheme without a commit and a redeploy: an ops edit is
 * stored in scheme_overrides as an overlay, so the scraped value and its
 * provenance survive underneath the correction.
 *
 * The old 5-second in-process cache is gone. It existed only because this
 * module was re-parsing a 278 KB file on every request.
 */

import { rows, one } from './db.js';
import { STATES } from '../scraper/lib/extract.js';

/**
 * Evidence and overrides come back with the scheme rather than in two follow-up
 * queries. Three round trips per listing page was most of the cost of rendering
 * one against a database in another region.
 */
/**
 * A scheme's deadline after any ops correction.
 *
 * Filtering on s.deadline alone would ignore a correction — which matters
 * precisely here, since "this closed last month" is the correction an ops
 * member is most likely to make.
 */
const EFFECTIVE_DEADLINE = `
  coalesce(
    (select nullif(o.value #>> '{}', '')::date from scheme_overrides o
      where o.scheme_id = s.id and o.field = 'deadline'),
    s.deadline)`;

const SCHEME_COLUMNS = `
  s.id, s.slug, s.name, s.summary, s.ministry, s.level, s.state,
  s.benefit, s.benefit_text, s.eligibility, s.documents, s.deadline,
  s.apply_url, s.source, s.source_id, s.alternate_sources, s.warnings,
  s.detail_level, s.confidence, s.last_verified, s.content_hash, s.retired_at,
  (select coalesce(jsonb_agg(jsonb_build_object('field', e.field, 'quote', e.quote)
                             order by e.field), '[]'::jsonb)
     from scheme_criteria_evidence e where e.scheme_id = s.id) as evidence,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'field', o.field, 'value', o.value,
            'reason', o.reason, 'edited_at', o.edited_at)), '[]'::jsonb)
     from scheme_overrides o where o.scheme_id = s.id) as overrides`;

/**
 * Rebuilds the scheme shape the templates expect, applying any ops override
 * on top of the scraped value and recording which fields were corrected.
 */
function shape(row, evidence = [], overrides = []) {
  const corrected = {};
  const applied = {};
  for (const o of overrides) {
    applied[o.field] = o.value;
    corrected[o.field] = { reason: o.reason, editedAt: o.edited_at, was: row[o.field] ?? null };
  }

  return {
    id: row.id,
    slug: row.slug,
    name: applied.name ?? row.name,
    summary: applied.summary ?? row.summary,
    ministry: applied.ministry ?? row.ministry,
    level: row.level,
    state: row.state,
    benefit: applied.benefit ?? row.benefit,
    benefitText: applied.benefit_text ?? row.benefit_text,
    eligibility: applied.eligibility ?? row.eligibility ?? {},
    criteriaEvidence: evidence.map((e) => ({ field: e.field, text: e.quote })),
    documents: applied.documents ?? row.documents ?? [],
    deadline: applied.deadline ?? row.deadline,
    applyUrl: applied.apply_url ?? row.apply_url,
    source: row.source ?? {},
    sourceId: row.source_id,
    alternateSources: row.alternate_sources ?? [],
    warnings: row.warnings ?? [],
    detailLevel: row.detail_level,
    confidence: row.confidence,
    lastVerified: row.last_verified,
    retiredAt: row.retired_at,
    // Rendered as "corrected by our team" next to the field it applies to, so a
    // human edit never silently replaces what the government source said.
    corrections: corrected,
  };
}

/** Maps rows to the scheme shape. No further queries — see SCHEME_COLUMNS. */
function hydrate(schemeRows) {
  return schemeRows.map((r) => shape(r, r.evidence ?? [], r.overrides ?? []));
}

/** Every live scheme, both tiers. */
export async function allSchemes() {
  return hydrate(await rows(
    `select ${SCHEME_COLUMNS} from schemes s
      where s.retired_at is null
      order by s.deadline nulls last, s.name`));
}

/** Only schemes whose criteria we actually read — the matchable set. */
export async function matchableSchemes() {
  return hydrate(await rows(
    `select ${SCHEME_COLUMNS} from schemes s
      where s.retired_at is null and s.detail_level = 'full'
      order by s.deadline nulls last, s.name`));
}

/**
 * Matchable schemes narrowed to those a profile could plausibly satisfy.
 *
 * A coarse filter in SQL, deliberately generous: it only excludes schemes whose
 * stated criteria cannot possibly fit. The explainer in matcher.js still runs
 * over the shortlist, so reason codes and near-misses are unchanged — this just
 * stops us loading the whole catalogue to match one student.
 */
export async function candidateSchemes(profile) {
  return hydrate(await rows(
    `select ${SCHEME_COLUMNS} from schemes s
      where s.retired_at is null
        and s.detail_level = 'full'
        -- A closed scheme is not an opportunity. It stays browsable and its
        -- page still says when it closed, but it is never offered as a match:
        -- sending a student to an application window that shut is the exact
        -- late-stage failure the research called the most severe symptom.
        and (${EFFECTIVE_DEADLINE} is null or ${EFFECTIVE_DEADLINE} >= current_date)
        -- state schemes only apply in their own state
        and (s.level = 'central' or s.state is null or s.state = $1)
        -- a scheme restricted to categories the student is not in cannot match
        and (
          s.eligibility -> 'categories' is null
          or jsonb_array_length(s.eligibility -> 'categories') = 0
          or ($2::text is not null and s.eligibility -> 'categories' ? $2)
        )
      order by s.deadline nulls last, s.name`,
    [profile.state ?? null, profile.category ?? null]));
}

/**
 * Matchable schemes excluded from the feed only because their window has shut.
 *
 * Surfaced on the dashboard so a scheme's absence is explained rather than
 * silently hidden — the same principle as the near-miss reason codes.
 */
export async function closedCandidateCount(profile) {
  const row = await one(
    `select count(*)::int as n from schemes s
      where s.retired_at is null
        and s.detail_level = 'full'
        and ${EFFECTIVE_DEADLINE} < current_date
        and (s.level = 'central' or s.state is null or s.state = $1)
        and (
          s.eligibility -> 'categories' is null
          or jsonb_array_length(s.eligibility -> 'categories') = 0
          or ($2::text is not null and s.eligibility -> 'categories' ? $2)
        )`,
    [profile.state ?? null, profile.category ?? null]);
  return row.n;
}

export async function getScheme(idOrSlug) {
  const found = await rows(
    `select ${SCHEME_COLUMNS} from schemes s where s.id = $1 or s.slug = $1 limit 1`,
    [String(idOrSlug)]
  );
  return hydrate(found)[0] ?? null;
}

export async function getSchemes(ids) {
  if (!ids?.length) return [];
  return hydrate(await rows(
    `select ${SCHEME_COLUMNS} from schemes s where s.id = any($1)`, [ids]));
}

/**
 * Ranked full-text search, replacing a JavaScript .includes() over every
 * scheme held in memory.
 */
export async function searchSchemes({ q = '', level = 'all', limit = 200 } = {}) {
  const term = q.trim();

  // The total comes back as a window function on the same query rather than a
  // second one. Ranking combines full-text weight with trigram similarity, so a
  // misspelt query still finds the scheme — the previous in-memory .includes()
  // returned nothing at all.
  const found = await rows(
    `select ${SCHEME_COLUMNS}, count(*) over () as total_count
       from schemes s
      where s.retired_at is null
        and ($1 = ''
             or s.search @@ websearch_to_tsquery('simple', $1)
             or s.name % $1
             or s.name ilike '%' || $1 || '%')
        and ($2 = 'all'
             or ($2 = 'matchable' and s.detail_level = 'full')
             or ($2 in ('central','state') and s.level = $2))
      order by
        case when $1 = '' then 0
             else ts_rank(s.search, websearch_to_tsquery('simple', $1))
                + similarity(s.name, $1) end desc,
        s.deadline nulls last, s.name
      limit $3`,
    [term, level, limit]
  );

  return {
    schemes: hydrate(found),
    total: found[0] ? Number(found[0].total_count) : 0,
  };
}

// ------------------------------------------------------------- metadata ----

/**
 * Catalogue metadata is cached briefly.
 *
 * Nearly every page renders the freshness banner, and building it costs seven
 * queries. Against a database in the same region that is invisible; against one
 * across an ocean it was most of a two-second page load. The underlying numbers
 * only change when a scrape finishes, so a short window costs nothing real —
 * and publishing a crawl clears it explicitly.
 */
const META_TTL_MS = 30_000;
let metaCache = { value: null, at: 0 };

export async function catalogMeta() {
  if (metaCache.value && Date.now() - metaCache.at < META_TTL_MS) return metaCache.value;
  const value = await buildCatalogMeta();
  metaCache = { value, at: Date.now() };
  return value;
}

async function buildCatalogMeta() {
  const counts = await one(`
    select
      count(*)::int                                          as total,
      count(*) filter (where detail_level = 'full')::int      as matchable,
      count(*) filter (where detail_level = 'listing')::int   as listing_only,
      count(*) filter (where level = 'central')::int          as central,
      count(*) filter (where level = 'state')::int            as state,
      count(*) filter (where deadline is not null)::int       as with_deadline,
      max(last_verified)                                      as generated_at
    from schemes where retired_at is null`);

  const [domains, runList, coverage] = await Promise.all([
    rows(`select distinct source ->> 'domain' as domain from schemes
           where retired_at is null and source ->> 'domain' is not null`),
    rows(`select id, started_at, finished_at, ok, stats, rejections, note
            from scrape_runs order by started_at desc limit 20`),
    coverageSummary(),
  ]);

  const runs = runList.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok,
    ...(r.stats ?? {}),
    rejections: r.rejections ?? [],
    note: r.note,
  }));

  return {
    exists: counts.total > 0,
    generatedAt: counts.generated_at,
    total: counts.total,
    matchable: counts.matchable,
    listingOnly: counts.listing_only,
    central: counts.central,
    state: counts.state,
    withDeadline: counts.with_deadline,
    sources: domains.map((d) => d.domain),
    coverage,
    lastRun: runs[0] ?? null,
    runs,
  };
}

/**
 * Age of the catalogue in days — drives the staleness banner.
 *
 * Read off the cached metadata rather than issuing its own query: every caller
 * of this also calls catalogMeta() on the same request.
 */
export async function catalogAgeDays() {
  const { generatedAt } = await catalogMeta();
  if (!generatedAt) return null;
  return Math.floor((Date.now() - new Date(generatedAt).getTime()) / 86400000);
}

/**
 * Coverage, derived from the catalogue rather than stored alongside it. The
 * old coverage.json could disagree with the schemes it described.
 */
export async function coverageSummary() {
  const perState = await rows(
    `select state, matchable_schemes, total_schemes, last_verified
       from scheme_coverage order by state`);

  const central = await one(
    `select count(*)::int as n from schemes
      where retired_at is null and level = 'central'`);

  const covered = new Set(perState.filter((r) => r.total_schemes > 0).map((r) => r.state));
  const withSchemes = STATES.filter((s) => covered.has(s));
  const without = STATES.filter((s) => !covered.has(s));

  return {
    centralSchemes: central.n,
    // Every state we know about, so a state with no schemes is still listed —
    // the point of the coverage screen is naming the gaps, not hiding them.
    perState: STATES.map((state) => {
      const found = perState.find((r) => r.state === state);
      return {
        state,
        schemes: found?.total_schemes ?? 0,
        matchable: found?.matchable_schemes ?? 0,
        lastVerified: found?.last_verified ?? null,
      };
    }),
    totalStates: STATES.length,
    statesWithStateSchemes: withSchemes,
    statesWithoutStateSchemes: without,
    coveredCount: withSchemes.length,
    uncoveredCount: without.length,
  };
}

/**
 * States we can serve. Per the PRD, a student in an uncovered state is told we
 * have no verified state data rather than shown an empty list they might read
 * as "you qualify for nothing".
 */
export async function stateCoverage(state) {
  if (!state) return { known: false, hasStateSchemes: false, centralSchemes: 0, stateSchemes: 0 };

  const row = await one(
    `select
       (select count(*)::int from schemes
         where retired_at is null and level = 'state' and state = $1) as state_schemes,
       (select count(*)::int from schemes
         where retired_at is null and level = 'central')              as central_schemes`,
    [state]
  );

  return {
    known: row.state_schemes > 0,
    hasStateSchemes: row.state_schemes > 0,
    centralSchemes: row.central_schemes,
    stateSchemes: row.state_schemes,
  };
}

/** Clears the metadata cache. Called after a crawl publishes. */
export function invalidateCatalogCache() {
  metaCache = { value: null, at: 0 };
}

// ------------------------------------------------------------ ops writes ---

/**
 * Records an ops correction as an overlay plus an audit row.
 *
 * The scraped value is never modified, so "read from socialjustice.gov.in on
 * 18 Aug" stays true and the UI can show both.
 */
export async function setOverride(schemeId, field, value, { reason, editedBy }) {
  const current = await one('select value from scheme_overrides where scheme_id = $1 and field = $2',
    [schemeId, field]);

  await rows(
    `insert into scheme_overrides (scheme_id, field, value, reason, edited_by)
     values ($1, $2, $3, $4, $5)
     on conflict (scheme_id, field) do update
       set value = excluded.value, reason = excluded.reason,
           edited_by = excluded.edited_by, edited_at = now()`,
    [schemeId, field, JSON.stringify(value), reason, editedBy ?? null]
  );

  await rows(
    `insert into scheme_revisions (scheme_id, field, old_value, new_value, reason, edited_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      schemeId, field,
      current ? JSON.stringify(current.value) : null,
      JSON.stringify(value), reason, editedBy ?? null,
    ]
  );
}

export async function clearOverride(schemeId, field, { reason, editedBy }) {
  const current = await one(
    'delete from scheme_overrides where scheme_id = $1 and field = $2 returning value',
    [schemeId, field]);
  if (!current) return;

  await rows(
    `insert into scheme_revisions (scheme_id, field, old_value, new_value, reason, edited_by)
     values ($1, $2, $3, null, $4, $5)`,
    [schemeId, field, JSON.stringify(current.value), reason, editedBy ?? null]
  );
}

export async function schemeRevisions(schemeId) {
  return rows(
    `select field, old_value, new_value, reason, edited_at
       from scheme_revisions where scheme_id = $1 order by edited_at desc limit 50`,
    [schemeId]
  );
}

// --------------------------------------------------------------- sources ---

export async function listSources() {
  return rows('select * from sources order by level, domain, id');
}
