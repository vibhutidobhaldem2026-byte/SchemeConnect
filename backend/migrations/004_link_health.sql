-- Whether a scheme's official link actually goes anywhere.
--
-- "Every result links to the scheme's official government page, with a verified
-- badge" is the highest-rated need in the MVP feature list. A sample of the
-- catalogue found roughly a quarter of those links dead — one ministry host had
-- no DNS record at all, taking seven scholarships with it — while the page
-- still showed a verified badge beside them.
--
-- A link we have not checked is not claimed to work, exactly as a criterion we
-- could not read is never counted as a pass.

alter table schemes
  add column apply_url_status     text
    check (apply_url_status in ('ok', 'redirected', 'missing', 'unreachable', 'forbidden')),
  add column apply_url_checked_at timestamptz,
  add column apply_url_detail     text;

-- The check sweeps oldest-first, so it can be resumed and spread over runs.
create index schemes_link_check_idx on schemes (apply_url_checked_at nulls first)
  where retired_at is null;

comment on column schemes.apply_url_status is
  'ok = reachable; redirected = reachable but moved; missing = 4xx; '
  'unreachable = DNS/TLS/timeout/5xx; forbidden = 403. Null means never checked, '
  'which the UI must not present as working.';
