#!/usr/bin/env node
/**
 * scripts/render-resume.mjs — turn a tailored resume markdown into a
 * print-ready HTML page so you can visually compare it against the
 * master CV and "Print → Save as PDF" from any browser.
 *
 * Deliberately no Puppeteer / Chromium dep — that's a 300MB swing that
 * Browserless will eat in production (HOSTED_PLATFORM_PLAN.md Phase 4)
 * and is overkill for local dev iteration. Chrome / Edge / Firefox all
 * have excellent built-in "Save as PDF" via Ctrl+P (Cmd+P on Mac), and
 * the @page CSS rule in the rendered HTML sets the exact print margins
 * so the PDF matches what you see on screen.
 *
 * Usage:
 *   # render one file
 *   node scripts/render-resume.mjs <input.md>  [-o output.html]  [--open]
 *
 *   # side-by-side compare
 *   node scripts/render-resume.mjs --compare <left.md> <right.md> \
 *        [-o compare.html]  [--open]
 *
 * --open    auto-launch the rendered HTML in the OS default browser
 *           (uses `start` on Windows, `open` on macOS, `xdg-open` on Linux)
 *
 * Default output paths land in `output/rendered/` so they don't churn
 * the rest of the tree. Tracked-out via .gitignore alongside the tailor
 * outputs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mdToHtml, wrapHtml, diffMarkdownToHtml } from '../src/render/html.mjs';

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compare') { args.compare = true; }
    else if (a === '--open') { args.open = true; }
    else if (a === '-o' || a === '--out') { args.out = argv[++i]; }
    else if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; }
    else { args.positional.push(a); }
  }
  return args;
}

function die(code, msg) { console.error(msg); process.exit(code); }

const args = parseArgs(process.argv.slice(2));

if (args.compare) {
  if (args.positional.length !== 2) {
    die(1, 'usage: --compare <left.md> <right.md> [-o compare.html] [--open]');
  }
} else if (args.positional.length !== 1) {
  die(1, 'usage: <input.md> [-o output.html] [--open]   or   --compare <left.md> <right.md>');
}

function readMd(p) {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) die(1, `not found: ${resolved}`);
  return { path: resolved, md: fs.readFileSync(resolved, 'utf8') };
}

let html, defaultOut, title, meta;
if (args.compare) {
  const left = readMd(args.positional[0]);
  const right = readMd(args.positional[1]);
  title = `Compare · ${path.basename(left.path)} ↔ ${path.basename(right.path)}`;
  meta = `${left.md.length} chars vs ${right.md.length} chars`;
  const { leftHtml, rightHtml } = diffMarkdownToHtml(left.md, right.md);
  html = wrapHtml({
    title,
    meta,
    bodies: [
      { label: `MASTER · ${path.basename(left.path)} · struck-through = removed`, html: leftHtml },
      { label: `TAILORED · ${path.basename(right.path)} · highlighted = added`, html: rightHtml },
    ],
  });
  defaultOut = path.resolve('output/rendered',
    `compare-${path.parse(left.path).name}-vs-${path.parse(right.path).name}.html`);
} else {
  const one = readMd(args.positional[0]);
  title = path.basename(one.path, path.extname(one.path));
  meta = `${one.md.length} chars · ${one.md.split('\n').filter(Boolean).length} non-blank lines`;
  html = wrapHtml({
    title,
    meta,
    bodies: [{ html: mdToHtml(one.md) }],
  });
  defaultOut = path.resolve('output/rendered', `${path.parse(one.path).name}.html`);
}

const outPath = args.out ? path.resolve(args.out) : defaultOut;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`rendered → ${outPath}  (${html.length.toLocaleString()} bytes)`);

if (args.open) {
  // Best-effort cross-platform open. Don't fail the script if it doesn't
  // work — the file is written either way and the user can open it
  // manually.
  const opener =
    process.platform === 'win32' ? { cmd: 'cmd', args: ['/c', 'start', '""', outPath] } :
    process.platform === 'darwin' ? { cmd: 'open', args: [outPath] } :
    { cmd: 'xdg-open', args: [outPath] };
  try {
    spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' }).unref();
    console.log(`opening in default browser...`);
  } catch (e) {
    console.error(`could not auto-open (${e.message}); open the file manually`);
  }
}

console.log(`tip: in the browser, press Ctrl+P (Cmd+P on macOS) → "Save as PDF" for a clean PDF export.`);
