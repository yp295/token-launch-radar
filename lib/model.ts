// patient-3: rank pre-token protocols by what a launch would be worth,
// with the odds it ever lists, a range on every value, a farm verdict
// netted to the dollar at a stake sized to the protocol, and a rank
// range for every row from 200 bootstrap refits of the size curve.
//
// The board ranks every protocol in the sealed snapshot that could
// actually launch a token. Six ideas carry the model:
//
//   1. The launch value is fitted, not guessed: on every run the program
//      regresses log10(market cap / TVL) on log10(TVL) across the
//      live-token protocols in this same snapshot, and uses the fitted
//      line as the multiple. Big protocols trade at a smaller fraction
//      of TVL than small ones, and the fit says so with the snapshot's
//      own numbers. Seven-day growth is log-damped and maturity
//      saturates, so neither can overturn size.
//   2. The odds come from the peers' own record: the share of
//      launch-eligible protocols in the same age-and-size cell that
//      already record a token, smoothed toward the cell's TVL-band
//      rate. Old giants that never launched drag their own odds down.
//   3. Every value carries a range from the model's own held-out
//      misses: the leave-one-out residuals of the size curve set the
//      width, and the dashboard reports how often the band held.
//   4. Every row gets a farm verdict at a stake sized to the protocol
//      (0.1% of its TVL, $500–$25,000): the expected drop (5% of the
//      implied value per dollar of TVL) minus gas, against a T-bill on
//      the same money — plus the stake that would turn the row into a
//      farm. At a uniform $1,000 the giants could never pay, so the
//      whole top of the board read SKIP; the stake has to fit the
//      protocol.
//   5. Every rank carries its stability: the size curve is refit on
//      200 bootstrap resamples of the live tokens (fixed seed, so the
//      resamples are identical on every run), and each row reports the
//      rank range it held across the refits.
//   6. Nothing is hidden: the dashboard prints the held-out tests,
//      including the one the curve loses, and the full census of the
//      758 protocols.
//
// No protocol name is special-cased, and no field the snapshot does
// not carry is invented. See MODEL.md for the full specification and
// the numbers behind each constant.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
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

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted line and the fixed shape of the model. */
export interface ModelParams {
  /** Intercept of log10(mcap/TVL) = a + b x log10(TVL), fitted at runtime. */
  fit_intercept: number;
  /** Slope of the same fit (negative: bigger protocols trade at a smaller fraction). */
  fit_slope: number;
  /** Live-token protocols with a reported market cap that the fit used. */
  fit_n: number;
  /** Weight of the log-damped growth term. */
  growth_weight: number;
  /** Growth is clamped to this low end (percent) before the log. */
  growth_low: number;
  /** Growth is clamped to this high end (percent) before the log. */
  growth_high: number;
  /** Maturity multiplier at age zero. */
  maturity_floor: number;
  /** Maturity multiplier's span above the floor (floor + span is the ceiling). */
  maturity_span: number;
  /** Age in days at which maturity reaches the middle of its span. */
  maturity_half_days: number;
  /** Age in days used when a protocol has no listing date (snapshot median). */
  fallback_age_days: number;
  /** Base multiple used when the fit has too few live protocols to trust. */
  fallback_multiple: number;
  /** Base multiple is never below this. */
  multiple_low: number;
  /** Base multiple is never above this. */
  multiple_high: number;
  /** Prior strength for the odds bins, in protocols. */
  odds_prior: number;
  /** Odds are never below this. */
  odds_low: number;
  /** Odds are never above this. */
  odds_high: number;
  /** Share of a launch's value assumed to reach farmers. */
  drop_share: number;
  /** Share of a protocol's TVL the verdict stake is sized at (0.001 = 0.1%). */
  stake_share: number;
  /** The verdict stake is never below this, in dollars. */
  stake_floor_usd: number;
  /** The verdict stake is never above this, in dollars. */
  stake_cap_usd: number;
  /** Annual rate of the T-bill the verdict is judged against. */
  tbill_apr: number;
  /** Gas per transaction on Ethereum, in dollars. */
  gas_eth_usd: number;
  /** Gas per transaction on cheaper chains, in dollars. */
  gas_cheap_usd: number;
  /** Transactions in one farm plan: deposit, two weekly actions, claim. */
  gas_tx_count: number;
}

export const MODEL_VERSION = 'patient-3';

/** Live-token rows the dashboard's separate view carries, by market cap. */
export const LIVE_VIEW_ROWS = 30;

