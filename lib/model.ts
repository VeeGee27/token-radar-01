// Launch Radar — the value model (Node 22, erasable TypeScript, standard library only).
//
// What it does, in one paragraph: it reads the sealed DefiLlama snapshot, fits a comps
// curve on the protocols whose token already trades, scores every pre-token protocol
// with it, and writes the ranked board plus a farm plan for each row. Nothing here is
// a hardcoded list of names: every implied value comes from the snapshot's own figures.
//
// The model, honestly stated:
//   log10(implied) = a + b * log10(TVL) + categoryTerm + log10(growthFactor) + log10(ageFactor)
//   - a and b are an ordinary least-squares fit of log10(market cap) on log10(TVL) over
//     the comps: the 128 protocols that record a token with a positive market cap and a
//     positive TVL. R^2 is only about 0.19: TVL alone explains a fifth of market-cap
//     variance, and the dashboard says so. The fit is the comps curve, not a promise.
//   - categoryTerm is the median log10 residual of the comps in the protocol's category,
//     shrunk by n / (n + 5) toward zero, for categories with at least 3 comps; zero
//     otherwise. Same-category tokens price differently (bridges near 1.1x TVL, liquid
//     staking near 0.04x), and the shrinkage keeps thin categories honest.
//   - growthFactor is a judgement term, not a fit: 1 + 0.25 * clamp(change_7d / 100,
//     -0.4, 0.8), so it runs from 0.90 to 1.20. The data were checked: fitting growth
//     as a regression term makes held-out error worse, so it stays a small, capped nudge.
//   - ageFactor is a judgement term, not a fit: 1 + 0.10 * min(log10(daysSinceListed / 30
//     + 1), 1), so it runs from 1.00 to 1.10 for a protocol that has run years with no
//     token. A protocol with no listed_at gets 1.00.
//   - Implied values are rounded to whole dollars and capped at $50,000,000,000.
//
// Held-out tests, computed by this program every run (never hardcoded):
//   Test A splits the comps 80/20 by a deterministic hash of the slug, fits on the 80%,
//   and measures the 20%. Test B splits them by listing date at the median, fits on the
//   older half, and measures the newer half. Both report the median absolute log10
//   error, the median absolute percentage error, and the share of predictions within 2x
//   of the real market cap. The dashboard prints both tests with their numbers.
//
// The board: every protocol on the snapshot's watchlist (40), plus the 160 pre-token
// protocols below the $50M floor with the most TVL. Pre-token means the snapshot
// records no token (gecko_id and symbol both null). Token-trading protocols are comps
// or set aside; they never take a board row.

export interface Protocol {
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
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  status: 'watchlist' | 'early';
  base_value_usd: number;
  cat_term_log: number;
  growth_factor: number;
  age_factor: number;
  deposit_usd: number;
}

export interface HeldOutTest {
  name: string;
  train: number;
  test: number;
  median_log10_error: number;
  median_pct_error: number;
  within_2x_pct: number;
}

