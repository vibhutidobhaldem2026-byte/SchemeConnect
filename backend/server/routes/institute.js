/**
 * Institute (B2B) flows, mounted at /institute: welcome, overview, batch CSV
 * upload with column mapping, batch preview, student list and the
 * consent-gated student detail.
 *
 * The privacy wall the Terms promise is enforced here: a coordinator sees match
 * counts and status, never a student's income, category or date of birth.
 */

import express from 'express';
import {
  html, raw, layout, instituteNav, navIcon, notice, emptyState, formatDate, catalogBanner,
} from '../render.js';
import { candidateSchemes, matchableSchemes, catalogMeta, catalogAgeDays } from '../catalog.js';
import { matchProfile, INCOME_OPTIONS } from '../matcher.js';
import { parseCsv, guessMapping, FIELD_OPTIONS, rowsToStudents } from '../csv.js';
import { parseXlsx, XlsxError } from '../xlsx.js';
import * as store from '../store.js';

export const router = express.Router();

function requireInstitute(req, res, next) {
  if (!req.user) return res.redirect('/start');
  if (req.user.role !== 'institute') return res.redirect('/dashboard');
  next();
}
router.use(requireInstitute);

async function institute(req) {
  return (await store.getInstituteByUser(req.user.id)) ?? { id: 'unknown', name: 'Your institute' };
}

// -------------------------------------------------------------- welcome ----

router.get('/welcome', async (req, res) => {
  const inst = await institute(req);
  res.send(layout({
    title: "You're verified",
    body: html`
      <div class="center-wrap">
        <div class="auth-card" style="text-align:center;">
          <div class="confirm-icon">✓</div>
          <h1 class="headline">You're verified, ${(req.user.name || '').split(' ')[0]}</h1>
          <p class="subtext">${inst.name} is set up on SchemeConnect.</p>
          <div class="checklist">
            <div class="ci"><span class="num">1</span>Upload your student batch as a CSV — we'll map the columns for you.</div>
            <div class="ci"><span class="num">2</span>Every student is matched against the scheme catalogue automatically.</div>
            <div class="ci"><span class="num">3</span>You see match counts per student. Their personal details stay private to them.</div>
          </div>
          <a class="btn-primary" href="/institute" style="margin-top:22px">Go to dashboard</a>
        </div>
      </div>`,
  }));
});

// ------------------------------------------------------------ overview -----

router.get('/', async (req, res) => {
  const inst = await institute(req);
  // Counted in SQL rather than by summing every student object in memory.
  const batches = await store.batchSummaries(inst.id);
  const meta = await catalogMeta();
  const ageDays = await catalogAgeDays();

  const totalStudents = batches.reduce((n, b) => n + b.studentCount, 0);
  const matchedStudents = batches.reduce((n, b) => n + b.matchedCount, 0);
  const matchRate = totalStudents ? Math.round((matchedStudents / totalStudents) * 100) : 0;

  res.send(layout({
    title: inst.name,
    body: html`
      <div class="app-shell">
        ${raw(instituteNav('overview'))}
        <main class="main-area">
          <div class="greeting">${inst.name}</div>
          <div class="greeting-sub">Welcome back, ${req.user.name}.</div>

          ${raw(catalogBanner(meta, ageDays))}

          <div class="stat-row">
            <div class="stat-card"><div class="stat-num">${totalStudents}</div><div class="stat-label">Students uploaded</div></div>
            <div class="stat-card"><div class="stat-num">${matchRate}%</div><div class="stat-label">Matched to 1+ scheme</div></div>
            <div class="stat-card"><div class="stat-num">${batches.length}</div><div class="stat-label">Batches</div></div>
          </div>

          <div class="section-label">Find a student</div>
          <form class="search-bar" method="get" action="/institute/students">
            ${raw(navIcon('browse'))}
            <input name="q" placeholder="Search by name or student ID">
            <button type="submit">Search</button>
          </form>

          <div class="section-label">Batches</div>
          ${raw(batches.length ? html`
            <div class="table-wrap">
              <table>
                <tr><th>Batch</th><th>Students</th><th>Matched</th><th>Uploaded</th><th>Status</th></tr>
                ${raw(batches.map((b) => {
                  const n = b.studentCount;
                  const m = b.matchedCount;
                  return html`<tr class="clickable" data-href="/institute/students">
                    <td class="b"><a class="row-link" href="/institute/students">${b.label}</a></td>
                    <td>${n}</td>
                    <td>${n ? Math.round((m / n) * 100) : 0}%</td>
                    <td>${formatDate(b.createdAt)}</td>
                    <td><span class="pill pill-active">Active</span></td>
                  </tr>`;
                }).join(''))}
              </table>
            </div>` : emptyState('batches', 'No batches yet',
              'Upload a CSV of your students and we will match every one of them against the scheme catalogue.'))}

          <div class="section-label">Next step</div>
          <div class="scheme-card" style="display:flex; align-items:center; justify-content:space-between; gap:16px;">
            <div>
              <div class="sc-name" style="margin-bottom:4px;">Upload a student batch</div>
              <div style="font-size:13px; color:var(--muted);">A simple CSV — name, ID, class, state, category, income.</div>
            </div>
            <a class="btn-primary btn-inline" href="/institute/upload">Upload CSV</a>
          </div>
        </main>
      </div>`,
  }));
});