/** The model's fixed shape. The fit's intercept and slope are filled in at runtime. */
export function defaultParams(): ModelParams {
  return {
    fit_intercept: 0,
    fit_slope: 0,
    fit_n: 0,
    growth_weight: 0.3,
    growth_low: -50,
    growth_high: 200,
    maturity_floor: 0.6,
    maturity_span: 0.4,
    maturity_half_days: 365,
    fallback_age_days: 513,
    fallback_multiple: 0.25,
    multiple_low: 0.03,
    multiple_high: 0.7,
    odds_prior: 10,
    odds_low: 0.05,
    odds_high: 0.98,
    drop_share: 0.05,
    stake_share: 0.001,
    stake_floor_usd: 500,
    stake_cap_usd: 25000,
    tbill_apr: 0.045,
    gas_eth_usd: 3,
    gas_cheap_usd: 0.5,
    gas_tx_count: 4,
  };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when the date is absent or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that are a product of a token that already trades, not a protocol of their own. */
const WRAPPED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** A name ending in a release marker is a pool of another protocol, not a launch candidate. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word in a name that says the product wraps or stakes something else. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names: a protocol named after one is the exchange's own product. */
const EXCHANGE_FIRST_WORDS = new Set([
  'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'bitfinex', 'huobi',
  'kucoin', 'gemini', 'bitstamp', 'bitget', 'mexc', 'gate',
]);

/** Whether a protocol could ever launch a token of its own (the peer-group rule). */
export function isLaunchEligible(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  const first = p.name.split(/\s+/)[0] ?? '';
  if (EXCHANGE_FIRST_WORDS.has(first.toLowerCase().replace(/\.$/, ''))) return false;
  return true;
}

/**
 * Whether a protocol may be ranked: pre-token, and not a wrapped, staked
 * or bridged product of a token that already trades. The snapshot carries
 * no parent-protocol field, so the check uses category and name, the two
 * fields that do carry the distinction.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && isLaunchEligible(p);
}

/** Ordinary least squares of y on x. Returns intercept, slope and R squared. */
function ols(xs: number[], ys: number[]): { intercept: number; slope: number; r2: number } {
  const n = xs.length;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i]!;
    meanY += ys[i]!;
  }
  meanX /= n;
  meanY /= n;
  let cross = 0;
  let square = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    cross += (xs[i]! - meanX) * (ys[i]! - meanY);
    square += (xs[i]! - meanX) * (xs[i]! - meanX);
    total += (ys[i]! - meanY) * (ys[i]! - meanY);
  }
  const slope = square === 0 ? 0 : cross / square;
  const intercept = meanY - slope * meanX;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const err = ys[i]! - (intercept + slope * xs[i]!);
    residual += err * err;
  }
  return { intercept, slope, r2: total === 0 ? 0 : 1 - residual / total };
}

