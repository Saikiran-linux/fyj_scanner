/**
 * Markdown → HTML renderer for resumes. Intentionally a tiny custom
 * parser, not `marked`, to stay consistent with this repo's "no third-
 * party deps unless we need a battle-tested one" stance.
 *
 * Supports exactly the markdown subset the tailor generator emits:
 *   # h1   ## h2   ### h3
 *   - bullet  · * bullet  (one level deep)
 *   **bold**  *italic*  `inline code`
 *   paragraphs separated by blank lines
 *   ---   horizontal rule
 *
 * Anything fancier (tables, nested lists, images, links) renders
 * unstyled — by design, since the generator's system prompt forbids
 * those shapes in resume output.
 *
 * The CSS in `wrapHtml` is print-tuned for a US-letter single-page CV:
 * 0.5" margins, ~11pt body, h1/h2 sized to feel like a real resume, and
 * compact bullet spacing so a typical tailor output fits one page.
 * Use Chrome's "Print → Save as PDF" to convert; the @page rule sets
 * margins so the PDF matches the on-screen layout.
 */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Inline formatting — runs AFTER escapeHtml so the inserted <strong>/<em>
// tags aren't themselves escaped. Order matters:
//   1. links first ([text](url)) so the url isn't chewed by * / _ matchers
//   2. strong before em (else **foo** is eaten by *foo*)
const inline = (s) =>
  s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

// Role headings often carry a right-aligned date: `### Role | Company\tJan 2024 – Present`.
// Split on the LAST tab or 2+ space gap; only treat it as a date split if
// the right side looks date-like (4-digit year or "Present"), so an
// accidental double space inside a job title doesn't break the layout.
const DATE_HINT = /\b(?:19|20)\d{2}\b|present/i;
function renderHeading(tag, text) {
  const m = text.match(/^(.+?)(?:\t+| {2,})([^\t]+)$/);
  if (m && DATE_HINT.test(m[2])) {
    const left = inline(escapeHtml(m[1].trim()));
    const right = inline(escapeHtml(m[2].trim()));
    return `<${tag} class="role-row"><span>${left}</span><span class="date">${right}</span></${tag}>`;
  }
  return `<${tag}>${inline(escapeHtml(text))}</${tag}>`;
}

export function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listOpen = false;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(escapeHtml(paraBuf.join(' ')))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (listOpen) { out.push('</ul>'); listOpen = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); closeList(); continue; }

    // Headings (most-specific first so ### isn't matched as # then ##).
    let m;
    if ((m = line.match(/^###\s+(.+)$/))) {
      flushPara(); closeList();
      out.push(renderHeading('h3', m[1]));
      continue;
    }
    if ((m = line.match(/^##\s+(.+)$/))) {
      flushPara(); closeList();
      out.push(renderHeading('h2', m[1]));
      continue;
    }
    if ((m = line.match(/^#\s+(.+)$/))) {
      flushPara(); closeList();
      out.push(renderHeading('h1', m[1]));
      continue;
    }

    // Horizontal rule.
    if (/^---+$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
      continue;
    }

    // Bullet — supports both `- foo` and `* foo`.
    if ((m = line.match(/^[-*]\s+(.+)$/))) {
      flushPara();
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
      continue;
    }

    // Otherwise a paragraph line — accumulate, flush on blank/heading/etc.
    paraBuf.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join('\n');
}

/**
 * Word-level diff of two resume markdown strings, rendered to HTML with
 * change highlighting. Used by the --compare view so a reviewer can see
 * at a glance what the tailor added vs. what it dropped from the master.
 *
 *   leftHtml  (MASTER)   — content present in master but NOT in tailored
 *                          is wrapped in <del> (struck through).
 *   rightHtml (TAILORED) — content present in tailored but NOT in master
 *                          is wrapped in <ins> (highlighted).
 *
 * How it stays compatible with the tiny markdown parser: we never touch
 * the markdown's block/inline syntax. The diff is computed over word
 * tokens, change markers are emitted as private-use-area sentinel chars
 * (which escapeHtml and the inline regexes ignore), the annotated
 * markdown is run through mdToHtml as usual, and only then are the
 * sentinels swapped for real <ins>/<del> tags. Tokens that carry
 * markdown punctuation (* ` [ ]) are never wrapped, so bold, code, and
 * link spans can't get split mid-tag.
 */
const INS_OPEN = '', INS_CLOSE = '';
const DEL_OPEN = '', DEL_CLOSE = '';
const WORD_CHAR = /[A-Za-z0-9]/;
const LINK_CHAR = /[\[\]]/;
// A token wholly wrapped in one bold or code span (with optional trailing
// punctuation), e.g. **Snowflake**, or `dbt`. These are safe to wrap in a
// change marker without splitting the markdown span.
const SELF_BOLD = /^\*\*[^*]+\*\*[.,;:)]*$/;
const SELF_CODE = /^`[^`]+`[.,;:)]*$/;

// Strip emphasis/code markers so the LCS treats "Snowflake" and
// "**Snowflake**" as the same token — adding bold to an existing word is a
// formatting change, not a content change, and must not be highlighted.
const norm = (tok) => tok.replace(/[*`]/g, '');

const shouldMark = (tok) => {
  if (!WORD_CHAR.test(tok) || LINK_CHAR.test(tok)) return false;
  if (!tok.includes('*') && !tok.includes('`')) return true; // plain word
  return SELF_BOLD.test(tok) || SELF_CODE.test(tok);         // fully-wrapped span
};

// Split into an alternating stream of whitespace runs and non-space runs,
// preserving everything so the source can be reassembled byte-for-byte.
const tokenize = (md) => md.replace(/\r\n/g, '\n').match(/\s+|\S+/g) || [];

// Longest-common-subsequence over tokens → which tokens on each side are
// "common" (unchanged). Anything not common is an add (right) or a
// remove (left).
function lcsKeptFlags(a, b) {
  const n = a.length, m = b.length, W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }
  const aKept = new Array(n).fill(false);
  const bKept = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aKept[i] = true; bKept[j] = true; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) i++;
    else j++;
  }
  return { aKept, bKept };
}