// -------------------------------------------------------------- upload -----

router.get('/upload', async (req, res) => {
  res.send(layout({
    title: 'Upload a student batch',
    body: html`
      <div class="app-shell">
        ${raw(instituteNav('upload'))}
        <main class="main-area narrow">
          <a class="link-back" href="/institute">← Back to overview</a>
          <div class="greeting" style="font-size:22px;">Upload a student batch</div>
          <div class="greeting-sub">
            Add every student in one file — Excel (<b>.xlsx</b>) or <b>.csv</b> — and we'll match each of them
            automatically.
          </div>

          <a href="/institute/template.csv" class="template-link" download>⬇ Download CSV template</a>

          ${raw(notice('warn', html`
            <b>Before you upload.</b> By uploading you confirm you have a lawful basis for sharing these students'
            details, and that for any student under 18 you hold verifiable parental consent as required by the
            DPDP Act 2023. <a href="/terms#t10">Your obligations in full</a>.`))}

          <div class="info-card">
            <h3>Columns we look for</h3>
            <ul class="req-list">
              <li><span class="req-dot"></span>Student name <b>(required)</b></li>
              <li><span class="req-dot"></span>Student ID / roll number <b>(required)</b></li>
              <li><span class="req-dot"></span>Class / course <b>(required)</b></li>
              <li><span class="req-dot"></span>State <b>(required)</b></li>
              <li><span class="req-dot"></span>Category <span class="opt">(optional, improves matches)</span></li>
              <li><span class="req-dot"></span>Annual family income <span class="opt">(optional, improves matches)</span></li>
              <li><span class="req-dot"></span>Gender <span class="opt">(optional)</span></li>
            </ul>
            <div class="hint">Column names don't need to match exactly — we auto-detect and let you fix any mismatch.</div>
          </div>

          <form method="post" action="/institute/upload" id="batchForm">
            <input type="hidden" name="csv" id="batchCsvField">
            <input type="hidden" name="xlsx" id="batchXlsxField">
            <input type="hidden" name="filename" id="batchNameField">
            <div class="dropzone" id="batchDropzone">
              <div class="dz-icon">📊</div>
              <div class="dz-title">Drag your Excel or CSV file here, or click to browse</div>
              <div class="dz-sub">.xlsx or .csv · up to 5,000 rows</div>
            </div>
            <input type="file" id="batchFileInput"
                   accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
            <div id="batchChosen" hidden>
              <div class="file-chip">
                <div class="fc-left"><div class="fc-icon">📊</div><span id="batchFileName"></span></div>
                <span class="fc-remove" id="batchRemove">Remove</span>
              </div>
            </div>
            <button class="btn-primary" type="submit" id="batchSubmit" disabled>Read file &amp; preview</button>
          </form>
        </main>
      </div>`,
  }));
});

router.get('/template.csv', (req, res) => {
  const csv = [
    'Student Name,Student ID,Class,State,Category,Annual Income,Gender',
    'Ananya Sharma,SXC-2027-001,Class 11-12,Assam,ST,90000,Female',
    'Rahul Verma,SXC-2027-002,Undergraduate,Rajasthan,OBC,240000,Male',
  ].join('\n');
  res.type('text/csv').attachment('schemeconnect-batch-template.csv').send(csv);
});

/** Shared failure page for an unreadable upload. */
function uploadError(res, message) {
  return res.status(400).send(layout({
    title: 'Could not read that file',
    body: html`
      <div class="center-wrap"><div class="auth-card">
        <h1 class="headline">We couldn't read that file</h1>
        <p class="subtext">${message}</p>
        <a class="btn-primary" href="/institute/upload">Try another file</a>
        <a class="btn-ghost" href="/institute/template.csv" download>Download the CSV template</a>
      </div></div>`,
  }));
}