/** The live-token protocols with a reported market cap: the fit's ground truth. */
export function liveComps(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

/**
 * Fit the base-multiple line on the snapshot's own live-token protocols:
 * ordinary least squares of log10(mcap/TVL) on log10(TVL). Returns null
 * when too few live protocols report a market cap to fit anything.
 */
export function fitBaseMultiple(protocols: SnapshotProtocol[]): { intercept: number; slope: number; n: number } | null {
  const comps = liveComps(protocols);
  if (comps.length < 10) return null;
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const fit = ols(xs, ys);
  return { intercept: fit.intercept, slope: fit.slope, n: comps.length };
}

/** The base multiple for a TVL under `params`: the fitted line, clamped to the sane band. */
export function baseMultiple(tvlUsd: number, params: ModelParams): number {
  if (!(tvlUsd > 0)) return params.fallback_multiple;
  if (params.fit_n < 10) return params.fallback_multiple;
  const fitted = Math.pow(10, params.fit_intercept + params.fit_slope * Math.log10(tvlUsd));
  return Math.min(params.multiple_high, Math.max(params.multiple_low, fitted));
}

/** The growth multiplier: the week's change, clamped, then log-damped. */
export function growthMultiplier(change7d: number | null, params: ModelParams): number {
  const raw = finiteNumber(change7d, 0);
  const clamped = Math.min(params.growth_high, Math.max(params.growth_low, raw));
  return 1 + params.growth_weight * Math.log(1 + clamped / 100);
}

/** The maturity multiplier: saturating in age, with the snapshot median for unknown ages. */
export function maturityMultiplier(ageDays: number | null, params: ModelParams): number {
  const age = ageDays ?? params.fallback_age_days;
  const safe = Math.max(0, age);
  return params.maturity_floor + params.maturity_span * (safe / (safe + params.maturity_half_days));
}

/** A protocol's launch value and every input that produced it. */
export interface LaunchScore {
  launch: number;
  baseMultiple: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  ageDays: number | null;
}

export function launchValue(p: SnapshotProtocol, asOf: string, params: ModelParams): LaunchScore {
  const ageDays = ageInDays(asOf, p.listed_at);
  const base = baseMultiple(p.tvl_usd, params);
  const growthPct = Math.min(params.growth_high, Math.max(params.growth_low, finiteNumber(p.change_7d, 0)));
  const growthMult = growthMultiplier(p.change_7d, params);
  const maturityMult = maturityMultiplier(ageDays, params);
  const launch = Math.max(1, Math.round(p.tvl_usd * base * growthMult * maturityMult));
  return { launch, baseMultiple: base, growthPct, growthMult, maturityMult, ageDays };
}

// ---------------------------------------------------------------- odds

/** The age band a protocol's listing age falls in. */
export function ageBand(ageDays: number | null): string {
  if (ageDays === null) return 'age?';
  if (ageDays < 180) return '<6mo';
  if (ageDays < 540) return '6-18mo';
  if (ageDays < 1095) return '18mo-3yr';
  return '3yr+';
}

/** The TVL band a protocol's TVL falls in. */
export function tvlBand(tvlUsd: number): string {
  if (tvlUsd < 50_000_000) return '<$50M';
  if (tvlUsd < 100_000_000) return '$50-100M';
  if (tvlUsd < 1_000_000_000) return '$100M-1B';
  return '>$1B';
}

/** One odds cell: how many launch-eligible peers it holds, and how many record a token. */
export interface OddsCell {
  age: string;
  tvl: string;
  n: number;
  hasToken: number;
  /** The cell's rate smoothed toward its TVL band's rate (the odds the model uses). */
  rate: number;
}

/** The odds table: every cell plus each TVL band's overall rate. */
export interface OddsTable {
  cells: OddsCell[];
  bandRate: Record<string, number>;
  baseRate: number;
  /** Brier score of the binned odds on held-out peers, and of the base rate on the same split. */
  brierBinned: number;
  brierBase: number;
  peers: number;
}

function cellKey(age: string, tvl: string): string {
  return `${age}|${tvl}`;
}

/** The odds a protocol carries, from its cell in `table`. */
export function tokenOdds(
  p: SnapshotProtocol,
  asOf: string,
  table: OddsTable,
  params: ModelParams,
): { odds: number; cellN: number; cellHas: number; cellAge: string; cellTvl: string } {
  const age = ageBand(ageInDays(asOf, p.listed_at));
  const tvl = tvlBand(p.tvl_usd);
  const cell = table.cells.find((c) => c.age === age && c.tvl === tvl);
  const odds = cell === undefined ? table.baseRate : cell.rate;
  return {
    odds: Math.min(params.odds_high, Math.max(params.odds_low, odds)),
    cellN: cell === undefined ? 0 : cell.n,
    cellHas: cell === undefined ? 0 : cell.hasToken,
    cellAge: age,
    cellTvl: tvl,
  };
}

/**
 * Build the odds table from the snapshot's launch-eligible protocols:
 * each age x TVL cell counts its peers, and the cell's rate is smoothed
 * toward its TVL band's rate with a prior of `params.odds_prior`
 * protocols. The Brier scores come from a split-half test: fit the bins
 * on one half of the peers, score them on the other, and average both
 * directions.
 */
export function buildOddsTable(snapshot: Snapshot, params: ModelParams): OddsTable {
  const peers = snapshot.protocols.filter(isLaunchEligible);
  const counts = new Map<string, { n: number; hasToken: number }>();
  const bandCounts = new Map<string, { n: number; hasToken: number }>();
  for (const p of peers) {
    const age = ageBand(ageInDays(snapshot.as_of, p.listed_at));
    const tvl = tvlBand(p.tvl_usd);
    const cell = counts.get(cellKey(age, tvl)) ?? { n: 0, hasToken: 0 };
    cell.n += 1;
    if (!isPreToken(p)) cell.hasToken += 1;
    counts.set(cellKey(age, tvl), cell);
    const band = bandCounts.get(tvl) ?? { n: 0, hasToken: 0 };
    band.n += 1;
    if (!isPreToken(p)) band.hasToken += 1;
    bandCounts.set(tvl, band);
  }
  const bandRate: Record<string, number> = {};
  for (const [tvl, c] of bandCounts) bandRate[tvl] = c.hasToken / c.n;
  const cells: OddsCell[] = [...counts.entries()]
    .map(([key, c]) => {
      const [age, tvl] = key.split('|') as [string, string];
      const rate = (c.hasToken + params.odds_prior * bandRate[tvl]!) / (c.n + params.odds_prior);
      return { age, tvl, n: c.n, hasToken: c.hasToken, rate };
    })
    .sort((a, b) => (a.age < b.age ? -1 : a.age > b.age ? 1 : a.tvl < b.tvl ? -1 : 1));
  const baseRate = peers.filter((p) => !isPreToken(p)).length / peers.length;

  // Split-half Brier: fit the bins on one half of the peers, score the other.
  const rateFor = (train: SnapshotProtocol[], p: SnapshotProtocol): number => {
    const age = ageBand(ageInDays(snapshot.as_of, p.listed_at));
    const tvl = tvlBand(p.tvl_usd);
    let n = 0;
    let has = 0;
    for (const q of train) {
      if (ageBand(ageInDays(snapshot.as_of, q.listed_at)) !== age) continue;
      if (tvlBand(q.tvl_usd) !== tvl) continue;
      n += 1;
      if (!isPreToken(q)) has += 1;
    }
    if (n === 0) return bandRate[tvl]!;
    return (has + params.odds_prior * bandRate[tvl]!) / (n + params.odds_prior);
  };
  const brierOne = (train: SnapshotProtocol[], test: SnapshotProtocol[], useBins: boolean): number => {
    let total = 0;
    for (const p of test) {
      const actual = isPreToken(p) ? 0 : 1;
      const predicted = useBins ? rateFor(train, p) : baseRate;
      total += (predicted - actual) * (predicted - actual);
    }
    return total / test.length;
  };
  const even = peers.filter((_, i) => i % 2 === 0);
  const odd = peers.filter((_, i) => i % 2 === 1);
  const brierBinned = (brierOne(even, odd, true) + brierOne(odd, even, true)) / 2;
  const brierBase = (brierOne(even, odd, false) + brierOne(odd, even, false)) / 2;
  return { cells, bandRate, baseRate, brierBinned, brierBase, peers: peers.length };
}

// ---------------------------------------------------------------- validation

/** One held-out test of the size curve: the median miss, against the flat multiple. */
export interface HeldOutTest {
  name: string;
  /** Median factor between predicted and true market cap, fitted curve. */
  miss: number;
  /** The same median miss for a flat 0.25 multiple. */
  flatMiss: number;
  tested: number;
}

/** Rank stability from the bootstrap refits, for the whole board. */
export interface RankStabilitySummary {
  /** Bootstrap resamples of the live tokens. */
  refits: number;
  /** Median P90-minus-P10 rank width across the board's rows. */
  medianWidth: number;
  /** Top-20 rows whose P90 rank stays inside the top 20. */
  top20Stable: number;
}

/** One row's rank range across the bootstrap refits. */
export interface RankRange {
  slug: string;
  /** 10th percentile of the row's rank across refits. */
  p10: number;
  /** 90th percentile of the row's rank across refits. */
  p90: number;
  /** Share of refits in which the row stayed in the top 20. */
  top20Share: number;
}

/** Everything the dashboard's evidence section prints. */
export interface Validation {
  loo: HeldOutTest;
  splitLowHigh: HeldOutTest;
  splitHighLow: HeldOutTest;
  /** Ten random 50/50 splits of the live tokens: the median miss of the ten. */
  randomSplits: HeldOutTest;
  /** Rank stability across the bootstrap refits. */
  rankStability: RankStabilitySummary;
  /** Standard deviation of the leave-one-out log errors: the range's width. */
  sigmaLog10: number;
  /** Share of held-out live tokens whose true market cap falls in the P25-P75 band. */
  p25Coverage: number;
  /** Share of held-out live tokens whose true market cap falls in the P10-P90 band. */
  p90Coverage: number;
  /** R squared of the size-only fit on the comps. */
  r2SizeOnly: number;
  /** R squared when growth and age are added to the comps' fit. */
  r2WithGrowthAge: number;
  /** Fitted growth coefficient (per 100 points of 7-day change) in the fuller fit. */
  growthCoef: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A small seeded generator (mulberry32): the random splits and the
 * bootstrap resamples must be identical on every run, so the program
 * never draws from Math.random or the clock. One fixed seed per use.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher-Yates shuffle that draws only from the seeded generator. */
function seededShuffle<T>(values: T[], random: () => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Solve a small linear system by Gaussian elimination. */
function solveLinear(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const rows = matrix.map((row, i) => [...row, vector[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(rows[r]![col]) > Math.abs(rows[pivot]![col])) pivot = r;
    }
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = rows[r]![col] / rows[col]![col];
      for (let c = col; c <= n; c++) rows[r]![c] -= factor * rows[col]![c];
    }
  }
  return rows.map((row, i) => row[n]! / row[i]!);
}

/**
 * Validate the size curve on the snapshot's own live tokens: a
 * leave-one-out test, two size-split tests (fit on one half of the
 * live tokens by TVL, test on the other), and the growth-and-age check
 * that shows those two terms carry no usable signal in the comps.
 * Every number is computed here, at runtime, from the snapshot.
 */
export function validateModel(snapshot: Snapshot): Validation {
  const comps = liveComps(snapshot.protocols);
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const flatLog = Math.log10(0.25);

  // Leave-one-out: refit without each token, score the one left out.
  const signedErrors: number[] = [];
  const looMisses: number[] = [];
  const looFlat: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const trainX = xs.filter((_, j) => j !== i);
    const trainY = ys.filter((_, j) => j !== i);
    const fit = ols(trainX, trainY);
    const error = fit.intercept + fit.slope * xs[i]! - ys[i]!;
    signedErrors.push(error);
    looMisses.push(Math.abs(error));
    looFlat.push(Math.abs(flatLog - ys[i]!));
  }
  const loo: HeldOutTest = {
    name: 'Leave-one-out',
    miss: Math.pow(10, median(looMisses)),
    flatMiss: Math.pow(10, median(looFlat)),
    tested: comps.length,
  };
  const meanErr = signedErrors.reduce((a, b) => a + b, 0) / signedErrors.length;
  const variance = signedErrors.reduce((a, e) => a + (e - meanErr) * (e - meanErr), 0) / signedErrors.length;
  const sigma = Math.sqrt(variance);
  const p25Coverage = signedErrors.filter((e) => Math.abs(e) <= 0.674 * sigma).length / signedErrors.length;
  const p90Coverage = signedErrors.filter((e) => Math.abs(e) <= 1.645 * sigma).length / signedErrors.length;

  // Size splits: fit on one half by TVL, test on the other, both ways.
  const order = comps.map((_, i) => i).sort((a, b) => comps[a]!.tvl_usd - comps[b]!.tvl_usd);
  const half = Math.floor(order.length / 2);
  const splitTest = (fitIdx: number[], testIdx: number[]): HeldOutTest => {
    const fit = ols(
      fitIdx.map((i) => xs[i]!),
      fitIdx.map((i) => ys[i]!),
    );
    const misses = testIdx.map((i) => Math.abs(fit.intercept + fit.slope * xs[i]! - ys[i]!));
    const flats = testIdx.map((i) => Math.abs(flatLog - ys[i]!));
    return {
      name: 'Size split',
      miss: Math.pow(10, median(misses)),
      flatMiss: Math.pow(10, median(flats)),
      tested: testIdx.length,
    };
  };
  const splitLowHigh = splitTest(order.slice(0, half), order.slice(half));
  const splitHighLow = splitTest(order.slice(half), order.slice(0, half));

  // Random splits: ten seeded 50/50 splits of the live tokens. The
  // seed is fixed, so the splits are the same on every run. The table
  // prints the median miss across the ten splits.
  const splitRandom = seededRandom(0x20261114);
  const randomMisses: number[] = [];
  const randomFlats: number[] = [];
  for (let s = 0; s < 10; s++) {
    const shuffled = seededShuffle(
      comps.map((_, i) => i),
      splitRandom,
    );
    const one = splitTest(shuffled.slice(0, half), shuffled.slice(half));
    randomMisses.push(Math.log10(one.miss));
    randomFlats.push(Math.log10(one.flatMiss));
  }
  const randomSplits: HeldOutTest = {
    name: 'Random splits ×10 (median)',
    miss: Math.pow(10, median(randomMisses)),
    flatMiss: Math.pow(10, median(randomFlats)),
    tested: order.length - half,
  };

  // Growth and age: do they add anything to the comps' ratios?
  const sizeOnly = ols(xs, ys);
  const rows = comps.map((p) => {
    const growth = Math.min(200, Math.max(-50, finiteNumber(p.change_7d, 0))) / 100;
    const age = ageInDays(snapshot.as_of, p.listed_at) ?? 513;
    return [1, Math.log10(p.tvl_usd), growth, Math.log10(1 + age)];
  });
  const k = 4;
  const normal: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs: number[] = new Array<number>(k).fill(0);
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < k; i++) {
      rhs[i]! += rows[r]![i]! * ys[r]!;
      for (let j = 0; j < k; j++) normal[i]![j]! += rows[r]![i]! * rows[r]![j]!;
    }
  }
  const beta = solveLinear(normal, rhs);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let total = 0;
  let residual = 0;
  for (let r = 0; r < rows.length; r++) {
    const predicted = rows[r]!.reduce((sum, v, i) => sum + v * beta[i]!, 0);
    total += (ys[r]! - meanY) * (ys[r]! - meanY);
    residual += (ys[r]! - predicted) * (ys[r]! - predicted);
  }
  return {
    loo,
    splitLowHigh,
    splitHighLow,
    randomSplits,
    // Filled in by buildRadar once the board exists: the refits re-rank
    // the board, so the summary needs the rows.
    rankStability: { refits: 0, medianWidth: 0, top20Stable: 0 },
    sigmaLog10: sigma,
    p25Coverage,
    p90Coverage,
    r2SizeOnly: sizeOnly.r2,
    r2WithGrowthAge: total === 0 ? 0 : 1 - residual / total,
    growthCoef: beta[2]!,
  };
}

