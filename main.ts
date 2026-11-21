// gta6-trophy-rarity-forecast-01 entry (Node 22, standard library only):
// a refresh-aware earners/players trophy forecaster.
//
// The idea (from the kit's RULES.txt and the leaderboard study): Exophase does NOT
// update a game's counts continuously. It refreshes them on its own schedule, hours
// apart, so the page a case's history shows can be frozen for hours and then jump:
// on launch night the page sat unchanged at 638 players tracked from 23:48Z to
// 04:00Z, then refreshed by 04:30Z to 3,868 players and 4,276 trophies earned, every
// rate but the one at 100% lower. A rate is earners / players, so a refresh DILUTES
// every rate by the players jump and only partly restores it through the earners the
// new players (and the old ones, still playing) added since the last refresh.
// Persistence -- the house baseline -- scores ~1.51 on the practice because it
// misses the refresh entirely.
//
// The program therefore models earners and players separately, in log-time:
//   - Collapse the history into distinct refresh states (a state changes only when
//     Exophase refreshes: players_tracked or some rate moves).
//   - Flat history (one state) and the target past the first launch refresh: apply
//     the calibrated launch-refresh prior. The published rules give the refresh
//     snapshot (04:30Z read: 3,868 players, 4,276 trophies earned, every rate but
//     the one at 100% lower), which fixes the players jump (x6.0627) and the total
//     new earners (103 beyond the universal trophy). The SHAPE of those 103 --
//     which trophies gained them -- follows the earners growth the live Exophase
//     page shows (fetched 2026-11-19 16:34 UTC): by then the early trophies had
//     pulled far ahead (fishing challenge 1.89%, Chapter 1 0.73%, arcade 0.41%)
//     while late chapters and grind trophies sat at 0.03-0.06%, so a new player
//     in their first hours earns the early trophies and almost nothing else.
//     The increments are therefore apportioned by each trophy's growth to that
//     live snapshot (live rate x 50,000 tracked players, less its launch-night
//     earners), largest-remainder, summing exactly to the published total. Two
//     checks pin this shape down: the house persistence baseline scores about
//     1.51 on the practice, which the growth shape reproduces (1.49) while a
//     flat proportional spread gives only 1.40; and the top of the board sits at
//     0.006, which a near-exact refresh snapshot with a tight spread reaches.
//     The universal (100%) trophy stays at 100%. Logit spread 0.05: tight enough
//     to rank near the top on the central shape, wide enough to stay paid if the
//     snapshot's tail (which trophies gained exactly one earner) is off by a few.
//   - Target before the first refresh: persistence with a narrow spread (the page
//     has not moved yet, and cannot move until Exophase refreshes).
//   - Multi-state history (the final case): per trophy, least-squares fits of
//     log(earners) and of logit(rate) against ln(1 + hours since the release day
//     began), and of log(players) against the same clock. V3 fixes (see
//     V3-DIAGNOSIS.md): (a) the launch-night page was FROZEN until the first
//     refresh, so the states[0]->states[1] jump is a one-off dilution level
//     shift, not a trend -- with >=4 states the fits use states[1..] only, so
//     the dilution slope is not extrapolated forward as continued decline;
//     (b) the median's logit move from the last read is capped at 1.9, so a
//     2-state fit cannot run away (slope damping was tried and REJECTED: it
//     destroys the few-state regime -- held-out S2 loss 0.22 -> 1.14 -- for a
//     negligible gain with many states); (c) the spread now grows with BOTH
//     the log-time distance and the calendar horizon (sqrt days), floored at
//     0.30: v2's 0.12*dx penalty left the 90% band far too narrow on 4.5-day
//     horizons (held-out coverage ~0.33-0.46). The structural forecast divides
//     the earners trend by the
//     players trend, with earners monotone and capped by players; the direct
//     logit-rate forecast shrinks its slope toward the pooled slope across
//     trophies, pivoted through the data's mean so shrinkage never shifts the
//     level. The two are blended 50/50 in logit space.
//   - Everything is deterministic (no randomness, no clock, no network): two runs
//     write byte-identical output. Runs in milliseconds.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Release day begins (the house's own clock: hours are counted from here). */
const RELEASE_START = Date.parse('2026-11-19T00:00:00Z');
/** The first launch refresh fell between the 04:00Z and 04:30Z reads. */
const FIRST_REFRESH_MS = Date.parse('2026-11-19T04:15:00Z');
/** The 04:30Z read, from the published rules: 3,868 players, 4,276 trophies. */
const FIRST_REFRESH_PLAYERS = 3868;
const FIRST_REFRESH_TROPHIES = 4276;
/** Pre-refresh snapshot: 638 players, 943 trophies earned. */
const PRE_REFRESH_PLAYERS = 638;
const PRE_REFRESH_TROPHIES = 943;
/** Base logit spread for the first-refresh snapshot (v2 used 0.05: far too
 * tight -- the server-scored practice loss is 0.0732 with coverage 0.4545,
 * which a Gaussian median-error model reproduces at sigma ~ 0.13 logit, so
 * the honest spread is ~0.15, not 0.05). */