router.post('/upload', async (req, res) => {
  const filename = String(req.body.filename || 'batch');
  const xlsxB64 = String(req.body.xlsx || '');
  const csv = String(req.body.csv || '');

  let headers = [];
  let rows = [];

  try {
    if (xlsxB64) {
      const buffer = Buffer.from(xlsxB64, 'base64');
      ({ headers, rows } = parseXlsx(buffer));
    } else if (csv.trim()) {
      ({ headers, rows } = parseCsv(csv));
    } else {
      return res.redirect('/institute/upload');
    }
  } catch (err) {
    if (err instanceof XlsxError) return uploadError(res, err.message);
    console.error('batch upload failed:', err);
    return uploadError(res, 'Something went wrong reading that file. Try saving it as CSV and uploading again.');
  }

  if (!headers.length) {
    return uploadError(res, 'The first row should be column headings — we could not find any.');
  }
  if (!rows.length) {
    return uploadError(res, 'We found column headings but no student rows underneath them.');
  }

  const inst = await institute(req);
  const draft = await store.createDraftBatch({
    instituteId: inst.id,
    label: filename.replace(/\.(csv|xlsx)$/i, ''),
    headers,
    rows: rows.slice(0, 5000),
  });

  res.redirect(`/institute/preview/${draft.id}`);
});

// ------------------------------------------------------------- preview -----

router.get('/preview/:id', async (req, res, next) => {
  const batch = await store.getBatch(req.params.id);
  if (!batch) return next();

  const mapping = guessMapping(batch.headers);
  const unmapped = mapping.filter((m) => m.field === 'Ignore column').length;

  res.send(layout({
    title: 'Review before importing',
    body: html`
      <div class="app-shell">
        ${raw(instituteNav('upload'))}
        <main class="main-area">
          <a class="link-back" href="/institute/upload">← Choose a different file</a>
          <div class="greeting" style="font-size:22px;">Review before importing</div>
          <div class="greeting-sub">Check that each column mapped correctly. You can fix any of them below.</div>

          <div class="import-summary">
            <span><b>${batch.rows.length}</b> students detected in <b>${batch.label}</b></span>
            <span class="${unmapped ? 'flag-note' : ''}">
              ${unmapped ? `${unmapped} column(s) need review` : 'All columns mapped'}</span>
          </div>

          <form method="post" action="/institute/preview/${batch.id}">
            <div class="section-label">Column mapping</div>
            <div class="table-wrap" style="margin-bottom:18px">
              <table class="map-table">
                <tr><th>Your column</th><th>Maps to</th><th>First value</th></tr>
                ${raw(mapping.map((m, i) => html`
                  <tr>
                    <td class="b">${m.header}</td>
                    <td>
                      <select name="map_${i}" class="${m.field === 'Ignore column' ? 'warn' : ''}">
                        ${raw(FIELD_OPTIONS.map((o) => `<option ${o === m.field ? 'selected' : ''}>${o}</option>`).join(''))}
                      </select>
                    </td>
                    <td>${batch.rows[0]?.[i] ?? ''}</td>
                  </tr>`).join(''))}
              </table>
            </div>

            <div class="section-label">Preview (first rows)</div>
            <div class="table-wrap" style="margin-bottom:24px">
              <table>
                <tr>${raw(batch.headers.map((hd) => `<th>${hd}</th>`).join(''))}</tr>
                ${raw(batch.rows.slice(0, 5).map((r) => html`
                  <tr>${raw(batch.headers.map((_, i) => `<td>${(r[i] ?? '').slice(0, 40)}</td>`).join(''))}</tr>`).join(''))}
              </table>
            </div>

            ${raw(notice('warn', html`
              Importing records these students against your institute. Their eligibility answers stay private to
              them — your dashboard will show match counts only.`))}

            <button class="btn-primary btn-inline" type="submit"
                    data-busy-label="Importing ${batch.rows.length} students…">Confirm &amp; import ${batch.rows.length} students</button>
          </form>
        </main>
      </div>`,
  }));
});