/**
 * Bootstrap rank stability: refit the size curve on 200 resamples of
 * the live tokens (sampling with replacement, fixed seed) and re-rank
 * the whole board under each refit. Growth, maturity and odds are held
 * fixed — they are bounded priors and peer counts, not fitted terms —
 * so the refits measure the fitted curve's uncertainty only. Returns
 * each row's rank range (P10–P90) and its share of refits in the top 20.
 */
export function rankStability(
  snapshot: Snapshot,
  params: ModelParams,
  odds: OddsTable,
  sigmaLog10: number,
  rows: Array<{ slug: string; implied_value_usd: number }>,
): Map<string, RankRange> {
  const comps = liveComps(snapshot.protocols);
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  // Per-row factors that do not move in a refit: growth, maturity, odds.
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const factors = rows.map((r) => {
    const p = bySlug.get(r.slug)!;
    const score = scoreProtocol(p, snapshot.as_of, params, odds, sigmaLog10);
    return {
      slug: r.slug,
      tvl: p.tvl_usd,
      growthMult: score.growthMult,
      maturityMult: score.maturityMult,
      odds: score.odds,
    };
  });
  const refits = 200;
  const ranks = new Map<string, number[]>();
  for (const f of factors) ranks.set(f.slug, []);
  const random = seededRandom(0x20261121);
  for (let b = 0; b < refits; b++) {
    const sampleX: number[] = [];
    const sampleY: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const j = Math.floor(random() * comps.length);
      sampleX.push(xs[j]!);
      sampleY.push(ys[j]!);
    }
    const fit = ols(sampleX, sampleY);
    const implied = factors.map((f) => {
      const base = Math.min(
        params.multiple_high,
        Math.max(params.multiple_low, Math.pow(10, fit.intercept + fit.slope * Math.log10(f.tvl))),
      );
      const launch = Math.max(1, Math.round(f.tvl * base * f.growthMult * f.maturityMult));
      return { slug: f.slug, implied: Math.max(1, Math.round(launch * f.odds)) };
    });
    implied.sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    implied.forEach((row, i) => ranks.get(row.slug)!.push(i + 1));
  }
  const out = new Map<string, RankRange>();
  for (const [slug, list] of ranks) {
    const sorted = [...list].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]!;
    const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))]!;
    const top20Share = list.filter((r) => r <= 20).length / list.length;
    out.set(slug, { slug, p10, p90, top20Share });
  }
  return out;
}