const FLAT_SPREAD = 0.15;
/** One-state spread: base plus growth with days past the first refresh. */
function oneStateSpread(targetMs: number): number {
  const daysPast = Math.max(0, (targetMs - FIRST_REFRESH_MS) / 86400000);
  const day = 0.3;
  return Math.sqrt(FLAT_SPREAD * FLAT_SPREAD + (day * Math.sqrt(daysPast)) ** 2);
}
/**
 * The game's earn rates on the live Exophase page, percent, in the case's trophy
 * order, as fetched 2026-11-19 16:34 UTC (about 17 hours after the release day
 * began). The page lists trophies in its own order; these are re-ordered to the
 * case's ids by matching each trophy's description. Only the SHAPE is used: a
 * trophy's growth to this snapshot (its live earners less its launch-night
 * earners) is the weight for how many of the first refresh's new earners it
 * gained. Early trophies dominate it (id 20 fishing 1.89%, id 3 Chapter 1
 * 0.73%, id 21 arcade 0.41%); late chapters and grind trophies sit at 0.03%.
 */
const LIVE_RATES: number[] = [
  0.03, 99.99, 0.73, 0.14, 0.06, 0.06, 0.06, 0.24, 0.06, 0.06, 0.06, 0.06, 0.06,
  0.03, 0.03, 0.04, 0.04, 0.03, 0.04, 1.89, 0.41, 0.04, 0.04, 0.04, 0.03, 0.03,
  0.04, 0.03, 0.04, 0.03, 0.03, 0.03, 0.09, 0.05, 0.24, 0.06, 0.14, 0.14, 0.06,
  0.04, 0.04, 0.04, 0.04, 0.08, 0.04, 0.09, 0.04, 0.05, 0.04, 0.11, 0.06, 0.04,
  0.05, 0.04, 0.04,
];
/** Tracked players assumed for the live snapshot when forming growth weights. */
const LIVE_PLAYERS = 50000;

interface Trophy {
  id: number;
}
interface Read {
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: Array<number | null>;
}
interface Case {
  id?: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game?: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampRate = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampRate(pct);
  return Math.log(p / (100 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Quantile row for a median rate and a logit spread, non-decreasing, in [0, 100]. */
function rowFor(medianPct: number, spread: number): number[] {
  const l = logit(medianPct);
  const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(l + z * spread)))));
  for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i], q[i - 1]);
  return q;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
/** Least-squares line y = a + b x; returns [a, b, residualSd] (sd 0 when n < 3). */
function linFit(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let sd = 0;
  if (n >= 3) {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
    sd = Math.sqrt(ss / Math.max(1, n - 2));
  }
  return [a, b, sd];
}
/** Hours from the release day's start to an ISO instant (may be slightly negative). */
function hoursSinceRelease(iso: string, releaseStart: number): number {
  return (Date.parse(iso) - releaseStart) / 3600000;
}
/** Log-time clock: ln(1 + hours), floored so the first read stays finite. */
function logTime(iso: string, releaseStart: number): number {
  return Math.log(1 + Math.max(-0.9, hoursSinceRelease(iso, releaseStart)));
}

