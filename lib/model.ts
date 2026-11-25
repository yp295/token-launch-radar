// Token Launch Radar — model library, patient-4.
//
// Everything here is computed from the snapshot itself: no protocol name is
// special-cased, no field the snapshot does not carry is invented. The size
// curve is an ensemble of two fits on the live tokens (ordinary least
// squares and a median regression), averaged. The rest — growth and maturity
// priors, token odds from the peers' own record, the range from held-out
// misses, the farm verdict from a range test — follows the specification in
// MODEL.md. Deterministic throughout: fixed seeds, no clock, no randomness
// outside the seeded generator.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

export type Beta = [number, number];

export const AS_OF = '2026-11-14';
export const FLAT_MULTIPLE = 0.25;
export const MULTIPLE_LOW = 0.03;
export const MULTIPLE_HIGH = 0.7;
export const MIN_LIVE_FOR_FIT = 10;
export const TBILL_APR = 0.045;
export const DROP_SHARE = 0.05;
export const RANDOM_SEED = 0x20261114;
export const BOOTSTRAP_SEED = 0x20261125;
export const BOOTSTRAP_REFITS = 200;

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;

export function ageDays(p: SnapshotProtocol): number | null {
  if (!p.listed_at) return null;
  const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  return Math.max(0, Math.floor((asOf - listed) / DAY_MS));
}

/** The median of a list of numbers (average of the two middles when even). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------- the rule

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const WRAPPED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_FIRST_WORD = new Set([
  'binance',
  'coinbase',
  'kraken',
  'okx',
  'bybit',
  'bitfinex',
  'huobi',
  'kucoin',
  'gemini',
  'bitstamp',
  'bitget',
  'mexc',
  'gate',
]);

/** Why a protocol can never launch a token of its own, or null when it can. */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return p.category;
  if (VERSION_SUFFIX.test(p.name)) return 'Versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'Wrapped or staked word';
  const first = p.name.split(/\s+/)[0]!.toLowerCase().replace(/\.+$/, '');
  if (EXCHANGE_FIRST_WORD.has(first)) return 'Exchange name';
  return null;
}

export function isLaunchEligible(p: SnapshotProtocol): boolean {
  return setAsideReason(p) === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && isLaunchEligible(p);
}

// ---------------------------------------------------------------- seeded rng

/** mulberry32: a small deterministic generator, seeded, no Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the size curve

function solveTwoByTwo(
  sxx: number,
  sx: number,
  sw: number,
  sxy: number,
  sy: number,
): Beta {
  const det = sw * sxx - sx * sx;
  const slope = (sw * sxy - sx * sy) / det;
  return [(sy - slope * sx) / sw, slope];
}

/** Ordinary least squares of log10(mcap/TVL) on log10(TVL). */
export function olsFit(xs: number[], ys: number[]): Beta {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  return solveTwoByTwo(sxx, sx, xs.length, sxy, sy);
}

function weightedFit(xs: number[], ys: number[], w: number[]): Beta {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += w[i]!;
    sx += w[i]! * xs[i]!;
    sy += w[i]! * ys[i]!;
    sxx += w[i]! * xs[i]! * xs[i]!;
    sxy += w[i]! * xs[i]! * ys[i]!;
  }
  return solveTwoByTwo(sxx, sx, sw, sxy, sy);
}

function totalAbsResidual(beta: Beta, xs: number[], ys: number[]): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += Math.abs(ys[i]! - (beta[0] + beta[1] * xs[i]!));
  return total;
}

/**
 * Median regression (quantile tau = 0.5): the line minimising the total
 * absolute residual. For a two-parameter line a minimiser is always attained
 * at a line through two of the points, so the exact vertex search below
 * checks every such line; an IRLS pass is run alongside and the better of
 * the two (by total absolute residual, ties to the vertex search) is kept,
 * which covers degenerate point sets where no pair line is optimal.
 */