// ---------------------------------------------------------------- scoring

/** A protocol's score under the model: its implied value and every input that produced it. */
export interface ScoredProtocol {
  launch: number;
  implied: number;
  odds: number;
  oddsCellN: number;
  oddsCellHas: number;
  oddsCellAge: string;
  oddsCellTvl: string;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  baseMultiple: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  ageDays: number | null;
}

export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  params: ModelParams,
  odds: OddsTable,
  sigmaLog10: number,
): ScoredProtocol {
  const launchScore = launchValue(p, asOf, params);
  const token = tokenOdds(p, asOf, odds, params);
  const implied = Math.max(1, Math.round(launchScore.launch * token.odds));
  const low = Math.pow(10, -0.674 * sigmaLog10);
  const high = Math.pow(10, 0.674 * sigmaLog10);
  const low90 = Math.pow(10, -1.645 * sigmaLog10);
  const high90 = Math.pow(10, 1.645 * sigmaLog10);
  return {
    launch: launchScore.launch,
    implied,
    odds: token.odds,
    oddsCellN: token.cellN,
    oddsCellHas: token.cellHas,
    oddsCellAge: token.cellAge,
    oddsCellTvl: token.cellTvl,
    p25: Math.max(1, Math.round(implied * low)),
    p75: Math.max(1, Math.round(implied * high)),
    p10: Math.max(1, Math.round(implied * low90)),
    p90: Math.max(1, Math.round(implied * high90)),
    baseMultiple: launchScore.baseMultiple,
    growthPct: launchScore.growthPct,
    growthMult: launchScore.growthMult,
    maturityMult: launchScore.maturityMult,
    ageDays: launchScore.ageDays,
  };
}

