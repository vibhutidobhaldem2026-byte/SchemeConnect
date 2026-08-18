/**
 * Dependency-free HTML helpers.
 *
 * We only need text, links and rough block structure out of government pages,
 * so a full DOM parser would be overkill. These helpers are deliberately
 * forgiving — government CMS markup is frequently unbalanced.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', rupee: '₹',
};

export function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Removes script/style/noscript/svg blocks and HTML comments. */
export function stripNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
}

/** Collapses HTML to readable plain text, preserving block boundaries. */
export function htmlToText(html) {
  return decodeEntities(
    stripNoise(html)
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|br)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

export function getTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function getMetaDescription(html) {
  const m = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** All headings in document order: [{ level, text }]. */
export function getHeadings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(stripNoise(html)))) {
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

/** Absolute, de-duplicated links: [{ href, text }]. */
export function getLinks(html, baseUrl) {
  const seen = new Set();
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const cleaned = stripNoise(html);
  while ((m = re.exec(cleaned))) {
    let href = decodeEntities(m[1]).trim();
    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) continue;
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    const key = href + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href, text });
  }
  return out;
}

/** Parses <table> elements into arrays of row arrays. */
export function getTables(html) {
  const tables = [];
  const cleaned = stripNoise(html);
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let t;
  while ((t = tableRe.exec(cleaned))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(t[1]))) {
      const cells = [];
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c;
      while ((c = cellRe.exec(r[1]))) {
        cells.push(htmlToText(c[2]).replace(/\s+/g, ' ').trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/**
 * Bullet/list items, with the link each one carries.
 *
 * Government scheme indexes are usually `<li><a href="…">Scheme name</a></li>`,
 * where the href points at the scheme's own guideline page or PDF — often on a
 * different ministry's domain. Returning only the text threw that away, and
 * every listing entry ended up pointing back at the index it was found on.
 *
 * @returns {{text: string, href: string|null}[]}
 */
export function getListItems(html, baseUrl = null) {
  const out = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  const cleaned = stripNoise(html);
  while ((m = re.exec(cleaned))) {
    // The first anchor in the item, ignoring the nested <ul> of a dropdown.
    const beforeNested = m[1].split(/<[uo]l\b/i)[0];
    const hrefMatch = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(beforeNested);
    let href = hrefMatch?.[1] ?? null;
    if (href && /^(#|javascript:|mailto:|tel:)/i.test(href.trim())) href = null;
    if (href && baseUrl) {
      try { href = new URL(href, baseUrl).href; } catch { href = null; }
    }
    const text = htmlToText(m[1]).replace(/\s+/g, ' ').replace(/^•\s*/, '').trim();
    if (text && text.length < 500) out.push({ text, href });
  }
  return out;
}

/**
 * Returns the text that follows a heading matching `pattern`, up to the next
 * heading of the same or higher level. Government pages label their sections
 * ("Eligibility", "Documents Required"), so this is the main extraction hook.
 */
export function sectionAfterHeading(html, pattern) {
  const cleaned = stripNoise(html);
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  const marks = [];
  while ((m = re.exec(cleaned))) {
    marks.push({ level: Number(m[1]), text: htmlToText(m[2]).trim(), start: m.index, end: re.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    if (!pattern.test(marks[i].text)) continue;
    let stop = cleaned.length;
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[j].level <= marks[i].level) { stop = marks[j].start; break; }
    }
    const body = htmlToText(cleaned.slice(marks[i].end, stop)).trim();
    if (body) return body;
  }
  return '';
}
