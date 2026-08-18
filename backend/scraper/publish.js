/**
 * Publishes a crawl result into PostgreSQL.
 *
 * The scraper used to write a JSON file that the site read on every request,
 * which meant a corrected income limit needed a commit and a redeploy. It now
 * writes rows, and ops corrections live alongside them as an overlay.
 *
 * Three properties this has to hold:
 *
 *   * A run is atomic. A crawl that dies halfway leaves the previous catalogue
 *     intact rather than a half-updated one.
 *   * A scheme that disappears from its source is retired, not deleted. Someone
 *     may have saved it, and its id is referenced by saved_schemes and by
 *     stored batch matches.
 *   * A human correction survives a re-scrape. Overrides are keyed by scheme
 *     and field and are never touched here.
 */

import { transaction, one, valuesList, chunk } from '../server/db.js';

/** Opens a run row. Everything a crawl writes is stamped with its id. */
export async function startRun(note = null) {
  const row = await one(
    'insert into scrape_runs (note) values ($1) returning id, started_at',
    [note]
  );
  return row;
}

export async function finishRun(runId, { ok, stats, rejections }) {
  await one(
    `update scrape_runs
        set finished_at = now(), ok = $2, stats = $3, rejections = $4
      where id = $1 returning id`,
    [runId, ok, JSON.stringify(stats ?? {}), JSON.stringify(rejections ?? [])]
  );
}

/**
 * A scheme is only matchable if it actually carries criteria.
 *
 * The database enforces this too, but demoting here means a scheme with an
 * empty eligibility block stays browsable rather than failing the insert and
 * vanishing from the catalogue entirely.
 */
function detailLevelFor(scheme) {
  const e = scheme.eligibility ?? {};
  const hasCriteria = Object.values(e).some(
    (v) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0)
  );
  return scheme.detailLevel === 'full' && hasCriteria ? 'full' : 'listing';
}

/**
 * Writes a crawl's schemes, retires anything it no longer found, and refreshes
 * source health — all in one transaction.
 */
export async function publish({ runId, schemes, sources = [] }) {
  return transaction(async (client) => {
    let full = 0;
    let listing = 0;

    // Rows are built first and written in chunks. One statement per scheme was
    // invisible on a local database and unusable against a managed one across a
    // network, where every round trip costs.
    //
    // runId appears twice per row: as first_seen_run and last_seen_run. The
    // conflict clause below updates only the latter, so a scheme keeps the run
    // that first found it.
    const schemeRows = schemes.map((s) => {
      const detailLevel = detailLevelFor(s);
      if (detailLevel === 'full') full++; else listing++;
      return [
        s.id, s.slug, s.name, s.summary ?? null, s.ministry ?? null,
        s.level === 'state' ? 'state' : 'central', s.state ?? null,
        s.benefit ? JSON.stringify(s.benefit) : null,
        s.benefitText ?? null,
        JSON.stringify(s.eligibility ?? {}),
        s.documents ?? [],
        s.deadline ?? null,
        s.applyUrl ?? s.source?.url ?? '',
        JSON.stringify(s.source ?? {}),
        s.sourceId ?? null,
        JSON.stringify(s.alternateSources ?? []),
        JSON.stringify(s.warnings ?? []),
        detailLevel,
        s.confidence ?? null,
        s.lastVerified ?? s.source?.fetchedAt ?? new Date().toISOString(),
        s.source?.contentHash ?? null,
        runId, runId,
      ];
    });

    for (const group of chunk(schemeRows, 100)) {
      const { text, params } = valuesList(group);
      await client.query(
        `insert into schemes (
           id, slug, name, summary, ministry, level, state,
           benefit, benefit_text, eligibility, documents, deadline, apply_url,
           source, source_id, alternate_sources, warnings,
           detail_level, confidence, last_verified, content_hash,
           first_seen_run, last_seen_run)
         values ${text}
         on conflict (id) do update set
           slug = excluded.slug, name = excluded.name, summary = excluded.summary,
           ministry = excluded.ministry, level = excluded.level, state = excluded.state,
           benefit = excluded.benefit, benefit_text = excluded.benefit_text,
           eligibility = excluded.eligibility, documents = excluded.documents,
           deadline = excluded.deadline, apply_url = excluded.apply_url,
           source = excluded.source, source_id = excluded.source_id,
           alternate_sources = excluded.alternate_sources, warnings = excluded.warnings,
           detail_level = excluded.detail_level, confidence = excluded.confidence,
           last_verified = excluded.last_verified, content_hash = excluded.content_hash,
           last_seen_run = excluded.last_seen_run,
           -- a scheme that came back is no longer retired
           retired_at = null,
           updated_at = now()`,
        params
      );
    }

    // Evidence is replaced wholesale: it describes this reading of the source.
    const ids = schemes.map((s) => s.id);
    for (const group of chunk(ids, 500)) {
      await client.query(
        'delete from scheme_criteria_evidence where scheme_id = any($1)', [group]);
    }

    const evidenceRows = [];
    for (const s of schemes) {
      const seen = new Set();
      for (const e of s.criteriaEvidence ?? []) {
        // One quote per field: the table is keyed that way, and a second
        // reading of the same field would otherwise collide.
        if (seen.has(e.field)) continue;
        seen.add(e.field);
        evidenceRows.push([s.id, e.field, e.text]);
      }
    }
    for (const group of chunk(evidenceRows, 1000)) {
      const { text, params } = valuesList(group);
      await client.query(
        `insert into scheme_criteria_evidence (scheme_id, field, quote)
         values ${text} on conflict (scheme_id, field) do nothing`,
        params
      );
    }

    // Retired, not deleted — a student may have saved it, and stored batch
    // matches reference its id. It stops being offered as current, and the
    // detail page can say when we last saw it on a government site.
    const { rows: retired } = await client.query(
      `update schemes set retired_at = now()
        where last_seen_run is distinct from $1 and retired_at is null
        returning id`,
      [runId]
    );

    for (const src of sources) {
      await client.query(
        `update sources
            set last_status = $2, last_error = $3, last_fetch_at = now()
          where id = $1`,
        [src.id, src.status ?? null, src.error ?? null]
      );
    }

    return { full, listing, retired: retired.length };
  });
}

/**
 * Whether the database already holds a usable catalogue.
 *
 * A crawl that produces nothing must not replace a good catalogue with an
 * empty one — the site should serve the last known-good data, flagged stale.
 */
export async function existingSchemeCount() {
  const row = await one('select count(*)::int as n from schemes where retired_at is null');
  return row.n;
}