export function quantileFit(xs: number[], ys: number[]): Beta {
  const n = xs.length;
  let best: Beta | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (xs[i] === xs[j]) continue;
      const slope = (ys[j]! - ys[i]!) / (xs[j]! - xs[i]!);
      const cand: Beta = [ys[i]! - slope * xs[i]!, slope];
      let cost = 0;
      for (let k = 0; k < n; k++) cost += Math.abs(ys[k]! - (cand[0] + cand[1] * xs[k]!));
      if (cost < bestCost - 1e-12) {
        bestCost = cost;
        best = cand;
      }
    }
  }
  // IRLS: reweighted least squares with weights 1 / max(|residual|, eps).
  let irls = olsFit(xs, ys);
  for (let step = 0; step < 500; step++) {
    const w = ys.map((y, i) => 1 / Math.max(Math.abs(y - (irls[0] + irls[1] * xs[i]!)), 1e-8));
    const next = weightedFit(xs, ys, w);
    const move = Math.max(Math.abs(next[0] - irls[0]), Math.abs(next[1] - irls[1]));
    irls = next;
    if (move < 1e-13) break;
  }
  if (best === null) return irls;
  return totalAbsResidual(irls, xs, ys) < bestCost - 1e-12 ? irls : best;
}

export interface EnsembleFit {
  ols: Beta;
  quantile: Beta;
  beta: Beta;
}

/** The patient-4 curve: the average of the OLS line and the median line. */
export function ensembleFit(xs: number[], ys: number[]): EnsembleFit {
  const ols = olsFit(xs, ys);
  const quantile = quantileFit(xs, ys);
  return { ols, quantile, beta: [(ols[0] + quantile[0]) / 2, (ols[1] + quantile[1]) / 2] };
}

/** The fitted multiple at a TVL, clamped; flat when too few live tokens. */
export function baseMultiple(beta: Beta | null, tvl: number): number {
  if (beta === null) return FLAT_MULTIPLE;
  const raw = 10 ** (beta[0] + beta[1] * Math.log10(tvl));
  return Math.min(MULTIPLE_HIGH, Math.max(MULTIPLE_LOW, raw));
}

// ---------------------------------------------------------------- growth, age

/** Log-damped growth: a noisy week cannot dominate the value. */
export function growthMultiplier(change7d: number | null): number {
  const g = change7d === null ? 0 : Math.min(200, Math.max(-50, change7d));
  return 1 + 0.3 * Math.log(1 + g / 100);
}

/** Saturating maturity: the overdue premium levels off after a year. */
export function maturityMultiplier(age: number | null, unknownAge: number): number {
  const a = age === null ? unknownAge : Math.max(0, age);
  return 0.6 + (0.4 * a) / (a + 365);
}

/** Hold length of the farm plan, in days, by age with no token. */
export function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 540) return 60;
  return 30;
}

/** Deposit size of the farm plan, in dollars, by TVL band. */
export function depositUsd(tvl: number): number {
  if (tvl >= 1e9) return 300;
  if (tvl >= 100e6) return 200;
  if (tvl >= 25e6) return 100;
  return 50;
}

// ---------------------------------------------------------------- token odds

export function ageBand(age: number | null): string {
  if (age === null) return 'age?';
  if (age < 180) return '<6mo';
  if (age < 540) return '6-18mo';
  if (age < 1095) return '18mo-3yr';
  return '3yr+';
}

export function tvlBand(tvl: number): string {
  if (tvl < 50e6) return '<$50M';
  if (tvl < 100e6) return '$50-100M';
  if (tvl < 1e9) return '$100M-1B';
  return '>$1B';
}

export interface OddsTable {
  oddsOf(p: SnapshotProtocol): number;
  cellOf(p: SnapshotProtocol): { label: string; have: number; total: number; rate: number };
  baseRate: number;
  peers: number;
}

/**
 * Token odds: the share of launch-eligible peers in the same age-and-size
 * cell that already record a token, smoothed toward the TVL band's overall
 * rate with a 10-protocol prior, clamped to [0.05, 0.98].
 */
