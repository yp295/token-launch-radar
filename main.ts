// Token Radar (patient-2) — the entry program.
//
// Reads the sealed DefiLlama snapshot, scores every pre-token protocol
// that could actually launch a token, and writes the ranked board, the
// dashboard's data, and the dossier the judge reads:
//
//   /output/board.json     the ranked board (rows with farm plans)
//   /output/data.js        the same board, compact, for the dashboard page
//   /output/dashboard/    the static page (copied from this repository)
//   /output/screenshots/  three renders of the page (copied from this repository)
//   /output/dossier.json  the dossier, rebuilt from /output by the kit library
//
// The model behind the board lives in lib/model.ts. On every run the
// program fits the size curve on the snapshot's live tokens, builds
// the token-odds table from the launch-eligible peers, runs the
// held-out tests, and only then scores the board — so every number the
// dashboard prints was computed from this snapshot, in this run.
//
// Node 22, standard library only, no network. The program runs twice
// and both runs must write the same bytes: every value comes from the
// snapshot and the model, nothing from the clock or the network.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue,
  buildOddsTable,
  buildRadar,
  dataScript,
  defaultParams,
  fitBaseMultiple,
  parseSnapshot,
  validateModel,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap: the judge reads at most this many bytes of dashboard source. */
const TEXT_MAX_BYTES = 65_536;
/** Screenshots the dossier accepts: at most 4, each at most 512 KiB. */
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
/** A screenshot or dashboard file name: letters, digits and . _ -, 1 to 128 characters. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A URL in dashboard source would mean the page reaches the network: refused. */
const EXTERNAL_URL = /https?:\/\//;

/** The value of `--name <value>` in the arguments, or the fallback. */
function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = argValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = argValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));

// Fit, odds and validation all come from this snapshot, in this run.
const params = defaultParams();
const fit = fitBaseMultiple(snapshot.protocols);
if (fit !== null) {
  params.fit_intercept = fit.intercept;
  params.fit_slope = fit.slope;
  params.fit_n = fit.n;
}
const odds = buildOddsTable(snapshot, params);
const validation = validateModel(snapshot);

// The dashboard must not reach the network: scan its source before copying it.
let noExternalUrls = true;
for (const name of readdirSync(join(here, 'dashboard'))) {
  const path = join(here, 'dashboard', name);
  if (!statSync(path).isFile()) continue;
  if (EXTERNAL_URL.test(readFileSync(path, 'utf8'))) noExternalUrls = false;
}

const { board, radar } = buildRadar(snapshot, params, odds, validation, {
  rows: 0,
  watchlist_covered: 0,
  watchlist_total: snapshot.watchlist.length,
  distinct_implied: 0,
  farm_steps_ok: true,
  no_external_urls: noExternalUrls,
});
// Fill the cover checks from the board that was just built.
radar.checks.rows = board.length;
radar.checks.watchlist_covered = snapshot.watchlist.filter((s) =>
  board.some((r) => r.slug === s),
).length;
radar.checks.distinct_implied = new Set(board.map((r) => r.implied_value_usd)).size;
radar.checks.farm_steps_ok = board.every(
  (r) =>
    r.farm_steps.length >= 3 &&
    r.farm_steps.length <= 12 &&
    r.farm_steps.every((s) => s.length >= 20 && s.length <= 600),
);

const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: size curve fitted on ${params.fit_n} live protocols (intercept ${params.fit_intercept.toFixed(4)}, slope ${params.fit_slope.toFixed(4)}); leave-one-out miss x${validation.loo.miss.toFixed(2)} vs flat x${validation.loo.flatMiss.toFixed(2)}\n` +
    `token radar: odds from ${odds.peers} launch-eligible peers (Brier ${odds.brierBinned.toFixed(3)} vs base ${odds.brierBase.toFixed(3)}); verdicts FARM ${radar.verdict_counts.FARM} / THIN ${radar.verdict_counts.THIN} / SKIP ${radar.verdict_counts.SKIP}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