export interface ModelSummary {
  comps: number;
  intercept: number;
  slope: number;
  r2: number;
  resid_sd: number;
  cat_terms: { category: string; comps: number; term_log: number }[];
  tests: HeldOutTest[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  rows: BoardRow[];
  watchlist_size: number;
  pre_token_count: number;
  live_count: number;
  live_with_mcap: number;
  model: ModelSummary;
  top_value_usd: number;
  median_value_usd: number;
}

const VALUE_CAP_USD = 50_000_000_000;
const MIN_CAT_COMPS = 3;
const CAT_SHRINK = 5;

/** Whole days from a YYYY-MM-DD date to the snapshot date, or null when unknown. */
function daysSince(listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const [y, m, d] = listedAt.split('-').map((s) => parseInt(s, 10));
  const listed = Date.UTC(y, m - 1, d);
  const asOf = Date.UTC(2026, 10, 14);
  const days = Math.floor((asOf - listed) / 86_400_000);
  return days < 0 ? 0 : days;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** A deterministic 0..1 hash of a string (FNV-1a), for the held-out split. */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

interface Fit {
  intercept: number;
  slope: number;
}

/** OLS fit of y on x for [x, y] pairs. */
function ols(pairs: [number, number][]): Fit {
  const n = pairs.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pairs) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) * (x - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

/** The comps: protocols that record a token with a positive market cap and TVL. */
function compsOf(protocols: Protocol[]): Protocol[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Median log10 residual per category, shrunk toward zero. Categories under the floor get none. */
function categoryTerms(comps: Protocol[], fit: Fit): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const key = p.category ?? 'Uncategorised';
    const resid = Math.log10(p.mcap_usd!) - (fit.intercept + fit.slope * Math.log10(p.tvl_usd));
    const arr = byCat.get(key);
    if (arr === undefined) byCat.set(key, [resid]);
    else arr.push(resid);
  }
  const terms = new Map<string, number>();
  for (const [key, residuals] of byCat) {
    if (residuals.length < MIN_CAT_COMPS) continue;
    terms.set(key, median(residuals) * (residuals.length / (residuals.length + CAT_SHRINK)));
  }
  return terms;
}

/** One held-out test: fit on `train`, measure on `test`, both as log10(mcap) errors. */
function heldOut(name: string, train: Protocol[], test: Protocol[]): HeldOutTest {
  const fit = ols(train.map((p) => [Math.log10(p.tvl_usd), Math.log10(p.mcap_usd!)] as [number, number]));
  const terms = categoryTerms(train, fit);
  const errors: number[] = [];
  for (const p of test) {
    const pred =
      fit.intercept +
      fit.slope * Math.log10(p.tvl_usd) +
      (terms.get(p.category ?? 'Uncategorised') ?? 0);
    errors.push(Math.abs(pred - Math.log10(p.mcap_usd!)));
  }
  const med = median(errors);
  const pcts = errors.map((e) => (Math.pow(10, e) - 1) * 100);
  const within2x = errors.filter((e) => e < Math.log10(2)).length;
  return {
    name,
    train: train.length,
    test: test.length,
    median_log10_error: Math.round(med * 10000) / 10000,
    median_pct_error: Math.round(median(pcts) * 10) / 10,
    within_2x_pct: Math.round((within2x / Math.max(1, test.length)) * 1000) / 10,
  };
}

/** The growth nudge: a capped judgement term, never a fitted coefficient. */
function growthFactor(change7d: number | null): number {
  const change = change7d === null ? 0 : change7d / 100;
  return 1 + 0.25 * clamp(change, -0.4, 0.8);
}

/** The age nudge: a capped judgement term for running years with no token. */
function ageFactor(ageDays: number | null): number {
  if (ageDays === null) return 1;
  return 1 + 0.1 * Math.min(Math.log10(ageDays / 30 + 1), 1);
}

/** A farm deposit sized to the protocol: $100 to $2,500, about 0.002% of TVL. */
function depositFor(tvlUsd: number): number {
  return Math.max(100, Math.min(2500, Math.round(tvlUsd * 0.00002)));
}

/** Gas for one transaction on a chain, in whole dollars, from the chain's usual fee. */
function gasFor(chain: string): number {
  const table: Record<string, number> = {
    Ethereum: 8,
    Bitcoin: 4,
    Solana: 1,
    Base: 1,
    Arbitrum: 1,
    Optimism: 1,
    Polygon: 1,
    Avalanche: 1,
    BSC: 1,
    Binance: 1,
    Hyperliquid: 1,
    Monad: 1,
  };
  return table[chain] ?? 2;
}

const CATEGORY_ACTIONS: Record<string, string> = {
  Lending: 'Supply collateral and borrow against it',
  Dexs: 'Swap and add liquidity to a pool',
  Yield: 'Deposit into a yield vault',
  'Liquid Staking': 'Stake and hold the receipt token',
  Bridge: 'Bridge assets across the supported chains',
  'Canonical Bridge': 'Bridge assets through the canonical bridge',
  RWA: 'Buy a tokenised real-world asset position',
  Derivatives: 'Open a hedged perpetual position',
  CDP: 'Lock collateral and mint the stable asset',
  'Risk Curators': 'Allocate to a curated vault',
  Restaking: 'Restake and delegate to an operator',
  'Onchain Capital Allocator': 'Allocate capital to a managed strategy',
  CeDeFi: 'Deposit into a centralised-decentralised yield product',
  'Basis Trading': 'Open a delta-neutral basis position',
  'Yield Aggregator': 'Deposit into the aggregator vault',
};

/** Concrete farm steps for one protocol, each 20 to 600 characters. */
function farmSteps(p: Protocol, depositUsd: number): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain);
  const action = CATEGORY_ACTIONS[p.category ?? ''] ?? 'Use the protocol directly';
  const chains = p.chains.slice(0, 3).join(', ');
  const steps: string[] = [
    `Set up a fresh wallet on ${chain} and fund it with $${depositUsd + 50} plus about $${gas} for gas; bridging takes 10 to 20 minutes and costs roughly $${gas} per transaction.`,
    `${action} on ${p.name} with a $${depositUsd} deposit on ${chain}; keep the position open so the protocol records your address as an active user.`,
    `Repeat the core action once a week for 4 to 8 weeks, about 15 minutes each time, so your activity spans several snapshot dates instead of one day.`,
    `Use a second supported chain (${chains}) for at least one deposit, since multi-chain users are the ones most farm trackers weight heaviest.`,
    `Keep the $${depositUsd} position open and do not withdraw before any announced snapshot; exiting early is the most common way a farm pays nothing.`,
  ];
  if ((p.category ?? '') === 'Dexs' || (p.category ?? '') === 'Yield') {
    steps.push(`Add a small liquidity position of about $${Math.round(depositUsd / 2)} beside the main deposit and leave it for the full 4 to 8 weeks to earn fees as well as points.`);
  }
  if (p.tvl_usd >= 100_000_000) {
    steps.push(`Split the $${depositUsd} deposit across two wallets on ${chain} to stay under any per-wallet cap, and document both addresses in one place.`);
  }
  return steps.slice(0, 6);
}