export function buildOdds(protocols: SnapshotProtocol[]): OddsTable {
  const peers = protocols.filter(isLaunchEligible);
  const cells = new Map<string, { total: number; have: number }>();
  const bands = new Map<string, { total: number; have: number }>();
  let haveAll = 0;
  for (const p of peers) {
    const key = `${ageBand(ageDays(p))}|${tvlBand(p.tvl_usd)}`;
    const cell = cells.get(key) ?? { total: 0, have: 0 };
    cell.total++;
    if (!isPreToken(p)) {
      cell.have++;
      haveAll++;
    }
    cells.set(key, cell);
    const band = bands.get(tvlBand(p.tvl_usd)) ?? { total: 0, have: 0 };
    band.total++;
    if (!isPreToken(p)) band.have++;
    bands.set(tvlBand(p.tvl_usd), band);
  }
  const baseRate = haveAll / peers.length;
  const bandRate = new Map<string, number>();
  for (const [k, v] of bands) bandRate.set(k, v.have / v.total);
  const cellRate = new Map<string, number>();
  for (const [k, v] of cells) {
    const br = bandRate.get(k.split('|')[1]!)!;
    cellRate.set(k, (v.have + 10 * br) / (v.total + 10));
  }
  const cellOf = (p: SnapshotProtocol) => {
    const key = `${ageBand(ageDays(p))}|${tvlBand(p.tvl_usd)}`;
    const c = cells.get(key) ?? { total: 0, have: 0 };
    const rate = cellRate.get(key) ?? baseRate;
    return {
      label: `${ageBand(ageDays(p))} · ${tvlBand(p.tvl_usd)}`,
      have: c.have,
      total: c.total,
      rate,
    };
  };
  return {
    peers: peers.length,
    baseRate,
    cellOf,
    oddsOf: (p) => Math.min(0.98, Math.max(0.05, cellOf(p).rate)),
  };
}

// ---------------------------------------------------------------- scoring

export interface ScoredRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  age: number | null;
  watchlist: boolean;
  baseMultiple: number;
  growthMult: number;
  maturityMult: number;
  launch: number;
  odds: number;
  oddsCell: string;
  oddsHave: number;
  oddsTotal: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  hold: number;
}

export interface ScoreContext {
  beta: Beta | null;
  sigma: number;
  odds: OddsTable;
  unknownAge: number;
}

/** Launch value, odds and range for one pre-token protocol. */
export function scoreProtocol(p: SnapshotProtocol, ctx: ScoreContext): ScoredRow {
  const age = ageDays(p);
  const base = baseMultiple(ctx.beta, p.tvl_usd);
  const growth = growthMultiplier(p.change_7d);
  const maturity = maturityMultiplier(age, ctx.unknownAge);
  const launch = Math.max(1, Math.round(p.tvl_usd * base * growth * maturity));
  const odds = ctx.odds.oddsOf(p);
  const cell = ctx.odds.cellOf(p);
  const implied = Math.max(1, Math.round(launch * odds));
  const f25 = 10 ** (0.674 * ctx.sigma);
  const f90 = 10 ** (1.645 * ctx.sigma);
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl: p.tvl_usd,
    change7d: p.change_7d,
    age,
    watchlist: false,
    baseMultiple: base,
    growthMult: growth,
    maturityMult: maturity,
    launch,
    odds,
    oddsCell: cell.label,
    oddsHave: cell.have,
    oddsTotal: cell.total,
    implied,
    p25: Math.max(1, Math.round(implied / f25)),
    p75: Math.max(1, Math.round(implied * f25)),
    p10: Math.max(1, Math.round(implied / f90)),
    p90: Math.max(1, Math.round(implied * f90)),
    hold: holdDays(age),
  };
}

// ---------------------------------------------------------------- farm economics

export interface FarmEconomics {
  stake: number;
  drop: number;
  gas: number;
  net: number;
  hours: number;
  netPerHour: number;
  tbill: number;
  hold: number;
}

/** The stake the verdict is judged at: 0.1% of TVL, $500–$25,000. */
export function modelStake(tvl: number): number {
  return Math.min(25000, Math.max(500, 0.001 * tvl));
}

export function gasUsd(chains: string[]): number {
  return 4 * (chains.includes('Ethereum') ? 3 : 0.5);
}