function annotate(tokens, kept, open, close) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    out += (!kept[i] && shouldMark(t)) ? open + t + close : t;
  }
  return out;
}

export function diffMarkdownToHtml(leftMd, rightMd) {
  const a = tokenize(leftMd), b = tokenize(rightMd);
  const { aKept, bKept } = lcsKeptFlags(a.map(norm), b.map(norm));
  const leftAnno = annotate(a, aKept, DEL_OPEN, DEL_CLOSE);
  const rightAnno = annotate(b, bKept, INS_OPEN, INS_CLOSE);
  const swap = (html) => html
    .replaceAll(INS_OPEN, '<ins>').replaceAll(INS_CLOSE, '</ins>')
    .replaceAll(DEL_OPEN, '<del>').replaceAll(DEL_CLOSE, '</del>');
  return {
    leftHtml: swap(mdToHtml(leftAnno)),
    rightHtml: swap(mdToHtml(rightAnno)),
  };
}

/**
 * Wrap rendered body HTML in a full document with print-tuned CSS.
 *
 * opts:
 *   title       page <title>
 *   bodies      array of { label, html } — one entry = single-column,
 *               two entries = side-by-side compare layout
 *   meta        optional one-line description shown in the header bar
 */
export function wrapHtml({ title = 'Resume', bodies, meta }) {
  if (!Array.isArray(bodies) || bodies.length === 0) {
    throw new Error('wrapHtml: bodies[] required');
  }
  const isCompare = bodies.length > 1;

  const cols = bodies.map((b) => `
    <article class="col">
      ${b.label ? `<div class="col-label">${escapeHtml(b.label)}</div>` : ''}
      <div class="resume">${b.html}</div>
    </article>
  `).join('\n');

  // CSS notes:
  // - @page sets the PDF margin when "Print → Save as PDF" is used in
  //   Chrome/Edge. Body padding is 0 so we don't double-pad on print.
  // - In compare mode the on-screen layout is two columns; in print
  //   mode each column gets its own page (page-break-before: always on
  //   the 2nd col). That way the diff is two clean A4/Letter pages
  //   instead of one cramped landscape thing.
  // - Bullet line-height + h2 margin tuned so a typical 600–900-word
  //   tailored resume fits one page at 11pt body.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    /*
     * Print-tuned, ATS-safe, single-column layout designed to mimic a
     * classic Word/Cambria resume:
     *   - serif body (Cambria → Georgia → Times fallback) at ~10.5pt
     *   - centered name + contact, thin black rule under the contact line
     *   - SECTION HEADERS in bold black uppercase with bottom rule
     *   - role line shows company on the left and dates on the right
     *     (use a tab or two-plus spaces in the markdown to split them)
     *   - pure black/white, blue only for hyperlinks (Word default)
     *   - tight margins/leading so the typical tailor output stays on
     *     one Letter page
     */
    :root {
      --ink: #000;
      --muted: #444;
      --rule: #000;
      --link: #0563C1;            /* Word default hyperlink */
      --chrome-bg: #f5f6f8;
      --chrome-rule: #d0d7de;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { font-family: "Cambria", Georgia, "Times New Roman", serif; color: var(--ink); }
    body { margin: 0; background: var(--chrome-bg); }

    /* On-screen chrome only — hidden in print so the PDF is just the resume. */
    .topbar { background: #1e1e1e; color: #f5f6f8; padding: 10px 20px; font-size: 13px; display: flex; gap: 24px; align-items: center; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .topbar strong { color: #ffd43b; }
    .topbar .hint { color: #adb5bd; margin-left: auto; }
    .topbar .legend { display: flex; gap: 12px; align-items: center; }
    .topbar .chip { padding: 1px 7px; border-radius: 3px; font-size: 12px; color: #1e1e1e; }
    .topbar .chip.ins { background: #c9f3d4; }
    .topbar .chip.del { background: #ffd2cf; text-decoration: line-through; }
    .stage {
      display: ${isCompare ? 'grid' : 'block'};
      ${isCompare ? 'grid-template-columns: 1fr 1fr; gap: 20px;' : ''}
      padding: 20px;
      max-width: ${isCompare ? '1700px' : '900px'};
      margin: 0 auto;
    }
    .col { background: #fff; border: 1px solid var(--chrome-rule); border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .col-label { background: #f1f3f5; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 12px; border-bottom: 1px solid var(--chrome-rule); font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }

    /* Resume page itself. Tight margins + 9.5pt body matches the original
       Word/Cambria density that fits ~830 words on one Letter page. */
    .resume { padding: 0.2in 0.4in; font-size: 9.5pt; line-height: 1.1; color: var(--ink); }

    /* Name — large, bold, centered. */
    .resume h1 {
      font-size: 18pt;
      margin: 0 0 1px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 0;
    }
    /* Contact line: the first paragraph after the name. Centered, small,
       with a thin black rule below to mirror the original's divider. */
    .resume h1 + p {
      text-align: center;
      font-size: 9.5pt;
      margin: 0 0 6px;
      padding-bottom: 3px;
      border-bottom: 1px solid var(--rule);
      color: var(--ink);
    }

    /* Section headers: SUMMARY, SKILLS, PROFESSIONAL EXPERIENCE, ... */
    .resume h2 {
      font-size: 10.5pt;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--ink);
      border-bottom: 1px solid var(--rule);
      padding-bottom: 0;
      margin: 3px 0 1px;
      font-weight: 700;
    }

    /* Role / company line — bold, with dates pushed to the right when the
       markdown splits role and date with a tab or 2+ spaces. */
    .resume h3 {
      font-size: 10pt;
      margin: 3px 0 0;
      font-weight: 700;
    }
    .resume h3.role-row,
    .resume h2.role-row,
    .resume h1.role-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
    }
    .resume .date { font-weight: 700; white-space: nowrap; }

    .resume p { margin: 0; }
    .resume ul { margin: 1px 0; padding-left: 14px; list-style: disc; }
    .resume li { margin: 0; padding: 0; }

    /* Keep a role/education heading glued to AT LEAST its first detail line
       (no orphaned headings at page bottom), and prevent a bullet line
       from splitting mid-word across pages. We deliberately do NOT mark
       the whole h3+ul block as "avoid break" — that would force a half-
       empty bottom-of-page rather than let the bullets flow naturally. */
    .resume li { break-inside: avoid; page-break-inside: avoid; }
    .resume h3 { break-after: avoid; page-break-after: avoid; }
    .resume h2 { break-after: avoid; page-break-after: avoid; }
    .resume strong { font-weight: 700; }
    .resume em { font-style: italic; color: var(--ink); }

    /* Diff highlighting (compare view): green = added in tailored,
       red strike-through = removed from master. Kept visible in print so
       the exported compare PDF still shows the changes. */
    .resume ins { background: #c9f3d4; text-decoration: none; border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .resume del { background: #ffd2cf; color: #8a1c12; text-decoration: line-through; border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .resume a { color: var(--link); text-decoration: underline; }
    .resume hr { border: 0; border-top: 1px solid var(--rule); margin: 8px 0; }
    .resume code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: #f1f3f5; padding: 0 3px; border-radius: 2px; }

    @page { size: Letter; margin: 0.4in 0.5in; }
    @media print {
      body { background: #fff; }
      .topbar { display: none; }
      .stage { display: block; padding: 0; max-width: none; margin: 0; }
      .col { border: 0; border-radius: 0; box-shadow: none; break-inside: avoid; }
      .col + .col { page-break-before: always; }
      .col-label { display: none; }
      .resume { padding: 0; }
      .resume a { color: var(--link); }   /* keep link colour in PDF */
    }
  </style>
</head>
<body>
  <header class="topbar">
    <strong>fyj_scanner</strong>
    <span>${escapeHtml(title)}</span>
    ${isCompare ? `<span class="legend"><span class="chip ins">added in tailored</span><span class="chip del">removed from master</span></span>` : ''}
    ${meta ? `<span class="hint">${escapeHtml(meta)}</span>` : ''}
    <span class="hint">Ctrl/Cmd + P → Save as PDF</span>
  </header>
  <main class="stage">${cols}</main>
</body>
</html>`;
}