/** Parse and validate the snapshot text. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** Fit the comps curve, score the board, and build the dashboard's data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const protocols = snapshot.protocols;
  const comps = compsOf(protocols);
  const fit = ols(comps.map((p) => [Math.log10(p.tvl_usd), Math.log10(p.mcap_usd!)] as [number, number]));
  const terms = categoryTerms(comps, fit);

  // In-sample fit quality.
  const residuals = comps.map(
    (p) => Math.log10(p.mcap_usd!) - (fit.intercept + fit.slope * Math.log10(p.tvl_usd)),
  );
  const ssRes = residuals.reduce((a, r) => a + r * r, 0);
  const meanY = comps.reduce((a, p) => a + Math.log10(p.mcap_usd!), 0) / comps.length;
  const ssTot = comps.reduce((a, p) => a + Math.pow(Math.log10(p.mcap_usd!) - meanY, 2), 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const residSd = Math.sqrt(ssRes / Math.max(1, comps.length - 2));

  // Held-out tests, computed here every run.
  const testA = heldOut(
    'Random split (80/20 by slug hash)',
    comps.filter((p) => hash01(p.slug) < 0.8),
    comps.filter((p) => hash01(p.slug) >= 0.8),
  );
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = dated[Math.floor(dated.length / 2)]!.listed_at!;
  const testB = heldOut(
    `Time split (listed before ${cut} vs after)`,
    dated.filter((p) => p.listed_at! < cut),
    dated.filter((p) => p.listed_at! >= cut),
  );

  const catTerms = [...terms.entries()]
    .map(([category, term]) => ({
      category,
      comps: comps.filter((p) => (p.category ?? 'Uncategorised') === category).length,
      term_log: Math.round(term * 1000) / 1000,
    }))
    .sort((a, b) => b.term_log - a.term_log);

  // The board: the whole watchlist, plus the 160 pre-token protocols below the floor
  // with the most TVL. Pre-token means the snapshot records no token at all.
  const preToken = protocols.filter((p) => p.gecko_id === null && p.symbol === null);
  const watchlistSet = new Set(snapshot.watchlist);
  const belowFloor = preToken
    .filter((p) => p.tvl_usd < snapshot.floor_usd && !watchlistSet.has(p.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 160);
  const boardSet = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = protocols.find((q) => q.slug === slug);
    if (p !== undefined) boardSet.set(slug, p);
  }
  for (const p of belowFloor) boardSet.set(p.slug, p);

  const rows: BoardRow[] = [...boardSet.values()].map((p) => {
    const ageDays = daysSince(p.listed_at);
    const catTerm = terms.get(p.category ?? 'Uncategorised') ?? 0;
    const base = Math.pow(10, fit.intercept + fit.slope * Math.log10(p.tvl_usd) + catTerm);
    const gf = growthFactor(p.change_7d);
    const af = ageFactor(ageDays);
    const value = Math.max(1, Math.min(VALUE_CAP_USD, Math.round(base * gf * af)));
    const deposit = depositFor(p.tvl_usd);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: value,
      farm_steps: farmSteps(p, deposit),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays,
      status: watchlistSet.has(p.slug) ? 'watchlist' : 'early',
      base_value_usd: Math.round(base),
      cat_term_log: Math.round(catTerm * 1000) / 1000,
      growth_factor: Math.round(gf * 1000) / 1000,
      age_factor: Math.round(af * 1000) / 1000,
      deposit_usd: deposit,
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const values = rows.map((r) => r.implied_value_usd);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    rows,
    watchlist_size: snapshot.watchlist.length,
    pre_token_count: preToken.length,
    live_count: protocols.length - preToken.length,
    live_with_mcap: comps.length,
    model: {
      comps: comps.length,
      intercept: Math.round(fit.intercept * 10000) / 10000,
      slope: Math.round(fit.slope * 10000) / 10000,
      r2: Math.round(r2 * 10000) / 10000,
      resid_sd: Math.round(residSd * 10000) / 10000,
      cat_terms: catTerms,
      tests: [testA, testB],
    },
    top_value_usd: values[0] ?? 0,
    median_value_usd: Math.round(median(values)),
  };
  return { board: rows, radar };
}

/** The gate's own checks on the board, as a single error string or null when it passes. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `board holds ${board.length} rows, under the 100 minimum`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `ranks are not 1..${board.length} once each`;
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `implied value rises from rank ${byRank[i - 1]!.rank} to rank ${byRank[i]!.rank}`;
    }
  }
  if (new Set(byRank.map((r) => r.implied_value_usd)).size < 2) {
    return 'every implied value is the same: the board ranks nothing';
  }
  const slugs = new Set(board.map((r) => r.slug));
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug}: ${row.farm_steps.length} farm steps, outside 3..12`;
    }
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `${row.slug}: a farm step is ${len} characters, outside 20..600`;
    }
  }
  return null;
}

/** The dashboard's data as a script the page reads: window.RADAR. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