export function farmEconomics(
  tvl: number,
  chains: string[],
  hold: number,
  implied: number,
  stake: number,
): FarmEconomics {
  const drop = (stake * DROP_SHARE * implied) / tvl;
  const gas = gasUsd(chains);
  const hours = 0.75 + 0.25 * Math.ceil(hold / 7);
  const tbill = (stake * TBILL_APR * hold) / 365;
  const net = drop - gas;
  return { stake, drop, gas, net, hours, netPerHour: net / hours, tbill, hold };
}

/** The FARM bar: net clears the T-bill and is at least $5. */
export function clearsBar(e: FarmEconomics): boolean {
  return e.net >= e.tbill && e.net >= 5;
}

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/**
 * Verdict, scheme (a), tested on the value range: FARM when the position
 * pays even at P25, THIN when it pays at the point estimate or at P75,
 * SKIP when it pays not even at P75.
 */
export function verdictAt(row: ScoredRow, stake: number): Verdict {
  const at = (implied: number) => farmEconomics(row.tvl, row.chains, row.hold, implied, stake);
  if (clearsBar(at(row.p25))) return 'FARM';
  if (clearsBar(at(row.implied)) || clearsBar(at(row.p75))) return 'THIN';
  return 'SKIP';
}

/**
 * The smallest whole-dollar stake whose net clears the FARM bar at a given
 * implied value, or null when the drop rate there sits at or below the
 * T-bill rate (then no stake of any size ever pays). The two bars give two
 * lower bounds — net >= T-bill needs stake >= gas / (dropRate - tbillRate),
 * net >= $5 needs stake >= (gas + 5) / dropRate — and the ceiling of the
 * larger one is the smallest stake clearing both.
 */
export function stakeToClear(
  tvl: number,
  chains: string[],
  hold: number,
  implied: number,
): number | null {
  const dropRate = (DROP_SHARE * implied) / tvl;
  const tbillRate = (TBILL_APR * hold) / 365;
  if (dropRate <= tbillRate) return null;
  const gas = gasUsd(chains);
  return Math.ceil(Math.max(gas / (dropRate - tbillRate), (gas + 5) / dropRate));
}

// ---------------------------------------------------------------- farm plans

const MAIN_ACTIONS: Array<{ match: (category: string | null) => boolean; act: string; week: string }> = [
  {
    match: (c) => c === 'Lending' || c === 'CDP' || c === 'Collateral Management',
    act: 'Lend USDC into the lending market and keep the receipt token in the fresh wallet',
    week: 'check the borrow rate and top up the lend only if the rate still beats idle cash',
  },
  {
    match: (c) => c === 'Dexs' || c === 'Yield' || c === 'Leveraged Farming' || c === 'Farm',
    act: 'Add liquidity to the main pool in equal halves and keep the LP receipt',
    week: 'check the pool range and fees, and rebalance only if the position drifted out of range',
  },
  {
    match: (c) => c === 'Derivatives' || c === 'Options' || c === 'Perpetuals' || c === 'Synthetics',
    act: 'Post margin for one small hedged position, sized so a bad week cannot liquidate it',
    week: 'check the hedge and trim it if the position moved',
  },
  { match: (c) => c === 'Prediction', act: 'Back one prediction market with a small stake and leave the rest idle', week: 'review the open market once and leave the position alone unless the odds moved' },
  {
    match: (c) => c === 'Risk Curators' || c === 'Onchain Capital Allocator',
    act: 'Allocate the capital to a vault and keep the vault receipt in the fresh wallet',
    week: "check the vault's allocation and leave it alone unless the curator moved funds",
  },
  { match: (c) => c === 'Stablecoin', act: 'Mint or hold the stable asset and keep it in the fresh wallet', week: 'check the peg and the mint rate' },
  { match: (c) => c === 'RWA', act: 'Acquire the tokenised yield asset and hold it in the fresh wallet', week: 'check the yield accrual' },
  { match: (c) => c === 'Insurance', act: 'Buy cover for the position and keep the policy receipt', week: 'check the cover terms' },
  {
    match: (c) => c === 'Restaking' || c === 'Liquid Restaking' || c === 'Liquid Staking' || c === 'Staking Pool',
    act: 'Stake the capital and keep the staking receipt in the fresh wallet',
    week: 'check the staking rewards',
  },
  { match: (c) => c === 'Yield Aggregator', act: 'Deposit the capital and let it compound in the vault', week: 'check the compounding' },
  { match: (c) => c === 'Chain', act: 'Use the native app for a real transaction with the capital', week: 'use the native app once for a real transaction' },
];