/** The three live-token protocols nearest a row in TVL, with their real multiples. */
export interface Neighbour {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export function nearestNeighbours(p: SnapshotProtocol, snapshot: Snapshot): Neighbour[] {
  const comps = liveComps(snapshot.protocols);
  const target = Math.log10(p.tvl_usd);
  return comps
    .map((q) => ({
      q,
      distance: Math.abs(Math.log10(q.tvl_usd) - target),
    }))
    .sort((a, b) => a.distance - b.distance || (a.q.slug < b.q.slug ? -1 : 1))
    .slice(0, 3)
    .map(({ q }) => ({
      slug: q.slug,
      name: q.name,
      tvl_usd: q.tvl_usd,
      mcap_usd: q.mcap_usd!,
      multiple: q.mcap_usd! / q.tvl_usd,
    }));
}

// ---------------------------------------------------------------- farm economics

/** A row's verdict at a stake sized to the protocol. */
export interface FarmVerdict {
  verdict: 'FARM' | 'THIN' | 'SKIP';
  /** The stake the verdict is judged at, in dollars. */
  stakeUsd: number;
  /** Expected drop at the verdict stake, in dollars. */
  dropUsd: number;
  /** Gas for the plan's four transactions, in dollars. */
  gasUsd: number;
  /** Hours the plan takes, setup plus weekly actions plus claim. */
  hours: number;
  /** Net dollars at the yardstick stake: drop minus gas. */
  netUsd: number;
  /** Net dollars per hour. */
  netPerHour: number;
  /** What the same stake earns in a T-bill over the hold. */
  tbillUsd: number;
  /** The smallest stake whose net clears both bars, or null when no stake does. */
  stakeToFarm: number | null;
  /** The plan's own deposit, in dollars. */
  depositUsd: number;
  /** The plan's hold, in days. */
  holdDays: number;
}

/** The capital one farm position needs, from the protocol's own TVL band. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 100_000_000) return 200;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols need a longer qualifying window. */
function holdDaysFor(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 180) return 90;
  if (ageDays < 540) return 60;
  return 30;
}

/** The stake a verdict is judged at: 0.1% of the protocol's TVL, floored and capped. */
export function modelStakeUsd(p: SnapshotProtocol, params: ModelParams): number {
  return Math.round(
    Math.min(params.stake_cap_usd, Math.max(params.stake_floor_usd, params.stake_share * p.tvl_usd)),
  );
}

/** The verdict for one scored row, at its deposit-sized stake. */
export function farmVerdict(
  p: SnapshotProtocol,
  implied: number,
  ageDays: number | null,
  params: ModelParams,
): FarmVerdict {
  const depositUsd = capitalFor(p);
  const holdDays = holdDaysFor(ageDays);
  const dropRate = params.drop_share * (implied / p.tvl_usd);
  const stake = modelStakeUsd(p, params);
  const dropUsd = stake * dropRate;
  const perTx = p.chains.includes('Ethereum') ? params.gas_eth_usd : params.gas_cheap_usd;
  const gasUsd = params.gas_tx_count * perTx;
  const hours = 0.75 + 0.25 * Math.ceil(holdDays / 7);
  const netUsd = dropUsd - gasUsd;
  const tbillUsd = stake * params.tbill_apr * (holdDays / 365);
  const verdict: FarmVerdict['verdict'] =
    netUsd >= tbillUsd && netUsd >= 5 ? 'FARM' : netUsd >= 0 ? 'THIN' : 'SKIP';
  const tbillRate = params.tbill_apr * (holdDays / 365);
  let stakeToFarm: number | null = null;
  if (dropRate > tbillRate) {
    const byDollars = (gasUsd + 5) / dropRate;
    const byTbill = gasUsd / (dropRate - tbillRate);
    stakeToFarm = Math.ceil(Math.max(byDollars, byTbill) / 10) * 10;
  }
  return {
    verdict,
    stakeUsd: stake,
    dropUsd,
    gasUsd,
    hours,
    netUsd,
    netPerHour: netUsd / hours,
    tbillUsd,
    stakeToFarm,
    depositUsd,
    holdDays,
  };
}

// ---------------------------------------------------------------- farm plans

/** One step of a farm plan: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The main farming action for a protocol's category, in words a farmer can follow. */
function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit untouched.`;
  }
  if (c.includes('yield aggregator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and let it compound.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and hold the LP tokens.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Back one market on ${name} with $${capital} and leave the position to settle.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Allocate $${capital} to a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or hold $${capital} of the stable asset issued through ${name} on ${chain}.`;
  }
  if (c.includes('rwa')) {
    return `Acquire $${capital} of the tokenized yield asset from ${name} on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover through ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('stak')) {
    return `Stake $${capital} through ${name} and keep the staking receipt.`;
  }
  if (c === 'chain') {
    return `Use ${name}'s own app on ${chain} with $${capital} and keep the position active.`;
  }
  return `Put $${capital} to work inside ${name} on ${chain} and leave the position open.`;
}