router.post('/preview/:id', async (req, res, next) => {
  const batch = await store.getBatch(req.params.id);
  if (!batch) return next();

  const mapping = batch.headers.map((header, i) => ({
    header,
    field: req.body[`map_${i}`] || 'Ignore column',
  }));

  const students = rowsToStudents(batch.rows, mapping);
  const schemes = await matchableSchemes();
  const meta = await catalogMeta();
  const runId = meta.lastRun?.id ?? null;

  // Match every student at import time so a coordinator sees results
  // immediately. We keep a compact copy of the reasoning per student — the
  // whole point of the coordinator view is being able to act on it, which
  // needs the "why", not just a count.
  for (const student of students) {
    const { matches, nearMisses } = matchProfile(schemes, student.profile);

    student.matchCount = matches.length;
    student.topMatch = matches[0]?.scheme.name ?? null;
    student.nearestDeadline = matches.find((m) => m.scheme.deadline)?.scheme.deadline ?? null;

    student.matches = matches.slice(0, 12).map((m) => ({
      id: m.scheme.id,
      name: m.scheme.name,
      benefitText: m.scheme.benefitText,
      deadline: m.scheme.deadline,
      passed: m.passed.map((p) => p.label),
    }));
    student.nearMisses = nearMisses.slice(0, 6).map((m) => ({
      id: m.scheme.id,
      name: m.scheme.name,
      blockedBy: m.blockedBy.label,
      detail: m.blockedBy.detail,
    }));
  }

  // Promote the draft in place so its id stays valid for student detail links,
  // writing one row per student plus their matches in a single transaction.
  // Recording the run that produced the matches is what makes staleness
  // detectable after a re-scrape.
  await store.importBatch(batch.id, { mapping, students, runId });

  res.redirect('/institute/students');
});

// ------------------------------------------------------------ students -----

const PAGE_SIZE = 100;