function mainAction(category: string | null): { act: string; week: string } {
  for (const entry of MAIN_ACTIONS) {
    if (entry.match(category)) return { act: entry.act, week: entry.week };
  }
  return { act: 'Put the capital to work inside the protocol and keep the receipt', week: 'check the position once and do nothing unless something broke' };
}

/** Dollars with commas: 2 decimals under $10,000, whole dollars above. */
export function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const body = abs < 10000 ? abs.toFixed(2) : Math.round(abs).toString();
  const [int, frac] = body.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${frac === undefined ? grouped : `${grouped}.${frac}`}`;
}

function holdReason(age: number | null): string {
  if (age === null) return 'no listing date is on record, so the plan waits 45 days';
  if (age < 180) return 'it listed recently, so the plan gives it 90 days to be counted';
  if (age < 540) return '60 days is enough to be counted without waiting forever';
  return 'it has waited longest, so the plan acts in 30 days';
}

/**
 * The farm plan: 7 steps (8 on 3+ chains), each derived from the row's own
 * record — capital by TVL band, main action by category, hold by age — and
 * the last step states the range-tested verdict with its own numbers.
 */
export function farmPlan(row: ScoredRow): string[] {
  const stake = modelStake(row.tvl);
  const gasEach = row.chains.includes('Ethereum') ? 3 : 0.5;
  const gasText = gasEach === 3 ? '$3' : '$0.50';
  const { act, week } = mainAction(row.category);
  const firstChain = row.chains[0] ?? 'its main chain';
  const steps: string[] = [
    `Open a fresh wallet for this farm and write the seed phrase on paper, offline — cost $0, about 15 minutes.`,
    `Move $${depositUsd(row.tvl)} of stablecoins into the fresh wallet on ${firstChain} — cost about ${gasText} in gas, about 10 minutes.`,
    `${act} — cost about ${gasText} in gas, about 20 minutes.`,
    `Hold the position for ${row.hold} days: ${holdReason(row.age)} — cost $0, ${row.hold} days.`,
    `Once a week, ${week} — cost about ${gasText} in gas, about 10 minutes a week.`,
    `Claim only through the protocol's own site or docs, never through a DM link, and log the wallet, dates and transaction hashes — cost $0, about 5 minutes per claim.`,
  ];
  if (row.chains.length >= 3) {
    steps.push(
      `Mirror the position on a second supported chain, ${row.chains[1]}, with a small slice of the same capital — cost about ${gasText} in gas, about 30 minutes.`,
    );
  }
  const e25 = farmEconomics(row.tvl, row.chains, row.hold, row.p25, stake);
  const e0 = farmEconomics(row.tvl, row.chains, row.hold, row.implied, stake);
  const e75 = farmEconomics(row.tvl, row.chains, row.hold, row.p75, stake);
  const verdict = verdictAt(row, stake);
  const stakeText = fmtUsd(stake);
  if (verdict === 'FARM') {
    steps.push(
      `Verdict: FARM — it pays even in the pessimistic case: at P25 the expected drop is ${fmtUsd(e25.drop)}, gas ${fmtUsd(e25.gas)}, net ${fmtUsd(e25.net)}, above the ${fmtUsd(e25.tbill)} T-bill bar, at the model ${stakeText} stake.`,
    );
  } else if (verdict === 'THIN') {
    const stf = stakeToClear(row.tvl, row.chains, row.hold, row.p25);
    const stfText = stf === null
      ? 'No stake clears the bar at P25 — the drop rate there sits below the T-bill rate.'
      : `A stake of ${fmtUsd(stf)} would clear the bar even at P25.`;
    if (clearsBar(e0)) {
      steps.push(
        `Verdict: THIN — it pays at the point estimate (drop ${fmtUsd(e0.drop)}, gas ${fmtUsd(e0.gas)}, net ${fmtUsd(e0.net)}, above the ${fmtUsd(e0.tbill)} T-bill bar) but not in the pessimistic case (P25 net ${fmtUsd(e25.net)}). ${stfText}`,
      );
    } else {
      steps.push(
        `Verdict: THIN — it pays only in the optimistic case: at P75 the drop is ${fmtUsd(e75.drop)}, gas ${fmtUsd(e75.gas)}, net ${fmtUsd(e75.net)}, above the ${fmtUsd(e75.tbill)} T-bill bar, but at the point estimate the net is ${fmtUsd(e0.net)}, below it. ${stfText}`,
      );
    }
  } else {
    const stf = stakeToClear(row.tvl, row.chains, row.hold, row.p75);
    const stfText = stf === null
      ? 'No stake clears the bar at P75 — the drop rate there sits below the T-bill rate.'
      : `A stake of ${fmtUsd(stf)} would be needed even at P75.`;
    steps.push(
      `Verdict: SKIP — it does not pay even in the optimistic case: at P75 the drop is ${fmtUsd(e75.drop)}, gas ${fmtUsd(e75.gas)}, net ${fmtUsd(e75.net)}, below the ${fmtUsd(e75.tbill)} T-bill bar. ${stfText}`,
    );
  }
  return steps;
}