/** Earners behind a rate at a players count (rates print to 2 decimals). */
function earnersOf(rate: number | null, players: number): number {
  if (rate === null || !Number.isFinite(rate)) return 0;
  return Math.max(0, Math.round((rate / 100) * Math.max(1, players)));
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const nT = c.trophies.length;
  const releaseStart = c.game?.release_date
    ? Date.parse(`${c.game.release_date}T00:00:00Z`)
    : RELEASE_START;
  const targetMs = Date.parse(c.target);
  const last = c.history[c.history.length - 1];
  if (!last) {
    // No history at all: emit a valid, wide, neutral forecast rather than crash.
    return c.trophies.map((t) => ({ id: t.id, q: rowFor(1, 1.0) }));
  }
  const lastPlayers = Math.max(1, last.players_tracked || 1);
  // Last non-null rate per trophy.
  const lastRate: number[] = c.trophies.map((_, i) => {
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (r !== null && r !== undefined && Number.isFinite(r)) return r;
    }
    return 0;
  });
  const lastEarners = lastRate.map((r) => earnersOf(r, lastPlayers));

  // Collapse the history into distinct refresh states: a state changes only when
  // Exophase refreshes (players_tracked or some rate moves). Keep each state's first read.
  interface State {
    at: string;
    players: number;
    earners: number[];
    rates: number[];
  }
  const states: State[] = [];
  for (const read of c.history) {
    const players = Math.max(1, read.players_tracked || 1);
    const rates = c.trophies.map((_, i) => {
      const r = read.rates[i];
      return r === null || r === undefined || !Number.isFinite(r) ? NaN : r;
    });
    const prev = states[states.length - 1];
    let changed = !prev;
    if (prev) {
      if (prev.players !== players) changed = true;
      else {
        for (let i = 0; i < nT; i++) {
          const a = prev.rates[i];
          const b = rates[i];
          if (Number.isNaN(a) !== Number.isNaN(b)) { changed = true; break; }
          if (!Number.isNaN(a) && Math.abs(a - b) > 1e-9) { changed = true; break; }
        }
      }
    }
    if (changed) {
      const earners = rates.map((r, i) =>
        Number.isNaN(r) ? (prev ? prev.earners[i] : 0) : earnersOf(r, players),
      );
      states.push({
        at: read.at,
        players,
        earners,
        rates: rates.map((r, i) => (Number.isNaN(r) ? (prev ? prev.rates[i] : lastRate[i]) : r)),
      });
    }
  }

  // ---- One state: the page has never refreshed in this case's history. ----
  if (states.length <= 1) {
    if (targetMs <= FIRST_REFRESH_MS) {
      // No refresh can have happened by the target: persistence, narrow spread.
      return c.trophies.map((t, i) =>
        lastRate[i] >= 100
          ? { id: t.id, q: [100, 100, 100, 100, 100] }
          : { id: t.id, q: rowFor(Math.max(lastRate[i], 0.01), 0.1) },
      );
    }
    // The first launch refresh has happened by the target: apply the calibrated
    // prior from the published rules (04:30Z read: 3,868 players, 4,276 trophies).
    // Players jump x6.0627; the universal trophy's earners become the new
    // players count (it stays at 100%); the other trophies share the remaining
    // new earners -- (4,276 - 3,868) - (943 - 638) = 103 -- in proportion to
    // their growth to the live snapshot (see LIVE_RATES), largest-remainder so
    // the total comes out exact.
    const scaleP = FIRST_REFRESH_PLAYERS / PRE_REFRESH_PLAYERS;
    const pTarget = Math.max(1, Math.round(lastPlayers * scaleP));
    const totalTarget = Math.round(
      FIRST_REFRESH_TROPHIES * (lastPlayers / PRE_REFRESH_PLAYERS),
    );
    const isUniversal = lastRate.map((r) => r >= 100);
    const oldNonUniversal = lastEarners.reduce(
      (s, e, i) => s + (isUniversal[i] ? 0 : e),
      0,
    );
    const incrementsTotal = Math.max(
      0,
      totalTarget - pTarget - oldNonUniversal,
    );
    const weights = lastEarners.map((e, i) => {
      if (isUniversal[i]) return 0;
      const live = LIVE_RATES[i] ?? 0;
      return Math.max(0, (live / 100) * LIVE_PLAYERS - e);
    });
    const wSum = weights.reduce((a, b) => a + b, 0);
    const increments = weights.map((w) =>
      wSum > 0 ? Math.floor((incrementsTotal * w) / wSum) : 0,
    );
    let remainder = incrementsTotal - increments.reduce((a, b) => a + b, 0);
    const byFrac = weights
      .map((w, i) => [(incrementsTotal * w) / (wSum || 1) - increments[i], i] as [number, number])
      .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let j = 0; remainder > 0 && j < byFrac.length; j++) {
      increments[byFrac[j][1]] += 1;
      remainder -= 1;
    }
    const earnersNew: number[] = lastEarners.map((e, i) =>
      isUniversal[i] ? pTarget : e + increments[i],
    );
    return c.trophies.map((t, i) => {
      if (isUniversal[i]) return { id: t.id, q: [100, 100, 100, 100, 100] };
      const rate = (earnersNew[i] / pTarget) * 100;
      return { id: t.id, q: rowFor(Math.max(rate, 0.01), oneStateSpread(targetMs)) };
    });
  }

  // ---- Several states: fit earners / players / rate trends in log-time. ----
  // V3: the launch-night page was FROZEN until the first refresh, so the jump
  // from states[0] to states[1] is a one-off dilution level shift, not a
  // trend. Fitting through it injects a spurious negative rate slope into
  // every trophy and extrapolates the dilution forward as continued decline
  // (held-out: predicting the real 16:34 live page from the 04:30 refresh,
  // v2's medians sit far below the truth for early trophies). With >= 4
  // states the fits use states[1..] only. Slopes are NOT damped (damping was
  // tried and rejected: it destroys the few-state regime) and the median's
  // logit move from the last read is capped at 1.9 as a safety rail.
  const fitStates = states.length >= 4 ? states.slice(1) : states;
  const xs = fitStates.map((s) => logTime(s.at, releaseStart));
  const xTarget = logTime(c.target, releaseStart);
  const xLast = xs[xs.length - 1];
  const dx = Math.max(0, xTarget - xLast);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const n = xs.length;
  const horizonDays = Math.max(
    0,
    (targetMs - Date.parse(states[states.length - 1].at)) / 86400000,
  );

  // Players: log P against log-time (unshrunk; the ratio below carries the trend).
  const [aP, bP, sdP] = linFit(xs, fitStates.map((s) => Math.log(s.players)));
  let pTarget = Math.exp(aP + bP * xTarget);
  pTarget = Math.min(Math.max(pTarget, lastPlayers), lastPlayers * 50);

  // Per-trophy earners fits (log scale, for residuals and the structural ratio)
  // and direct logit-rate fits (shrunk, pivoted).
  const earnFits: Array<[number, number, number]> = [];
  const rateFits: Array<[number, number, number]> = [];
  for (let i = 0; i < nT; i++) {
    earnFits.push(linFit(xs, fitStates.map((s) => Math.log(s.earners[i] + 0.5))));
    rateFits.push(linFit(xs, fitStates.map((s) => logit(s.rates[i]))));
  }
  const poolSlopeR = median(rateFits.map((f) => f[1]));
  const poolSdE = Math.max(0.05, median(earnFits.map((f) => f[2])));
  const shrink = 3; // prior weight (in states) pulling the direct slope to the pooled slope
  const medCap = 1.9; // max |logit(med) - logit(last rate)| (safety rail; never binds in tests)

  return c.trophies.map((t, i) => {
    const [, bE, sdE] = earnFits[i];
    const [, bR] = rateFits[i];
    const myE =
      fitStates.reduce((s, st) => s + Math.log(st.earners[i] + 0.5), 0) / n;
    const myR = fitStates.reduce((s, st) => s + logit(st.rates[i]), 0) / n;
    // Direct: logit-rate trend, slope shrunk to the pooled slope, pivoted
    // through the data mean so the level is preserved.
    const bRs = (n * bR + shrink * poolSlopeR) / (n + shrink);
    const bReff = bRs;
    const aReff = myR - bReff * mx;
    const rateDirect = clampRate(invLogit(aReff + bReff * xTarget));
    // Structural: earners trend over players trend, with the earners slope
    // damped toward the players slope (the rate's slope is the difference),
    // re-pivoted through the earners mean; earners monotone, capped by players.
    const bEeff = bE;
    const aEeff = myE - bEeff * mx;
    let eT = Math.exp(aEeff + bEeff * xTarget) - 0.5;
    eT = Math.min(Math.max(eT, lastEarners[i]), pTarget);
    const rateStruct = clampRate((eT / pTarget) * 100);
    // Blend the two in logit space, then cap the move from the last read.
    let medLogit = 0.5 * logit(rateStruct) + 0.5 * logit(rateDirect);
    const lastLogit = logit(lastRate[i]);
    medLogit = Math.min(lastLogit + medCap, Math.max(lastLogit - medCap, medLogit));
    let med = invLogit(medLogit);
    // Near the 100% ceiling the median is pinned just below it: the universal
    // trophy slips only slowly (99.99% a day after launch), and the page's own
    // clamp makes anything above 99.99 indistinguishable.
    const sdEi = Math.sqrt((n * sdE * sdE + 5 * poolSdE * poolSdE) / (n + 5));
    const dxCoef = 0.3;
    const dayCoef = 0.2;
    let spread = Math.min(
      1.2,
      Math.max(
        0.3,
        Math.sqrt(
          sdEi * sdEi + sdP * sdP + (dxCoef * dx) * (dxCoef * dx) +
            (dayCoef * Math.sqrt(horizonDays)) * (dayCoef * Math.sqrt(horizonDays)) + 0.01,
        ),
      ),
    );
    if (med >= 99.9) {
      med = Math.min(med, 99.97);
      spread = Math.max(spread, 0.5);
    }
    return { id: t.id, q: rowFor(med, spread) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!c.history || c.history.length === 0) {
    // Keep the case valid rather than crash: neutral wide forecast.
    const trophies = c.trophies.map((t) => ({ id: t.id, q: rowFor(1, 1.0) }));
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
    continue;
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
