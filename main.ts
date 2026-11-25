// Token Launch Radar — entrypoint, patient-4.
//
// Reads the sealed snapshot, fits the ensemble size curve, scores every
// rankable pre-token protocol, validates the curve on five held-out tests,
// checks rank stability over 200 bootstrap refits, and writes the board,
// the dashboard and the dossier. Two runs write identical bytes: fixed
// seeds, no clock, no network, no randomness outside the seeded generator.
//
//   node main.ts [snapshot.json] [output-dir]
// Defaults: /input/snapshot.json and /output (the sandbox paths).

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  ageDays,
  baseMultiple,
  bootstrapRanks,
  buildOdds,
  closestNeighbours,
  ensembleFit,
  farmEconomics,
  farmPlan,
  clearsBar,
  isLaunchEligible,
  isPreToken,
  isRankable,
  median,
  modelStake,
  scoreProtocol,
  setAsideReason,
  stakeToClear,
  validateCurve,
  verdictAt,
  BOOTSTRAP_REFITS,
  BOOTSTRAP_SEED,
  MIN_LIVE_FOR_FIT,
  RANDOM_SEED,
  type Snapshot,
  type SnapshotProtocol,
} from './lib/model.ts';

const MODEL_VERSION = 'patient-4';
const SNAPSHOT_PATH = process.argv[2] ?? '/input/snapshot.json';
const OUT_DIR = process.argv[3] ?? '/output';
const REPO_DIR = dirname(fileURLToPath(import.meta.url));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (msg: string): never => {
  throw new Error(`patient-4: ${msg}`);
};

