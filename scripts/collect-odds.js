#!/usr/bin/env node
/*
 * Collect ESPN odds snapshots for MLB / NBA into data/odds/<league>.json.
 * Runs on a schedule via GitHub Actions; appends a snapshot per game only
 * when the odds changed since the last recorded snapshot.
 *
 * File format:
 * {
 *   "updated": "2026-07-09T05:00:00.000Z",
 *   "events": {
 *     "<espnEventId>": {
 *       "key": "Away Display Name|Home Display Name",
 *       "date": "2026-07-09T17:05:00Z",       // game start (ISO, from ESPN)
 *       "snaps": [
 *         { "t": 1720500000000,
 *           "mlA": "-135", "mlH": "+115",
 *           "spA": "-1.5", "spAO": "-110", "spH": "+1.5", "spHO": "-110",
 *           "tot": "8.5", "oO": "-105", "uO": "-115" }
 *       ]
 *     }
 *   }
 * }
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LEAGUES = {
  mlb: "baseball/mlb",
  nba: "basketball/nba",
};
const OUT_DIR = path.join(__dirname, "..", "data", "odds");
const KEEP_MS = 4 * 86400000; // drop events older than 4 days
const MAX_SNAPS = 300;        // hard cap per event

function espnDate(offsetDays) {
  // ESPN scoreboard dates follow US Eastern time
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replace(/-/g, "");
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// mirrors extractEspnOdds() in assets/js/app.js, flattened for storage
function snapFromOdds(oddsArr) {
  if (!oddsArr || !oddsArr.length) return null;
  const o = oddsArr.find((x) => x.moneyline || x.pointSpread || x.total) || oddsArr[0];
  const snap = {};

  const close = (m, s) => {
    const x = m && m[s];
    return x && x.close ? x.close : null;
  };

  if (o.moneyline) {
    const a = close(o.moneyline, "away");
    const h = close(o.moneyline, "home");
    if (a && a.odds) snap.mlA = a.odds;
    if (h && h.odds) snap.mlH = h.odds;
  } else if (o.awayTeamOdds && o.awayTeamOdds.moneyLine !== undefined) {
    snap.mlA = String(o.awayTeamOdds.moneyLine);
    if (o.homeTeamOdds && o.homeTeamOdds.moneyLine !== undefined) {
      snap.mlH = String(o.homeTeamOdds.moneyLine);
    }
  }
  if (o.pointSpread) {
    const a = close(o.pointSpread, "away");
    const h = close(o.pointSpread, "home");
    if (a) { if (a.line) snap.spA = a.line; if (a.odds) snap.spAO = a.odds; }
    if (h) { if (h.line) snap.spH = h.line; if (h.odds) snap.spHO = h.odds; }
  }
  if (o.total) {
    const ov = close(o.total, "over");
    const un = close(o.total, "under");
    if (ov) {
      if (ov.line) snap.tot = String(ov.line).replace(/^[ou]/i, "");
      if (ov.odds) snap.oO = ov.odds;
    }
    if (un && un.odds) snap.uO = un.odds;
  } else if (o.overUnder !== undefined && o.overUnder !== null) {
    snap.tot = String(o.overUnder);
  }

  return Object.keys(snap).length ? snap : null;
}

function snapSig(snap) {
  const { t, ...rest } = snap;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function loadHistory(league) {
  const file = path.join(OUT_DIR, league + ".json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { updated: null, events: {} };
  }
}

async function collectLeague(league, slug) {
  const hist = loadHistory(league);
  const now = Date.now();
  let added = 0;

  // today + tomorrow (US Eastern) so opening lines for tomorrow are captured
  for (const dates of [espnDate(0), espnDate(1)]) {
    let data;
    try {
      data = await fetchJson(
        "https://site.api.espn.com/apis/site/v2/sports/" + slug + "/scoreboard?dates=" + dates
      );
    } catch (e) {
      console.error("[" + league + "] fetch failed for " + dates + ": " + e.message);
      continue;
    }
    for (const ev of data.events || []) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) continue;
      const snap = snapFromOdds(comp.odds);
      if (!snap) continue;
      const home = (comp.competitors || []).find((c) => c.homeAway === "home");
      const away = (comp.competitors || []).find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      let entry = hist.events[ev.id];
      if (!entry) {
        entry = hist.events[ev.id] = {
          key: away.team.displayName + "|" + home.team.displayName,
          date: ev.date,
          snaps: [],
        };
      }
      snap.t = now;
      const last = entry.snaps[entry.snaps.length - 1];
      if (!last || snapSig(last) !== snapSig(snap)) {
        entry.snaps.push(snap);
        if (entry.snaps.length > MAX_SNAPS) entry.snaps = entry.snaps.slice(-MAX_SNAPS);
        added++;
      }
    }
  }

  // prune stale events
  for (const id of Object.keys(hist.events)) {
    const d = new Date(hist.events[id].date).getTime();
    if (!isFinite(d) || d < now - KEEP_MS) delete hist.events[id];
  }

  hist.updated = new Date(now).toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, league + ".json"), JSON.stringify(hist));
  console.log("[" + league + "] " + added + " new snapshot(s), " +
    Object.keys(hist.events).length + " event(s) tracked");
  return added;
}

(async () => {
  let failures = 0;
  for (const [league, slug] of Object.entries(LEAGUES)) {
    try {
      await collectLeague(league, slug);
    } catch (e) {
      failures++;
      console.error("[" + league + "] collection failed: " + (e && e.message));
    }
  }
  // fail the job only if every league failed
  if (failures === Object.keys(LEAGUES).length) process.exit(1);
})();
