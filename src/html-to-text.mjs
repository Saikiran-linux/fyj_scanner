/**
 * Strip HTML to plain text. We don't need a full DOM parser — job
 * descriptions are short and the embedder only cares about words, not
 * structure. This handles the cases that show up in practice across
 * Greenhouse / Ashby / Lever / SmartRecruiters payloads:
 *
 *   - Double-entity-encoded HTML (Greenhouse ships `&lt;div&gt;` as the
 *     JSON string contents, not `<div>`). We decode entities *before*
 *     stripping tags so the tag-stripper actually sees them.
 *   - <script>/<style> blocks → dropped entirely (script payloads
 *     polluting embeddings is a real risk on some careers sites).
 *   - <br> and block-level closers → newline.
 *   - All other tags → removed; their text content is kept.
 *   - Numeric and named HTML entities → decoded (run twice: once at the
 *     start to unwrap encoded markup, once at the end to catch entities
 *     that lived as visible text inside tags).
 *   - Whitespace collapsed; max one blank line preserved between paragraphs.
 *   - Stray markdown image refs (`[https://…png]`) — Ashby's descriptionPlain
 *     ships these as text rather than as image tags — stripped, since they're
 *     pure noise for the embedder.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  trade: '™',
  copy: '©',
  reg: '®',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(input) {
  if (input == null) return '';
  let s = String(input);

  // Pre-decode pass. Greenhouse's /jobs?content=true ships its content
  // field with HTML entities encoded (the JSON string literally contains
  // `&lt;div&gt;`, not `<div>`). Without this step the tag-stripper below
  // finds no real tags and the markup ends up as visible text in the
  // output. For providers that ship raw HTML (Ashby HTML form, Lever
  // description, SR section text) this pre-pass is a no-op.
  s = decodeEntities(s);

  // Drop script/style blocks before any other processing so their text
  // content doesn't end up in the output.
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Convert structural tags to newlines so paragraphs stay separated.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|li|h[1-6]|tr|td|th|section|article)\s*>/gi, '\n');

  // Strip everything else.
  s = s.replace(/<[^>]+>/g, '');

  // Second decode pass — catches entities that lived as visible text
  // inside tags (e.g. `<p>Cadwell&rsquo;s</p>` → `Cadwell&rsquo;s` after
  // tag-stripping → `Cadwell’s` after this pass).
  s = decodeEntities(s);

  return normaliseWhitespace(s);
}

/**
 * Whitespace + stray-markup tidier. Public because the backfill script
 * runs it directly on already-stored descriptions (where the HTML has
 * already been stripped but we still want consistent whitespace and
 * to drop noise we used to keep).
 *
 * Rules:
 *   - Stray markdown-style image refs (`[https://…]`, `[image: …]`) →
 *     dropped. These show up in Ashby's `descriptionPlain` and are pure
 *     noise for the embedder.
 *   - Zero-width / non-printable Unicode (ZWSP, ZWNJ, BOM) → dropped.
 *   - Non-breaking space (U+00A0) → regular space (htmlToText decodes
 *     `&nbsp;` to U+00A0; the embedder's tokenizer can handle either,
 *     but plain space keeps `length()` comparisons predictable).
 *   - Tabs / runs of spaces → single space.
 *   - Trim each line; drop blank-only lines beyond one in a row.
 *   - Final trim.
 *
 * The result is "one sentence per line at most, one blank line between
 * paragraphs" — compact for storage and friendly for downstream display.
 */
export function normaliseWhitespace(input) {
  if (input == null) return '';
  let s = String(input);

  // Strip noise patterns. Order matters: do these before whitespace collapse
  // so they leave clean gaps rather than awkward "  " sequences.
  s = s.replace(/\[image:[^\]]*\]/gi, ' ');
  s = s.replace(/\[https?:\/\/[^\]]+\]/g, ' ');

  // Normalise unusual whitespace. NBSP → regular space; zero-width
  // joiners and BOM → dropped (they break word boundaries silently).
  s = s.replace(/ /g, ' ');
  s = s.replace(/[​-‍﻿]/g, '');

  // Normalise line endings.
  s = s.replace(/\r\n?/g, '\n');

  // Collapse intra-line whitespace.
  s = s.replace(/[ \t]+/g, ' ');
  // Trim each line.
  s = s.split('\n').map((line) => line.trim()).join('\n');
  // Cap consecutive blank lines at one.
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