function main(): void {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  const protocols = snap.protocols;
  const watchlist = new Set(snap.watchlist);

  // The calibration set: live tokens with a reported market cap.
  const comps = protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const liveCount = protocols.filter((p) => !isPreToken(p)).length;
  const preCount = protocols.filter(isPreToken).length;

  // Unknown ages fall back to the pre-token median age, from the snapshot.
  const knownPreAges = protocols
    .filter(isPreToken)
    .map(ageDays)
    .filter((a): a is number => a !== null);
  const unknownAge = median(knownPreAges);

  const odds = buildOdds(protocols);
  const peers = protocols.filter(isLaunchEligible);

  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const fit = comps.length >= MIN_LIVE_FOR_FIT ? ensembleFit(xs, ys) : null;
  const beta = fit === null ? null : fit.beta;

  const validation = validateCurve(comps, peers, odds.baseRate, unknownAge);
  const sigma = validation.sigma;

  const ctx = { beta, sigma, odds, unknownAge };
  const ranked = protocols
    .filter(isRankable)
    .map((p) => {
      const row = scoreProtocol(p, ctx);
      row.watchlist = watchlist.has(p.slug);
      return row;
    })
    .sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1));

  const stability = bootstrapRanks(ranked, comps);
  const livePriced = comps;

  // The live-token view: the 30 largest market caps, CEX excluded.
  const liveTop = protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: p.mcap_usd! / p.tvl_usd,
    }));

  // Census: every protocol accounted for.
  const setAside = new Map<string, number>();
  for (const p of protocols) {
    if (!isPreToken(p)) continue;
    const reason = setAsideReason(p);
    if (reason !== null) setAside.set(reason, (setAside.get(reason) ?? 0) + 1);
  }

  const board = ranked.map((row, i) => {
    const st = stability.get(row.slug)!;
    const stake = modelStake(row.tvl);
    const verdict = verdictAt(row, stake);
    const atPoint = farmEconomics(row.tvl, row.chains, row.hold, row.implied, stake);
    const atP75 = farmEconomics(row.tvl, row.chains, row.hold, row.p75, stake);
    return {
      slug: row.slug,
      name: row.name,
      rank: i + 1,
      rank_lo: st.rankLo,
      rank_hi: st.rankHi,
      top20_share: Math.round(st.top20Share * 1000) / 1000,
      watchlist: row.watchlist,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl,
      change_7d: row.change7d,
      age_days: row.age,
      hold_days: row.hold,
      base_multiple: Math.round(row.baseMultiple * 1e6) / 1e6,
      growth_mult: Math.round(row.growthMult * 1e6) / 1e6,
      maturity_mult: Math.round(row.maturityMult * 1e6) / 1e6,
      launch_value_usd: row.launch,
      odds: Math.round(row.odds * 1e6) / 1e6,
      odds_cell: row.oddsCell,
      odds_have: row.oddsHave,
      odds_total: row.oddsTotal,
      implied_value_usd: row.implied,
      range_p25_usd: row.p25,
      range_p75_usd: row.p75,
      range_p10_usd: row.p10,
      range_p90_usd: row.p90,
      verdict,
      stake_usd: stake,
      stake_to_farm_usd: stakeToClear(row.tvl, row.chains, row.hold, row.p25),
      neighbours: closestNeighbours(row, livePriced),
      farm_steps: farmPlan(row),
      pays_at_point: clearsBar(atPoint),
      pays_at_p75: clearsBar(atP75),
    };
  });

  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.verdict]++;
  const middleOnlyP75 = board.filter((r) => r.verdict === 'THIN' && !r.pays_at_point && r.pays_at_p75).length;
  const thinAtPoint = board.filter((r) => r.verdict === 'THIN' && r.pays_at_point).length;
  const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const medianMoveExact = median(board.map((r) => r.rank_hi - r.rank_lo));

  // ---- self-check gate: fail loudly rather than write a bad board ----
  if (board.length !== 198) fail(`expected 198 rows, got ${board.length}`);
  const covered = snap.watchlist.filter((s) => board.some((r) => r.slug === s));
  if (covered.length !== 40) fail(`watchlist coverage ${covered.length}/40`);
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) {
      fail(`implied values not strictly decreasing at rank ${i + 1}`);
    }
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      fail(`${r.slug}: ${r.farm_steps.length} farm steps`);
    }
    for (const step of r.farm_steps) {
      if (step.length < 20 || step.length > 600) {
        fail(`${r.slug}: farm step ${step.length} chars`);
      }
    }
    if (r.rank_lo === undefined || r.rank_hi === undefined) fail(`${r.slug}: no rank range`);
  }
  if (verdictCounts.FARM + verdictCounts.THIN + verdictCounts.SKIP !== 198) {
    fail('verdict counts do not sum to 198');
  }

  const meta = {
    version: MODEL_VERSION,
    as_of: snap.as_of,
    fit: {
      ols: fit === null ? null : fit.ols,
      quantile: fit === null ? null : fit.quantile,
      ensemble: beta,
      n_live: comps.length,
      r2: Math.round(validation.r2 * 1000) / 1000,
      r2_fuller: Math.round(validation.r2Fuller * 1000) / 1000,
      growth_coef: Math.round(validation.growthCoef * 1000) / 1000,
      growth_coef_fuller: Math.round(validation.growthCoefFuller * 1000) / 1000,
      age_coef: Math.round(validation.ageCoef * 1000) / 1000,
      sigma: Math.round(validation.sigma * 10000) / 10000,
      factor_25_75: Math.round(10 ** (0.674 * validation.sigma) * 100) / 100,
      factor_10_90: Math.round(10 ** (1.645 * validation.sigma) * 100) / 100,
      coverage_25_75: Math.round(validation.coverage2575 * 1000) / 1000,
      coverage_10_90: Math.round(validation.coverage1090 * 1000) / 1000,
      unknown_age_days: unknownAge,
    },
    tests: {
      loo: Math.round(validation.loo * 100) / 100,
      loo_flat: Math.round(validation.looFlat * 100) / 100,
      low_high: Math.round(validation.lowHigh * 100) / 100,
      low_high_flat: Math.round(validation.lowHighFlat * 100) / 100,
      high_low: Math.round(validation.highLow * 100) / 100,
      high_low_flat: Math.round(validation.highLowFlat * 100) / 100,
      random10: Math.round(validation.rand10 * 100) / 100,
      random10_flat: Math.round(validation.rand10Flat * 100) / 100,
      walk_forward: Math.round(validation.walkForward * 100) / 100,
      walk_forward_flat: Math.round(validation.walkForwardFlat * 100) / 100,
      walk_test_n: validation.walkTestN,
      random_seed: `0x${RANDOM_SEED.toString(16)}`,
    },
    odds: {
      brier_binned: Math.round(validation.brier * 1000) / 1000,
      brier_base: Math.round(validation.brierBase * 1000) / 1000,
      base_rate: Math.round(odds.baseRate * 1000) / 1000,
      peers: odds.peers,
    },
    verdicts: {
      FARM: verdictCounts.FARM,
      THIN: verdictCounts.THIN,
      SKIP: verdictCounts.SKIP,
      thin_only_at_p75: middleOnlyP75,
      thin_at_point: thinAtPoint,
    },
    census: {
      total: protocols.length,
      live: liveCount,
      pre_token: preCount,
      ranked: board.length,
      watchlist: 40,
      set_aside: [...setAside.entries()].map(([reason, n]) => ({ reason, n })),
    },
    totals: { implied_usd: totalImplied },
    bootstrap: {
      refits: BOOTSTRAP_REFITS,
      seed: `0x${BOOTSTRAP_SEED.toString(16)}`,
      median_rank_move: medianMoveExact,
    },
  };

  // ---- write outputs ----
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(join(OUT_DIR, 'dashboard'), { recursive: true });
  mkdirSync(join(OUT_DIR, 'screenshots'), { recursive: true });

  const boardBytes = Buffer.from(`${JSON.stringify(board, null, 1)}\n`, 'utf8');
  if (boardBytes.length > 8 * 1024 * 1024) fail('board.json over 8 MiB');
  writeFileSync(join(OUT_DIR, 'board.json'), boardBytes);

  const dashboardSrc = join(REPO_DIR, 'dashboard');
  for (const name of ['index.html', 'app.css', 'app.js']) {
    copyFileSync(join(dashboardSrc, name), join(OUT_DIR, 'dashboard', name));
  }
  const dataJs = `window.RADAR = ${JSON.stringify({ meta, rows: board, live: liveTop }, null, 1)};\n`;
  const dataBytes = Buffer.from(dataJs, 'utf8');
  writeFileSync(join(OUT_DIR, 'dashboard', 'data.js'), dataBytes);

  const shotsSrc = join(REPO_DIR, 'screenshots');
  const shots = existsSync(shotsSrc)
    ? readdirSync(shotsSrc).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort()
    : [];
  if (shots.length < 3) fail(`need 3 screenshots in repo/screenshots, found ${shots.length}`);
  for (const name of shots) copyFileSync(join(shotsSrc, name), join(OUT_DIR, 'screenshots', name));

  const srcBytes =
    readFileSync(join(OUT_DIR, 'dashboard', 'index.html')).length +
    readFileSync(join(OUT_DIR, 'dashboard', 'app.css')).length +
    readFileSync(join(OUT_DIR, 'dashboard', 'app.js')).length;
  if (srcBytes > 65536) fail(`dashboard source ${srcBytes} bytes, over 64 KiB`);
  for (const name of ['index.html', 'app.css', 'app.js', 'data.js']) {
    const text = readFileSync(join(OUT_DIR, 'dashboard', name), 'utf8');
    if (/https?:\/\//.test(text)) fail(`dashboard source ${name} contains a URL`);
  }

  const dossier = buildDossier(OUT_DIR, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 512 * 1024 },
    dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  });
  writeFileSync(join(OUT_DIR, 'dossier.json'), dossier);

  // ---- report ----
  const fmt = (n: number, d = 2) => n.toFixed(d);
  console.log(`model ${MODEL_VERSION} — snapshot ${snap.as_of}, ${protocols.length} protocols`);
  console.log(`fit OLS [${fit!.ols.map((v) => fmt(v, 4)).join(', ')}] quantile [${fit!.quantile.map((v) => fmt(v, 4)).join(', ')}] ensemble [${beta!.map((v) => fmt(v, 4)).join(', ')}]`);
  console.log(`R2 size-only ${fmt(validation.r2, 3)} fuller ${fmt(validation.r2Fuller, 3)} growth ${fmt(validation.growthCoef, 2)} (fuller ${fmt(validation.growthCoefFuller, 2)}) age ${fmt(validation.ageCoef, 2)}`);
  console.log(`sigma LOO ${fmt(validation.sigma, 4)} factor P25-P75 x${fmt(10 ** (0.674 * validation.sigma), 2)} P10-P90 x${fmt(10 ** (1.645 * validation.sigma), 2)} coverage ${(validation.coverage2575 * 100).toFixed(1)}% / ${(validation.coverage1090 * 100).toFixed(1)}%`);
  console.log(`LOO x${fmt(validation.loo)} (flat x${fmt(validation.looFlat)}) low->high x${fmt(validation.lowHigh)} (x${fmt(validation.lowHighFlat)}) high->low x${fmt(validation.highLow)} (x${fmt(validation.highLowFlat)})`);
  console.log(`random x10 x${fmt(validation.rand10)} (flat x${fmt(validation.rand10Flat)}) walk-forward x${fmt(validation.walkForward)} (flat x${fmt(validation.walkForwardFlat)}, test n=${validation.walkTestN})`);
  console.log(`odds Brier binned ${fmt(validation.brier, 3)} base ${fmt(validation.brierBase, 3)} base rate ${fmt(odds.baseRate, 3)} peers ${odds.peers}`);
  console.log(`rows ${board.length} watchlist ${covered.length}/40 total implied $${totalImplied.toLocaleString('en-US')} top1 ${board[0]!.slug} $${board[0]!.implied_value_usd.toLocaleString('en-US')} rank198 ${board[197]!.slug} $${board[197]!.implied_value_usd.toLocaleString('en-US')}`);
  console.log(`top20 ${board.slice(0, 20).map((r) => r.slug).join(' ')}`);
  console.log(`verdicts FARM ${verdictCounts.FARM} THIN ${verdictCounts.THIN} SKIP ${verdictCounts.SKIP} thin-only-at-P75 ${middleOnlyP75} thin-at-point ${thinAtPoint}`);
  console.log(`bootstrap ${BOOTSTRAP_REFITS} refits median rank move ${medianMoveExact} top5 ranges ${board.slice(0, 5).map((r) => `${r.slug} ${r.rank_lo}-${r.rank_hi}`).join(' ')}`);
  console.log(`unknown-age fallback ${unknownAge} days; set aside: ${[...setAside.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`dashboard source ${srcBytes} bytes (index+css+js); board ${boardBytes.length} bytes; dossier ${dossier.length} bytes`);
  console.log(`sha256 board.json ${sha256(boardBytes)}`);
  console.log(`sha256 data.js ${sha256(dataBytes)}`);
  console.log(`sha256 dossier.json ${sha256(dossier)}`);
  console.log('gate: 198 rows, watchlist 40/40, implied strictly decreasing, farm steps 3-12 x 20-600 chars, no URL in dashboard source, rank ranges for all rows — PASS');
}

main();