// ---------------------------------------------------------------- neighbours

export interface Neighbour {
  slug: string;
  name: string;
  tvl: number;
  mcap: number;
  ratio: number;
}

/** The three live-token protocols nearest this row in TVL, with real ratios. */
export function closestNeighbours(row: ScoredRow, live: SnapshotProtocol[]): Neighbour[] {
  const target = Math.log10(row.tvl);
  return live
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .map((p) => ({ p, d: Math.abs(Math.log10(p.tvl_usd) - target) }))
    .sort((a, b) => a.d - b.d || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, 3)
    .map(({ p }) => ({
      slug: p.slug,
      name: p.name,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd!,
      ratio: p.mcap_usd! / p.tvl_usd,
    }));
}

// ---------------------------------------------------------------- validation

export interface Validation {
  loo: number;
  looFlat: number;
  lowHigh: number;
  lowHighFlat: number;
  highLow: number;
  highLowFlat: number;
  rand10: number;
  rand10Flat: number;
  walkForward: number;
  walkForwardFlat: number;
  walkTestN: number;
  r2: number;
  r2Fuller: number;
  growthCoef: number;
  growthCoefFuller: number;
  ageCoef: number;
  sigma: number;
  coverage2575: number;
  coverage1090: number;
  brier: number;
  brierBase: number;
}

function missOf(pred: number[], actual: number[]): number {
  return 10 ** median(pred.map((p, i) => Math.abs(p - actual[i]!)));
}

function flatMiss(actual: number[]): number {
  return 10 ** median(actual.map((y) => Math.abs(Math.log10(FLAT_MULTIPLE) - y)));
}

/** Least squares for a general design matrix (Gaussian elimination). */
export function olsDesign(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < k; r++) {
      b[r]! += X[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c]! += X[i]![r]! * X[i]![c]!;
    }
  }
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const fac = m[r]![c]! / m[c]![c]!;
      for (let cc = c; cc <= k; cc++) m[r]![cc]! -= fac * m[c]![cc]!;
    }
  }
  return m.map((row, i) => row[k]! / m[i]![i]!);
}

function rSquared(X: number[][], y: number[], beta: number[]): number {
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  let ssr = 0;
  let sst = 0;
  for (let i = 0; i < y.length; i++) {
    const pred = X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0);
    ssr += (y[i]! - pred) ** 2;
    sst += (y[i]! - mean) ** 2;
  }
  return 1 - ssr / sst;
}