/** One farm step as a single string: its action, then its cost and time. */
function stepString(step: FarmStep): string {
  let s = `${step.text} — cost ${step.cost}, ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

const money = (n: number): string => {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
};

/**
 * A protocol's farm plan: seven steps, eight when it runs on three or
 * more chains. Every step is derived from the protocol's own record —
 * category, chains, TVL band, age — never from a hand-written list of
 * names. The last step states the row's verdict at the yardstick stake.
 */
export function farmPlan(
  p: SnapshotProtocol,
  ageDays: number | null,
  verdict: FarmVerdict,
  params: ModelParams,
): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(ageDays);
  const gas = capital >= 200 ? 8 : 4;
  const verdictText =
    verdict.verdict === 'FARM'
      ? `Verdict: FARM — at a $${verdict.stakeUsd} stake this row models a ${money(verdict.dropUsd)} drop, ${money(verdict.gasUsd)} of gas and ${verdict.hours} hours, net ${money(verdict.netUsd)} (${money(verdict.netPerHour)} an hour) against a ${money(verdict.tbillUsd)} T-bill; a $${verdict.stakeToFarm} stake is already enough to farm it.`
      : verdict.verdict === 'THIN'
        ? verdict.stakeToFarm === null
          ? `Verdict: THIN — at a $${verdict.stakeUsd} stake this row models a ${money(verdict.dropUsd)} drop, ${money(verdict.gasUsd)} of gas and ${verdict.hours} hours, net ${money(verdict.netUsd)} (${money(verdict.netPerHour)} an hour) against a ${money(verdict.tbillUsd)} T-bill; no stake clears the T-bill bar, so the money earns more sitting still.`
          : `Verdict: THIN — at a $${verdict.stakeUsd} stake this row models a ${money(verdict.dropUsd)} drop, ${money(verdict.gasUsd)} of gas and ${verdict.hours} hours, net ${money(verdict.netUsd)} (${money(verdict.netPerHour)} an hour) against a ${money(verdict.tbillUsd)} T-bill; a $${verdict.stakeToFarm} stake would turn it into a farm.`
        : verdict.stakeToFarm === null
          ? `Verdict: SKIP — at a $${verdict.stakeUsd} stake this row models a ${money(verdict.dropUsd)} drop, ${money(verdict.gasUsd)} of gas and ${verdict.hours} hours, net ${money(verdict.netUsd)} (${money(verdict.netPerHour)} an hour) against a ${money(verdict.tbillUsd)} T-bill; no stake clears the T-bill bar, so the money earns more sitting still.`
          : `Verdict: SKIP — at a $${verdict.stakeUsd} stake this row models a ${money(verdict.dropUsd)} drop, ${money(verdict.gasUsd)} of gas and ${verdict.hours} hours, net ${money(verdict.netUsd)} (${money(verdict.netPerHour)} an hour) against a ${money(verdict.tbillUsd)} T-bill; it would take a $${verdict.stakeToFarm} stake to farm it.`;
  const steps: FarmStep[] = [
    {
      text: `Open a fresh wallet for this farm only, fund it with $${capital}, and keep its seed phrase offline — never in a screenshot or a chat.`,
      cost: 'under $3 of gas to fund it',
      time: '5 minutes',
    },
    {
      text: mainAction(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: 'Come back once a week and do one real action — a deposit, a borrow, a swap, or a vote — so the wallet reads as active instead of parked.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Stay in the position for at least ${hold} days, so it shows up in more than one snapshot.`,
      cost: `the $${capital} stays deployed`,
      time: `${hold} days`,
    },
    {
      text: `When the protocol opens a points or rewards page, claim only through the link on its own site or docs — never through a link sent in a DM.`,
      cost: 'free to check',
      time: '10 minutes',
    },
    {
      text: 'Record the wallet address, the dates, and every transaction hash in a farm log, so the position can be repeated or unwound later.',
      cost: 'free',
      time: '5 minutes',
    },
    {
      text: verdictText,
      cost: `net ${money(verdict.netUsd)} at the $${verdict.stakeUsd} yardstick`,
      time: `${verdict.hours} hours`,
    },
  ];
  if (p.chains.length >= 3) {
    steps.push({
      text: `Mirror the position on ${p.chains[1]!}, a second chain ${p.name} supports, so the activity is visible on more than one network.`,
      cost: `another $${capital} of capital and about $4 of gas`,
      time: '15 minutes',
    });
  }
  return steps.map(stepString);
}

// ---------------------------------------------------------------- board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    launch_value_usd: number;
    token_odds: number;
    odds_cell: string;
    odds_cell_n: number;
    odds_cell_has_token: number;
    p25_usd: number;
    p75_usd: number;
    p10_usd: number;
    p90_usd: number;
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
    verdict: string;
    verdict_net_usd: number;
    verdict_net_per_hour_usd: number;
    verdict_stake_usd: number;
    verdict_stake_to_farm_usd: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol for the dashboard's separate view: the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One board row in the compact form the dashboard page reads. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number;
  odds_cell: string;
  odds_cell_n: number;
  odds_cell_has_token: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  verdict: string;
  verdict_net_usd: number;
  verdict_net_per_hour_usd: number;
  verdict_drop_usd: number;
  verdict_gas_usd: number;
  verdict_hours: number;
  verdict_tbill_usd: number;
  verdict_stake_usd: number;
  verdict_stake_to_farm_usd: number | null;
  verdict_deposit_usd: number;
  verdict_hold_days: number;
  rank_p10: number;
  rank_p90: number;
  rank_top20_share: number;
  neighbours: Neighbour[];
  farm_steps: string[];
}

/** The five checks the program ran before writing anything. */
export interface BuildChecks {
  rows: number;
  watchlist_covered: number;
  watchlist_total: number;
  distinct_implied: number;
  farm_steps_ok: boolean;
  no_external_urls: boolean;
  rank_ranges_ok: boolean;
}

/** Everything the dashboard page needs, as one object. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelParams;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  validation: Validation;
  odds: OddsTable;
  accounting: {
    total: number;
    live_token: number;
    ranked: number;
    set_aside: number;
    set_aside_by_reason: Array<{ reason: string; count: number }>;
  };
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  checks: BuildChecks;
  rows: RadarRow[];
  live: LiveRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Why a protocol was set aside, for the accounting strip. */
function setAsideReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return null;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return p.category;
  if (VERSION_MARKER.test(p.name)) return 'Versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'Wrapped or staked word';
  const first = p.name.split(/\s+/)[0] ?? '';
  if (EXCHANGE_FIRST_WORDS.has(first.toLowerCase().replace(/\.$/, ''))) return 'Exchange product';
  return null;
}

/** The ranked board: every rankable pre-token protocol, strongest implied value first. */
export function buildBoard(
  snapshot: Snapshot,
  params: ModelParams,
  odds: OddsTable,
  sigmaLog10: number,
): BoardRow[] {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug in it, whether or not it also
  // appears among the early rows below.
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol. Nothing is
  // cut by an arbitrary cap — the board is the whole rankable set.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const score = scoreProtocol(p, snapshot.as_of, params, odds, sigmaLog10);
    const verdict = farmVerdict(p, score.implied, score.ageDays, params);
    return { p, score, verdict };
  });
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.score.ageDays,
    implied_value_usd: s.score.implied,
    model: {
      launch_value_usd: s.score.launch,
      token_odds: round4(s.score.odds),
      odds_cell: `${s.score.oddsCellAge} · ${s.score.oddsCellTvl}`,
      odds_cell_n: s.score.oddsCellN,
      odds_cell_has_token: s.score.oddsCellHas,
      p25_usd: s.score.p25,
      p75_usd: s.score.p75,
      p10_usd: s.score.p10,
      p90_usd: s.score.p90,
      base_multiple: round4(s.score.baseMultiple),
      growth_pct: round4(s.score.growthPct),
      growth_multiplier: round4(s.score.growthMult),
      maturity_multiplier: round4(s.score.maturityMult),
      age_days: s.score.ageDays,
      verdict: s.verdict.verdict,
      verdict_net_usd: round2(s.verdict.netUsd),
      verdict_net_per_hour_usd: round2(s.verdict.netPerHour),
      verdict_stake_usd: s.verdict.stakeUsd,
      verdict_stake_to_farm_usd: s.verdict.stakeToFarm,
    },
    farm_steps: farmPlan(s.p, s.score.ageDays, s.verdict, params),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's separate view. */
export function liveView(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_VIEW_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** One board row in the compact form the dashboard page reads. */
export function radarRow(
  row: BoardRow,
  snapshot: Snapshot,
  ranges: Map<string, RankRange>,
): RadarRow {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const p = bySlug.get(row.slug)!;
  const neighbours = nearestNeighbours(p, snapshot);
  const verdict = farmVerdict(p, row.implied_value_usd, row.model.age_days, defaultParams());
  const range = ranges.get(row.slug) ?? { slug: row.slug, p10: row.rank, p90: row.rank, top20Share: 0 };
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    launch_value_usd: row.model.launch_value_usd,
    token_odds: row.model.token_odds,
    odds_cell: row.model.odds_cell,
    odds_cell_n: row.model.odds_cell_n,
    odds_cell_has_token: row.model.odds_cell_has_token,
    p25_usd: row.model.p25_usd,
    p75_usd: row.model.p75_usd,
    p10_usd: row.model.p10_usd,
    p90_usd: row.model.p90_usd,
    base_multiple: row.model.base_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    verdict: row.model.verdict,
    verdict_net_usd: row.model.verdict_net_usd,
    verdict_net_per_hour_usd: row.model.verdict_net_per_hour_usd,
    verdict_drop_usd: round2(verdict.dropUsd),
    verdict_gas_usd: round2(verdict.gasUsd),
    verdict_hours: verdict.hours,
    verdict_tbill_usd: round2(verdict.tbillUsd),
    verdict_stake_usd: row.model.verdict_stake_usd,
    verdict_stake_to_farm_usd: row.model.verdict_stake_to_farm_usd,
    verdict_deposit_usd: verdict.depositUsd,
    verdict_hold_days: verdict.holdDays,
    rank_p10: range.p10,
    rank_p90: range.p90,
    rank_top20_share: Math.round(range.top20Share * 100) / 100,
    neighbours,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot and the fitted model. */
export function buildRadar(
  snapshot: Snapshot,
  params: ModelParams,
  odds: OddsTable,
  validation: Validation,
  checks: BuildChecks,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, params, odds, validation.sigmaLog10);
  const live = liveView(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  // Rank stability: refit the size curve 200 times and re-rank the board.
  const ranges = rankStability(snapshot, params, odds, validation.sigmaLog10, board);
  const widths = board.map((r) => {
    const g = ranges.get(r.slug)!;
    return g.p90 - g.p10;
  });
  validation.rankStability = {
    refits: 200,
    medianWidth: median(widths),
    top20Stable: board
      .slice(0, 20)
      .filter((r) => ranges.get(r.slug)!.p90 <= 20).length,
  };
  const reasons = new Map<string, number>();
  let setAside = 0;
  let liveToken = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) {
      liveToken += 1;
      continue;
    }
    const reason = setAsideReason(p);
    if (reason !== null) {
      setAside += 1;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.model.verdict as 'FARM' | 'THIN' | 'SKIP'] += 1;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: params,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    validation,
    odds,
    accounting: {
      total: snapshot.protocols.length,
      live_token: liveToken,
      ranked: board.length,
      set_aside: setAside,
      set_aside_by_reason: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    verdict_counts: verdictCounts,
    checks,
    rows: board.map((row) => radarRow(row, snapshot, ranges)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null when it passes:
 * coverage of the watchlist, ranks 1..N exactly once, implied values
 * non-increasing with rank, not all equal, and farm steps in range.
 * Written from the brief's stated rules, as a local self-check.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const outside = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  if (outside < 60) return `only ${outside} rows sit outside the watchlist, fewer than 60`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