router.get('/students', async (req, res) => {
  const inst = await institute(req);
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Searched and paged in SQL. This used to flatten every batch into memory and
  // filter the array, which meant loading every student to show a hundred.
  const [students, total, stale] = await Promise.all([
    store.listBatchStudents(inst.id, { q, limit: PAGE_SIZE, offset }),
    store.countBatchStudents(inst.id, { q }),
    store.staleBatchCount(inst.id),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  res.send(layout({
    title: 'Students',
    body: html`
      <div class="app-shell">
        ${raw(instituteNav('students'))}
        <main class="main-area">
          <a class="link-back" href="/institute">← Back to overview</a>
          <div class="greeting" style="font-size:22px;">Students</div>
          <div class="greeting-sub">
            Everyone from your uploaded batches, with the details you supplied and what each of them matched.
            Open a student to see the schemes and the reasons.
          </div>

          <form class="search-bar" method="get" action="/institute/students">
            ${raw(navIcon('browse'))}
            <input name="q" value="${q}" placeholder="Search by name or student ID">
            <button type="submit">Search</button>
          </form>

          ${raw(stale ? notice('warn', html`
            <b>${stale} batch${stale === 1 ? '' : 'es'} matched against an older catalogue.</b>
            The scheme data has been refreshed since these students were imported, so their counts may have
            changed. Re-import the batch to bring them up to date.`) : '')}

          ${raw(students.length ? html`
            <div class="table-wrap">
              <table>
                <tr><th>Name</th><th>Student ID</th><th>Batch</th><th>Matches</th><th>Top match</th><th>Status</th></tr>
                ${raw(students.map((s) => html`
                  <tr class="clickable" data-href="/institute/students/${s.id}">
                    <td class="b"><a class="row-link" href="/institute/students/${s.id}">${s.name}</a></td>
                    <td>${s.externalId || '—'}</td>
                    <td>${s.batchLabel}</td>
                    <td>${s.matchCount ?? 0}</td>
                    <td>${s.topMatch || '—'}</td>
                    <td><span class="pill ${s.matchCount > 0 ? 'pill-active' : 'pill-none'}">
                      ${s.matchCount > 0 ? 'Matched' : 'No match yet'}</span></td>
                  </tr>`).join(''))}
              </table>
            </div>
            <div class="foot-note" style="display:flex;gap:14px;align-items:center;margin-top:14px">
              <span>${total} student${total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''} · page ${page} of ${pages}</span>
              ${raw(page > 1 ? html`<a href="/institute/students?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ''}">← Previous</a>` : '')}
              ${raw(page < pages ? html`<a href="/institute/students?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ''}">Next →</a>` : '')}
            </div>` : emptyState('students', q ? 'No students match that search' : 'No students yet',
              q ? 'Try a different name or student ID.'
                : 'Upload a batch and every student in it will appear here with their details and match count.'))}
        </main>
      </div>`,
  }));
});

// One stable id per student rather than a batch id plus a name, which broke
// for two students sharing a name and for any name containing a slash.
router.get('/students/:studentId', async (req, res, next) => {
  const inst = await institute(req);
  const student = await store.getBatchStudent(inst.id, req.params.studentId);
  if (!student) return next();
  const batch = { label: student.batchLabel };

  const initials = (student.name || 'S').split(' ').map((c) => c[0]).slice(0, 2).join('').toUpperCase();
  const firstName = (student.name || 'this student').split(' ')[0];
  const p = student.profile ?? {};
  const row = (k, v) => html`<div class="info-row"><span class="k">${k}</span><span class="v">${v || '—'}</span></div>`;
  const incomeLabel = (band) => INCOME_OPTIONS.find((o) => o.value === band)?.label ?? null;

  res.send(layout({
    title: student.name,
    body: html`
      <div class="app-shell">
        ${raw(instituteNav('students'))}
        <main class="main-area narrow">
          <a class="link-back" href="/institute/students">← Back to students</a>

          <div class="profile-header">
            <div class="avatar">${initials}</div>
            <div>
              <div class="greeting" style="font-size:20px; margin-bottom:2px;">${student.name}</div>
              <div class="greeting-sub" style="margin-bottom:0;">${student.externalId || '—'} · ${batch.label}</div>
            </div>
          </div>

          <div class="info-card">
            <h3>Match summary</h3>
            <div class="info-row"><span class="k">Schemes matched</span><span class="v">${student.matchCount ?? 0}</span></div>
            <div class="info-row"><span class="k">Top match</span><span class="v">${student.topMatch || '—'}</span></div>
            <div class="info-row"><span class="k">Nearest deadline</span>
              <span class="v">${formatDate(student.nearestDeadline) || '—'}</span></div>
          </div>

          <div class="info-card">
            <h3>Eligibility details <span class="tag tag-self">From your upload</span></h3>
            ${raw(row('State', p.state))}
            ${raw(row('Class / course', p.courseLevel))}
            ${raw(row('Category', p.category))}
            ${raw(row('Annual family income', incomeLabel(p.income)))}
            ${raw(row('Gender', p.gender))}
            ${raw(row('Disability', p.disability === true ? 'Yes' : p.disability === false ? 'No' : 'Not stated'))}
            <div class="hint" style="margin-top:12px;font-size:12px;color:var(--muted)">
              These are the values from the batch file your institute uploaded, normalised for matching.
              A blank means that column was not mapped or the value could not be read — fill it in and
              re-upload to improve ${firstName}'s matches.
            </div>
          </div>

          ${raw(student.matches?.length ? html`
            <div class="section-label">Matched schemes (${student.matches.length})</div>
            ${raw(student.matches.map((m) => html`
              <a class="scheme-card" href="/schemes/${m.id}">
                <div class="sc-top">
                  <div class="sc-name">${m.name}</div>
                  ${raw(m.benefitText ? html`<div class="sc-amount">${m.benefitText}</div>` : '')}
                </div>
                <div class="sc-tags">
                  ${raw(m.passed.length ? html`<span class="tag tag-match">Matched on ${m.passed.join(', ').toLowerCase()}</span>` : '')}
                  ${raw(m.deadline ? html`<span class="tag tag-deadline">Closes ${formatDate(m.deadline)}</span>` : '')}
                </div>
              </a>`).join(''))}` : html`
            <div class="section-label">Matched schemes</div>
            ${raw(emptyState('search', 'No matches yet',
              `Nothing in the catalogue matched ${firstName}'s details. Check the near-misses below — often a single missing column is the cause.`))}`)}

          ${raw(student.nearMisses?.length ? html`
            <div class="section-label">Blocked by one criterion</div>
            <p class="greeting-sub" style="margin-bottom:14px">
              These schemes matched everything except one thing. Where that one thing is a missing column in
              your upload, filling it in may turn these into real matches.
            </p>
            ${raw(student.nearMisses.map((m) => html`
              <a class="scheme-card" href="/schemes/${m.id}">
                <div class="sc-top"><div class="sc-name">${m.name}</div></div>
                <div class="sc-tags"><span class="tag tag-danger">Blocked by ${m.blockedBy.toLowerCase()}</span></div>
                <div class="sc-why">${m.detail}</div>
              </a>`).join(''))}` : '')}

          <div class="info-card" style="margin-top:20px">
            <h3>What is not shown here</h3>
            <p style="font-size:13.5px;color:var(--muted);line-height:1.65;margin:0">
              Anything ${firstName} adds on their own SchemeConnect account — verification documents,
              or details they enter or correct themselves — belongs to them and is not shown to your
              institute. What you see above is the data your institute supplied.
              <a href="/terms#t10">Your obligations</a>.
            </p>
          </div>
        </main>
      </div>`,
  }));
});

router.get('/batches', (req, res) => res.redirect('/institute'));

// Superseded by /students/:studentId. Kept so an old link lands somewhere useful.
router.get('/students/:batchId/:name', (req, res) => res.redirect('/institute/students'));