/** Split-half Brier for the odds bins: peers split even/odd, both ways. */
function splitHalfBrier(peers: SnapshotProtocol[]): number {
  const rateFor = (train: SnapshotProtocol[], p: SnapshotProtocol): number => {
    const key = `${ageBand(ageDays(p))}|${tvlBand(p.tvl_usd)}`;
    let n = 0;
    let have = 0;
    for (const q of train) {
      if (`${ageBand(ageDays(q))}|${tvlBand(q.tvl_usd)}` !== key) continue;
      n++;
      if (!isPreToken(q)) have++;
    }
    const band = peers.filter((q) => tvlBand(q.tvl_usd) === tvlBand(p.tvl_usd));
    const bandRate = band.filter((q) => !isPreToken(q)).length / band.length;
    return n > 0 ? (have + 10 * bandRate) / (n + 10) : bandRate;
  };
  const brierOne = (train: SnapshotProtocol[], test: SnapshotProtocol[]): number =>
    test.reduce((s, p) => {
      const r = rateFor(train, p);
      const y = isPreToken(p) ? 0 : 1;
      return s + (r - y) ** 2;
    }, 0) / test.length;
  const even = peers.filter((_, i) => i % 2 === 0);
  const odd = peers.filter((_, i) => i % 2 === 1);
  return (brierOne(even, odd) + brierOne(odd, even)) / 2;
}

/**
 * Every held-out test, all refitting the ensemble: leave-one-out, the two
 * size splits, ten random 50/50 splits on the fixed seed, and the
 * walk-forward (fit the oldest dated comps, test the newest). The flat 0.25
 * multiple is the control in each test.
 */
export function validateCurve(
  comps: SnapshotProtocol[],
  peers: SnapshotProtocol[],
  baseRate: number,
  unknownAge: number,
): Validation {
  const n = comps.length;
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const all = comps.map((_, i) => i);
  const fit = (idx: number[]): Beta => ensembleFit(idx.map((i) => xs[i]!), idx.map((i) => ys[i]!)).beta;
  const pred = (beta: Beta, idx: number[]): number[] => idx.map((i) => beta[0] + beta[1] * xs[i]!);
  const actual = (idx: number[]): number[] => idx.map((i) => ys[i]!);

  const looAbs: number[] = [];
  const looFlatAbs: number[] = [];
  const looErr: number[] = [];
  for (let i = 0; i < n; i++) {
    const train = all.filter((j) => j !== i);
    const beta = fit(train);
    looAbs.push(Math.abs(beta[0] + beta[1] * xs[i]! - ys[i]!));
    looFlatAbs.push(Math.abs(Math.log10(FLAT_MULTIPLE) - ys[i]!));
    looErr.push(beta[0] + beta[1] * xs[i]! - ys[i]!);
  }
  const loo = 10 ** median(looAbs);
  const looFlat = 10 ** median(looFlatAbs);
  const meanErr = looErr.reduce((s, v) => s + v, 0) / n;
  const sigma = Math.sqrt(looErr.reduce((s, v) => s + (v - meanErr) ** 2, 0) / n);
  const coverage2575 = looErr.filter((e) => Math.abs(e) <= 0.674 * sigma).length / n;
  const coverage1090 = looErr.filter((e) => Math.abs(e) <= 1.645 * sigma).length / n;

  const bySize = [...all].sort((a, b) => comps[a]!.tvl_usd - comps[b]!.tvl_usd);
  const half = n >> 1;
  const small = bySize.slice(0, half);
  const big = bySize.slice(half);
  const lowHigh = missOf(pred(fit(small), big), actual(big));
  const lowHighFlat = flatMiss(actual(big));
  const highLow = missOf(pred(fit(big), small), actual(small));
  const highLowFlat = flatMiss(actual(small));

  const rnd = mulberry32(RANDOM_SEED);
  const randLogs: number[] = [];
  const randFlatLogs: number[] = [];
  for (let k = 0; k < 10; k++) {
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const a = shuffled.slice(0, half);
    const b = shuffled.slice(half);
    randLogs.push(Math.log10(missOf(pred(fit(a), b), actual(b))));
    randFlatLogs.push(Math.log10(flatMiss(actual(b))));
  }
  const rand10 = 10 ** median(randLogs);
  const rand10Flat = 10 ** median(randFlatLogs);

  const dated = all.filter((i) => comps[i]!.listed_at !== null);
  const byDate = [...dated].sort((a, b) => {
    const la = comps[a]!.listed_at!;
    const lb = comps[b]!.listed_at!;
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const wfHalf = byDate.length >> 1;
  const wfTrain = byDate.slice(0, wfHalf);
  const wfTest = byDate.slice(wfHalf);
  const walkForward = missOf(pred(fit(wfTrain), wfTest), actual(wfTest));
  const walkForwardFlat = flatMiss(actual(wfTest));

  const full = ensembleFit(xs, ys);
  const r2 = rSquared(xs.map((x) => [1, x]), ys, full.beta);
  const growth = comps.map((p) => Math.min(200, Math.max(-50, p.change_7d ?? 0)) / 100);
  const logAge = comps.map((p) => Math.log10(1 + (ageDays(p) ?? unknownAge)));
  const xGrowth = comps.map((_, i) => [1, xs[i]!, growth[i]!]);
  const betaGrowth = olsDesign(xGrowth, ys);
  const xFuller = comps.map((_, i) => [1, xs[i]!, growth[i]!, logAge[i]!]);
  const betaFuller = olsDesign(xFuller, ys);
  const r2Fuller = rSquared(xFuller, ys, betaFuller);

  const brier = splitHalfBrier(peers);
  const brierBase = peers.reduce((s, p) => s + (baseRate - (isPreToken(p) ? 0 : 1)) ** 2, 0) / peers.length;

  return {
    loo,
    looFlat,
    lowHigh,
    lowHighFlat,
    highLow,
    highLowFlat,
    rand10,
    rand10Flat,
    walkForward,
    walkForwardFlat,
    walkTestN: wfTest.length,
    r2,
    r2Fuller,
    growthCoef: betaGrowth[2]!,
    growthCoefFuller: betaFuller[2]!,
    ageCoef: betaFuller[3]!,
    sigma,
    coverage2575,
    coverage1090,
    brier,
    brierBase,
  };
}

// ---------------------------------------------------------------- bootstrap

export interface RankStability {
  rankLo: number;
  rankHi: number;
  top20Share: number;
}

function percentileRank(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Rank stability: refit the size curve on 200 bootstrap resamples of the
 * live tokens and re-rank the board under each refit. Growth, maturity,
 * odds and ranges stay fixed — the refits test the fitted curve only.
 */
export function bootstrapRanks(
  ranked: ScoredRow[],
  comps: SnapshotProtocol[],
): Map<string, RankStability> {
  const n = comps.length;
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const rnd = mulberry32(BOOTSTRAP_SEED);
  const histories = new Map<string, number[]>();
  for (const row of ranked) histories.set(row.slug, []);
  for (let k = 0; k < BOOTSTRAP_REFITS; k++) {
    const sample: number[] = [];
    for (let i = 0; i < n; i++) sample.push(Math.floor(rnd() * n));
    const beta = ensembleFit(sample.map((i) => xs[i]!), sample.map((i) => ys[i]!)).beta;
    const rescored = ranked
      .map((row) => ({
        slug: row.slug,
        implied: Math.max(
          1,
          Math.round(
            row.tvl * baseMultiple(beta, row.tvl) * row.growthMult * row.maturityMult * row.odds,
          ),
        ),
      }))
      .sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1));
    rescored.forEach((r, i) => histories.get(r.slug)!.push(i + 1));
  }
  const out = new Map<string, RankStability>();
  for (const [slug, ranks] of histories) {
    const sorted = [...ranks].sort((a, b) => a - b);
    out.set(slug, {
      rankLo: percentileRank(sorted, 0.1),
      rankHi: percentileRank(sorted, 0.9),
      top20Share: ranks.filter((r) => r <= 20).length / BOOTSTRAP_REFITS,
    });
  }
  return out;
}
