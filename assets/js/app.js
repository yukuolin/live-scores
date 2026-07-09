(function () {
  "use strict";

  var LEAGUES = {
    mlb: { label: "MLB 美國職棒", color: "#d64545" },
    nba: { label: "NBA 美國職籃", color: "#e0762c" },
    npb: { label: "日職 NPB", color: "#3d7ab8" },
    kbo: { label: "韓職 KBO", color: "#4a9b6e" },
  };
  var LEAGUE_ORDER = ["mlb", "nba", "npb", "kbo"];
  var SPORTSDB_IDS = { npb: "4591", kbo: "4830" };

  var state = {
    date: new Date(),
    filter: "all",
    autoRefresh: true,
    notify: false,
    gamesByLeague: { mlb: [], nba: [], npb: [], kbo: [] },
    errorByLeague: { mlb: null, nba: null, npb: null, kbo: null },
    loading: true,
    changedIds: [],
    lastUpdatedStr: null,
  };

  var sched = { timeout: null, nextAt: 0 };
  var modal = { game: null, timer: null, betlog: false };
  var sectionCache = {};
  var mlbFormCache = { t: 0, map: null };

  // ---------- storage (safe against disabled/absent localStorage) ----------
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    keys: function () { try { return Object.keys(localStorage); } catch (e) { return []; } },
  };

  // ---------- helpers ----------
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function isSameDay(a, b) { return toISODate(a) === toISODate(b); }
  function formatDateLabel(d) {
    var today = new Date();
    var yest = new Date(today); yest.setDate(today.getDate() - 1);
    var tom = new Date(today); tom.setDate(today.getDate() + 1);
    if (isSameDay(d, today)) return "今天";
    if (isSameDay(d, yest)) return "昨天";
    if (isSameDay(d, tom)) return "明天";
    return (d.getMonth() + 1) + "/" + d.getDate();
  }
  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function formatDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + formatTime(iso);
  }
  function fetchJson(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error("API " + res.status);
        return res.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // ---------- odds ----------
  function extractEspnOdds(oddsArr) {
    if (!oddsArr || !oddsArr.length) return null;
    var o = oddsArr.find(function (x) { return x.moneyline || x.pointSpread || x.total; }) || oddsArr[0];
    function side(m, s) {
      var x = m && m[s];
      if (!x) return null;
      return {
        open: x.open ? (x.open.odds || null) : null,
        cur: x.close ? (x.close.odds || null) : null,
        lineOpen: x.open ? (x.open.line || null) : null,
        line: x.close ? (x.close.line || null) : null,
      };
    }
    var res = {
      provider: o.provider ? (o.provider.displayName || o.provider.name || "") : "",
      overUnder: o.overUnder !== undefined ? o.overUnder : null,
    };
    if (o.moneyline) {
      res.mlAway = side(o.moneyline, "away");
      res.mlHome = side(o.moneyline, "home");
    } else if (o.awayTeamOdds && o.awayTeamOdds.moneyLine !== undefined) {
      res.mlAway = { cur: String(o.awayTeamOdds.moneyLine) };
      res.mlHome = { cur: String(o.homeTeamOdds && o.homeTeamOdds.moneyLine) };
    }
    if (o.pointSpread) {
      res.spAway = side(o.pointSpread, "away");
      res.spHome = side(o.pointSpread, "home");
    }
    if (o.total) {
      res.over = side(o.total, "over");
      res.under = side(o.total, "under");
    }
    if (!res.mlAway && !res.spAway && !res.over && res.overUnder === null) return null;
    return res;
  }

  function stripOU(line) { return String(line || "").replace(/^[ou]/i, ""); }

  // American odds -> implied probability (0..1)
  function impliedProb(american) {
    var o = Number(String(american || "").replace(/^\+/, ""));
    if (isNaN(o) || o === 0) return null;
    return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
  }
  function pctStr(p) { return (p * 100).toFixed(1) + "%"; }
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // implied-probability table for all posted markets; null if no usable moneyline
  function oddsImpliedAnalysis(od) {
    if (!od || !od.mlAway || !od.mlAway.cur || !od.mlHome || !od.mlHome.cur) return null;
    var ipA = impliedProb(od.mlAway.cur), ipH = impliedProb(od.mlHome.cur);
    if (ipA === null || ipH === null) return null;
    var vig = ipA + ipH;
    var fairA = ipA / vig, fairH = ipH / vig;

    var rows = "";
    rows += '<tr><td>勝負(客)</td><td>' + esc(od.mlAway.cur) + '</td><td>' + pctStr(ipA) + '</td><td>' + pctStr(fairA) + '</td></tr>';
    rows += '<tr><td>勝負(主)</td><td>' + esc(od.mlHome.cur) + '</td><td>' + pctStr(ipH) + '</td><td>' + pctStr(fairH) + '</td></tr>';
    if (od.spAway && od.spAway.cur) {
      var ipSA = impliedProb(od.spAway.cur);
      rows += '<tr><td>讓分(客 ' + esc(od.spAway.line || "") + ')</td><td>' + esc(od.spAway.cur) + '</td><td>' + (ipSA !== null ? pctStr(ipSA) : "-") + '</td><td>-</td></tr>';
    }
    if (od.spHome && od.spHome.cur) {
      var ipSH = impliedProb(od.spHome.cur);
      rows += '<tr><td>讓分(主 ' + esc(od.spHome.line || "") + ')</td><td>' + esc(od.spHome.cur) + '</td><td>' + (ipSH !== null ? pctStr(ipSH) : "-") + '</td><td>-</td></tr>';
    }
    if (od.over && od.over.cur) {
      var ipO = impliedProb(od.over.cur);
      rows += '<tr><td>大分 ' + esc(stripOU(od.over.line)) + '</td><td>' + esc(od.over.cur) + '</td><td>' + (ipO !== null ? pctStr(ipO) : "-") + '</td><td>-</td></tr>';
    }
    if (od.under && od.under.cur) {
      var ipU = impliedProb(od.under.cur);
      rows += '<tr><td>小分 ' + esc(stripOU(od.under.line)) + '</td><td>' + esc(od.under.cur) + '</td><td>' + (ipU !== null ? pctStr(ipU) : "-") + '</td><td>-</td></tr>';
    }
    var tableHtml = '<div class="table-wrap"><table class="stat-table" style="min-width:380px">' +
      '<tr><th>市場</th><th>美式賠率</th><th>隱含機率</th><th>正規化機率</th></tr>' + rows + '</table></div>';
    var vigNote = "<p>隱含機率溢價約 <b>" + ((vig - 1) * 100).toFixed(1) + "%</b>(勝負隱含機率合計 " + pctStr(vig) + ",正規化後即市場中性機率)。</p>";

    return { tableHtml: tableHtml, vigNote: vigNote, fairA: fairA, fairH: fairH };
  }

  function oddsSummary(od) {
    if (!od) return "";
    var p = [];
    if (od.mlAway && od.mlAway.cur) p.push("ML <b>" + esc(od.mlAway.cur) + " / " + esc((od.mlHome && od.mlHome.cur) || "-") + "</b>");
    if (od.spAway && od.spAway.line) p.push("讓分 <b>" + esc(od.spAway.line) + "</b>");
    if (od.over && od.over.line) p.push("大小 <b>" + esc(stripOU(od.over.line)) + "</b>");
    else if (od.overUnder !== null && od.overUnder !== undefined) p.push("大小 <b>" + esc(od.overUnder) + "</b>");
    return p.join(" · ");
  }

  function oddsSummaryPlain(od) {
    return oddsSummary(od).replace(/<\/?b>/g, "");
  }

  function buildEspnOddsMap(data) {
    var map = {};
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var od = extractEspnOdds(comp.odds);
      if (!od) return;
      var home = (comp.competitors || []).find(function (c) { return c.homeAway === "home"; });
      var away = (comp.competitors || []).find(function (c) { return c.homeAway === "away"; });
      if (home && away) map[away.team.displayName + "|" + home.team.displayName] = od;
    });
    return map;
  }

  // odds movement log (observed while this browser has the page open)
  function getOddsLog(gameId) {
    try { return JSON.parse(store.get("om-" + gameId)) || []; } catch (e) { return []; }
  }
  function recordOdds(game) {
    if (!game.odds) return;
    var sig = oddsSummaryPlain(game.odds);
    if (!sig) return;
    var key = "om-" + game.id;
    var arr = getOddsLog(game.id);
    if (arr.length && arr[arr.length - 1].s === sig) return;
    arr.push({ t: Date.now(), s: sig });
    if (arr.length > 40) arr = arr.slice(-40);
    store.set(key, JSON.stringify(arr));
  }
  function cleanupOddsLogs() {
    var cutoff = Date.now() - 3 * 86400000;
    store.keys().forEach(function (k) {
      if (k.indexOf("om-") !== 0) return;
      var arr;
      try { arr = JSON.parse(store.get(k)) || []; } catch (e) { arr = []; }
      if (!arr.length || arr[arr.length - 1].t < cutoff) store.remove(k);
    });
  }

  // ---------- server-side odds history (collected by GitHub Actions cron) ----------
  var oddsHistCache = {}; // league -> { t, data }
  function fetchOddsHistory(league) {
    if (league !== "mlb" && league !== "nba") return Promise.resolve(null);
    var c = oddsHistCache[league];
    if (c && Date.now() - c.t < 240000) return Promise.resolve(c.data);
    return fetchJson("data/odds/" + league + ".json?t=" + Math.floor(Date.now() / 240000))
      .then(function (d) { oddsHistCache[league] = { t: Date.now(), data: d }; return d; })
      .catch(function () { return c ? c.data : null; });
  }
  function findHistEntry(data, espnId, awayName, homeName, startIso) {
    if (!data || !data.events) return null;
    if (espnId && data.events[espnId]) return data.events[espnId];
    var key = awayName + "|" + homeName;
    var hit = null;
    Object.keys(data.events).forEach(function (id) {
      var e = data.events[id];
      if (e.key !== key) return;
      // same matchup repeats across a series; require same local date
      if (startIso && e.date && toISODate(new Date(e.date)) !== toISODate(new Date(startIso))) return;
      hit = e;
    });
    return hit;
  }
  // last snapshot taken before the game started (the "closing line")
  function closingSnap(entry, startIso) {
    var start = new Date(startIso || entry.date).getTime();
    if (isNaN(start)) return null;
    var snaps = entry.snaps || [], close = null;
    for (var i = 0; i < snaps.length; i++) {
      if (snaps[i].t <= start + 10 * 60000) close = snaps[i];
    }
    return close;
  }

  // ---------- bet log ----------
  function getBetLog() { try { return JSON.parse(store.get("betlog")) || []; } catch (e) { return []; } }
  function saveBetLog(arr) { store.set("betlog", JSON.stringify(arr)); }

  function recordBet(game, market, side) {
    var od = game.odds;
    if (!od) return null;
    var price = null, line = null, s;
    if (market === "ml") { s = side === "away" ? od.mlAway : od.mlHome; price = s && s.cur; }
    else if (market === "sp") { s = side === "away" ? od.spAway : od.spHome; price = s && s.cur; line = s && s.line; }
    else if (market === "ou") {
      s = side === "over" ? od.over : od.under;
      price = s && s.cur;
      line = stripOU((s && s.line) || (od.overUnder !== null && od.overUnder !== undefined ? String(od.overUnder) : ""));
    }
    if (!price) return null;
    var pick = {
      id: "p" + Date.now() + Math.random().toString(36).slice(2, 6),
      t: Date.now(),
      gameId: game.id, league: game.league, espnId: game.espnId || null,
      dateStr: toISODate(state.date), start: game.startTime || null,
      away: game.away.name, home: game.home.name,
      market: market, side: side, line: line || null, price: String(price),
      stake: 1, live: game.status === "live",
      result: null, close: null, fa: null, fh: null,
    };
    var picks = getBetLog();
    picks.push(pick);
    saveBetLog(picks);
    return pick;
  }

  function gradePick(p, finalAway, finalHome) {
    var fa = Number(finalAway), fh = Number(finalHome);
    if (!isFinite(fa) || !isFinite(fh)) return null;
    var diff;
    if (p.market === "ml") diff = p.side === "away" ? fa - fh : fh - fa;
    else if (p.market === "sp") {
      var line = Number(p.line);
      if (!isFinite(line)) return null;
      diff = p.side === "away" ? fa + line - fh : fh + line - fa;
    } else if (p.market === "ou") {
      var tot = Number(p.line);
      if (!isFinite(tot)) return null;
      diff = p.side === "over" ? fa + fh - tot : tot - (fa + fh);
    } else return null;
    if (diff > 0) return "win";
    if (diff < 0) return "loss";
    return "push";
  }

  function pickProfit(p) {
    if (p.result === "win") {
      var o = Number(String(p.price).replace(/^\+/, ""));
      if (isNaN(o) || o === 0) return 0;
      return o > 0 ? p.stake * o / 100 : p.stake * 100 / (-o);
    }
    if (p.result === "loss") return -p.stake;
    return 0;
  }

  function closePriceFromSnap(snap, p) {
    if (!snap) return null;
    var price = null, line = null;
    if (p.market === "ml") price = p.side === "away" ? snap.mlA : snap.mlH;
    else if (p.market === "sp") {
      price = p.side === "away" ? snap.spAO : snap.spHO;
      line = p.side === "away" ? snap.spA : snap.spH;
    } else if (p.market === "ou") {
      price = p.side === "over" ? snap.oO : snap.uO;
      line = snap.tot;
    }
    return price ? { price: String(price), line: line || null } : null;
  }
  function closePriceFromOdds(od, p) {
    if (!od) return null;
    var s = null;
    if (p.market === "ml") s = p.side === "away" ? od.mlAway : od.mlHome;
    else if (p.market === "sp") s = p.side === "away" ? od.spAway : od.spHome;
    else if (p.market === "ou") s = p.side === "over" ? od.over : od.under;
    if (!s || !s.cur) return null;
    return { price: String(s.cur), line: p.market === "ou" ? (stripOU(s.line) || p.line) : (s.line || null) };
  }

  // positive = the taken price beat the closing line (in probability points)
  function clvPts(p) {
    if (!p.close || !p.close.price) return null;
    if (p.market !== "ml" && String(p.line) !== String(p.close.line)) return null;
    var taken = impliedProb(p.price), close = impliedProb(p.close.price);
    if (taken === null || close === null) return null;
    return (close - taken) * 100;
  }

  // grade finished games and fill closing lines, then persist
  function settleBets() {
    var picks = getBetLog();
    var now = Date.now();
    var jobs = {}, histLeagues = {};
    picks.forEach(function (p) {
      var started = p.start && new Date(p.start).getTime() < now;
      if (!p.result && started && FETCHERS[p.league] && p.dateStr) jobs[p.league + "|" + p.dateStr] = true;
      if (!p.close && started && (p.league === "mlb" || p.league === "nba")) histLeagues[p.league] = true;
    });
    var fetches = Object.keys(jobs).map(function (k) {
      var parts = k.split("|");
      return FETCHERS[parts[0]](parts[1]).catch(function () { return []; });
    });
    var hists = Object.keys(histLeagues).map(function (lg) {
      return fetchOddsHistory(lg).then(function (d) { return { lg: lg, data: d }; });
    });
    if (!fetches.length && !hists.length) return Promise.resolve(picks);
    return Promise.all([Promise.all(fetches), Promise.all(hists)]).then(function (res) {
      var gameMap = {};
      res[0].forEach(function (games) {
        games.forEach(function (g) { gameMap[g.id] = g; });
      });
      var histMap = {};
      res[1].forEach(function (r) { histMap[r.lg] = r.data; });
      var changed = false;
      picks.forEach(function (p) {
        var g = gameMap[p.gameId];
        if (!p.result && g && g.status === "final") {
          var r = gradePick(p, g.away.score, g.home.score);
          if (r) { p.result = r; p.fa = g.away.score; p.fh = g.home.score; changed = true; }
        }
        if (!p.close) {
          var entry = findHistEntry(histMap[p.league], p.espnId, p.away, p.home, p.start);
          var cp = closePriceFromSnap(entry ? closingSnap(entry, p.start) : null, p);
          if (!cp && g && g.status === "final") cp = closePriceFromOdds(g.odds, p);
          if (cp) { p.close = cp; changed = true; }
        }
      });
      if (changed) saveBetLog(picks);
      return picks;
    });
  }

  var MARKET_SIDES = {
    ml: { away: "客勝", home: "主勝" },
    sp: { away: "讓分(客)", home: "讓分(主)" },
    ou: { over: "大分", under: "小分" },
  };
  function pickLabel(p) {
    var base = MARKET_SIDES[p.market] ? (MARKET_SIDES[p.market][p.side] || "") : "";
    if (p.market === "sp" || p.market === "ou") base += " " + (p.line || "");
    return base;
  }

  function betStatsHtml(picks) {
    var w = 0, l = 0, pu = 0, profit = 0, staked = 0;
    var clvSum = 0, clvN = 0, clvBeat = 0;
    picks.forEach(function (p) {
      if (p.result === "win") w++;
      else if (p.result === "loss") l++;
      else if (p.result === "push") pu++;
      if (p.result) { profit += pickProfit(p); staked += Number(p.stake) || 0; }
      var c = clvPts(p);
      if (c !== null) { clvSum += c; clvN++; if (c > 0) clvBeat++; }
    });
    var roi = staked > 0 ? (profit / staked) * 100 : null;
    function tile(label, val, cls) {
      return '<div class="bet-tile' + (cls ? " " + cls : "") + '"><span class="v">' + val + '</span><span class="k">' + label + '</span></div>';
    }
    var profCls = profit > 0 ? "pos" : profit < 0 ? "neg" : "";
    var avgClv = clvN ? clvSum / clvN : null;
    return '<div class="bet-tiles">' +
      tile("戰績(勝-負-平)", w + "-" + l + "-" + pu) +
      tile("淨盈虧(單位)", (profit >= 0 ? "+" : "") + profit.toFixed(2), profCls) +
      tile("ROI", roi === null ? "-" : roi.toFixed(1) + "%", profCls) +
      tile("平均 CLV", avgClv === null ? "-" : ((avgClv >= 0 ? "+" : "") + avgClv.toFixed(2) + " pts"),
        avgClv === null ? "" : avgClv > 0 ? "pos" : avgClv < 0 ? "neg" : "") +
      tile("贏過收盤線", clvN ? Math.round((clvBeat / clvN) * 100) + "%" : "-") +
      '</div>';
  }

  function kellyBoxHtml() {
    return '<div class="detail-section"><h3>Kelly / EV 計算機</h3>' +
      '<div class="kelly-row">' +
      '<label>自估勝率% <input id="kellyProb" type="number" min="1" max="99" step="0.5" value="55"></label>' +
      '<label>美式賠率 <input id="kellyOdds" type="text" value="-110"></label>' +
      '<label>資金 <input id="kellyBank" type="number" min="0" value="10000"></label>' +
      '<button class="text-btn" id="kellyCalcBtn">計算</button>' +
      '</div><div id="kellyOut" class="kelly-out"></div></div>';
  }
  function runKelly() {
    var out = document.getElementById("kellyOut");
    if (!out) return;
    var prob = Number(document.getElementById("kellyProb").value) / 100;
    var oddsStr = document.getElementById("kellyOdds").value;
    var bank = Number(document.getElementById("kellyBank").value) || 0;
    var o = Number(String(oddsStr).replace(/^\+/, ""));
    if (!(prob > 0 && prob < 1) || isNaN(o) || o === 0) {
      out.innerHTML = '<span class="neg">請輸入有效的勝率與美式賠率。</span>';
      return;
    }
    var b = o > 0 ? o / 100 : 100 / (-o);
    var q = 1 - prob;
    var ev = prob * b - q; // per 1 unit staked
    var breakeven = impliedProb(oddsStr);
    if (ev <= 0) {
      out.innerHTML = '損益兩平勝率 <b>' + pctStr(breakeven) + '</b>,你的估計 <b>' + pctStr(prob) +
        '</b> → EV <span class="neg">' + (ev * 100).toFixed(1) + '%</span>,無優勢,不建議下注。';
      return;
    }
    var kelly = (b * prob - q) / b;
    var half = kelly / 2;
    out.innerHTML = 'EV <span class="pos">+' + (ev * 100).toFixed(1) + '%</span> ・ 損益兩平勝率 ' + pctStr(breakeven) +
      '<br>全 Kelly <b>' + (kelly * 100).toFixed(1) + '%</b>' + (bank ? '(' + Math.round(bank * kelly) + ')' : '') +
      ' ・ 半 Kelly <b>' + (half * 100).toFixed(1) + '%</b>' + (bank ? '(<b>' + Math.round(bank * half) + '</b>)' : '') +
      '<br><span class="detail-note">實務建議使用半 Kelly 以下,並確認勝率估計的穩健性。</span>';
  }

  function renderBetLogHtml(picks, settling) {
    var html = '<div class="detail-header"><span class="detail-league">📒 注單紀錄</span>' +
      (settling ? '<span class="status-pill scheduled">結算中…</span>' : '') + '</div>';
    html += betStatsHtml(picks);
    html += kellyBoxHtml();
    if (!picks.length) {
      html += '<div class="detail-section"><p class="detail-note">尚無注單。開啟任一場比賽的詳細資料,在賠率區點「記錄注單」即可把當下價位存進來;完賽後自動結算,並對比收盤線計算 CLV。</p></div>';
      return html;
    }
    var rows = "";
    picks.slice().reverse().forEach(function (p) {
      var res = p.result === "win" ? '<span class="bet-res win">勝</span>' :
        p.result === "loss" ? '<span class="bet-res loss">負</span>' :
        p.result === "push" ? '<span class="bet-res push">平</span>' :
        '<span class="bet-res pending">未結</span>';
      var clv = clvPts(p);
      var clvHtml = clv === null ? "-" :
        '<span class="' + (clv > 0 ? "pos" : clv < 0 ? "neg" : "") + '">' + (clv >= 0 ? "+" : "") + clv.toFixed(2) + '</span>';
      var closeHtml = p.close && p.close.price ? esc((p.close.line ? p.close.line + " " : "") + p.close.price) : "-";
      var score = (p.result && p.fa !== null && p.fa !== undefined) ? (p.fa + ":" + p.fh) : "";
      rows += '<tr>' +
        '<td>' + esc(formatDateTime(p.start) || p.dateStr) +
          '<br><span class="bet-match">' + esc(p.away) + ' @ ' + esc(p.home) + (score ? " (" + esc(score) + ")" : "") + '</span></td>' +
        '<td>' + esc(pickLabel(p)) + (p.live ? ' <span class="bet-live-tag">滾球</span>' : '') + '</td>' +
        '<td>' + esc(p.price) + '</td>' +
        '<td>' + closeHtml + '</td>' +
        '<td>' + clvHtml + '</td>' +
        '<td><input class="bet-stake" data-id="' + esc(p.id) + '" type="number" min="0" step="0.5" value="' + (Number(p.stake) || 0) + '"></td>' +
        '<td>' + res + '</td>' +
        '<td><button class="bet-del" data-id="' + esc(p.id) + '" title="刪除">✕</button></td>' +
        '</tr>';
    });
    html += '<div class="detail-section"><h3>注單明細</h3>' +
      '<div class="table-wrap"><table class="stat-table" style="min-width:640px">' +
      '<tr><th>比賽</th><th>投注</th><th>取得價</th><th>收盤價</th><th>CLV</th><th>注碼</th><th>結果</th><th></th></tr>' +
      rows + '</table></div>' +
      '<div class="bet-toolbar"><button class="text-btn" id="betExportBtn">匯出 CSV</button>' +
      '<button class="text-btn danger" id="betClearBtn">清空全部</button></div>' +
      '<div class="detail-note">CLV 為「取得價 vs 收盤價」的隱含機率差(百分點),正值代表贏過收盤線;讓分/大小若盤數移動則不計。收盤線來自本站每 20 分鐘的盤口採樣。</div>' +
      '</div>';
    return html;
  }

  function openBetLog() {
    modal.game = null;
    modal.betlog = true;
    if (modal.timer) { clearInterval(modal.timer); modal.timer = null; }
    var m = document.getElementById("modal");
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.getElementById("modalBody").innerHTML = renderBetLogHtml(getBetLog(), true);
    settleBets().then(function (picks) {
      if (!modal.betlog) return;
      document.getElementById("modalBody").innerHTML = renderBetLogHtml(picks, false);
    });
  }

  function setBetStake(id, val) {
    var picks = getBetLog();
    var p = picks.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var n = Number(val);
    p.stake = isFinite(n) && n >= 0 ? n : 1;
    saveBetLog(picks);
    var tiles = document.querySelector(".bet-tiles");
    if (tiles) tiles.outerHTML = betStatsHtml(picks); // keep input focus, refresh stats only
  }
  function deleteBet(id) {
    saveBetLog(getBetLog().filter(function (x) { return x.id !== id; }));
    if (modal.betlog) document.getElementById("modalBody").innerHTML = renderBetLogHtml(getBetLog(), false);
  }
  function clearBets() {
    if (!window.confirm("確定要清空所有注單紀錄?此動作無法復原。")) return;
    saveBetLog([]);
    if (modal.betlog) document.getElementById("modalBody").innerHTML = renderBetLogHtml([], false);
  }
  function exportBetsCsv() {
    var picks = getBetLog();
    var head = "date,league,away,home,market,side,line,price,stake,result,close_line,close_price,clv_pts";
    var lines = picks.map(function (p) {
      var clv = clvPts(p);
      return [p.start || p.dateStr, p.league, p.away, p.home, p.market, p.side, p.line || "", p.price,
        p.stake, p.result || "", (p.close && p.close.line) || "", (p.close && p.close.price) || "",
        clv === null ? "" : clv.toFixed(2)
      ].map(function (v) {
        v = String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    });
    var blob = new Blob(["\ufeff" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "betlog-" + toISODate(new Date()) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- pins ----------
  var pinSet = (function () {
    try { return new Set(JSON.parse(store.get("pins")) || []); } catch (e) { return new Set(); }
  })();
  function togglePin(id) {
    if (pinSet.has(id)) pinSet.delete(id); else pinSet.add(id);
    store.set("pins", JSON.stringify(Array.from(pinSet)));
  }

  // ---------- score fetchers ----------
  function fetchMLB(dateStr) {
    var ymd = dateStr.replace(/-/g, "");
    var schedP = fetchJson("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=" + dateStr + "&hydrate=linescore,team");
    var oddsP = fetchJson("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=" + ymd)
      .then(buildEspnOddsMap).catch(function () { return {}; });

    return Promise.all([schedP, oddsP]).then(function (results) {
      var data = results[0], oddsMap = results[1];
      var games = [];
      (data.dates || []).forEach(function (d) {
        (d.games || []).forEach(function (g) {
          var status = g.status || {};
          var linescore = g.linescore || {};
          var cat = "scheduled";
          if (status.abstractGameState === "Live") cat = "live";
          else if (status.abstractGameState === "Final") cat = "final";
          else if (/Postponed|Suspended|Cancelled/i.test(status.detailedState || "")) cat = "postponed";

          var detail;
          if (cat === "live") {
            var half = linescore.isTopInning ? "上" : "下";
            detail = (linescore.currentInning ? linescore.currentInning + "局" + half : status.detailedState);
          } else if (cat === "scheduled") {
            detail = formatTime(g.gameDate);
          } else {
            detail = status.detailedState || "";
          }

          var awayName = g.teams.away.team.name;
          var homeName = g.teams.home.team.name;
          games.push({
            id: "mlb-" + g.gamePk,
            league: "mlb",
            gamePk: g.gamePk,
            status: cat,
            detail: detail,
            startTime: g.gameDate,
            odds: oddsMap[awayName + "|" + homeName] || null,
            away: {
              name: awayName,
              score: g.teams.away.score,
              logo: "https://www.mlbstatic.com/team-logos/" + g.teams.away.team.id + ".svg",
            },
            home: {
              name: homeName,
              score: g.teams.home.score,
              logo: "https://www.mlbstatic.com/team-logos/" + g.teams.home.team.id + ".svg",
            },
          });
        });
      });
      return games;
    });
  }

  function fetchNBA(dateStr) {
    var ymd = dateStr.replace(/-/g, "");
    var url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=" + ymd;
    return fetchJson(url).then(function (data) {
      return (data.events || []).map(function (ev) {
        var comp = ev.competitions[0];
        var home = comp.competitors.find(function (c) { return c.homeAway === "home"; });
        var away = comp.competitors.find(function (c) { return c.homeAway === "away"; });
        var statusType = comp.status.type || {};
        var cat = "scheduled";
        if (statusType.state === "in") cat = "live";
        else if (statusType.state === "post") cat = "final";

        var detail;
        if (cat === "live") {
          detail = (comp.status.period ? "第" + comp.status.period + "節 " : "") + (comp.status.displayClock || "");
        } else if (cat === "scheduled") {
          detail = formatTime(ev.date);
        } else {
          detail = statusType.shortDetail || "已完賽";
        }

        return {
          id: "nba-" + ev.id,
          league: "nba",
          espnId: ev.id,
          status: cat,
          detail: detail,
          startTime: ev.date,
          odds: extractEspnOdds(comp.odds),
          away: { name: away.team.displayName, score: away.score, logo: away.team.logo },
          home: { name: home.team.displayName, score: home.score, logo: home.team.logo },
        };
      });
    });
  }

  function fetchSportsDBLeague(leagueKey, dateStr) {
    var leagueId = SPORTSDB_IDS[leagueKey];
    var url = "https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=" + dateStr + "&l=" + leagueId;
    return fetchJson(url).then(function (data) {
      var events = data.events || [];
      return events.map(function (e) {
        var raw = (e.strStatus || "").toUpperCase();
        var cat = "scheduled";
        if (["FT", "AOT", "AET", "CANC", "POST"].indexOf(raw) !== -1) cat = "final";
        else if (raw && raw !== "NS") cat = "live";

        // strTimestamp is UTC but has no zone marker; append Z so it converts to local time
        var ts = e.strTimestamp
          ? (e.strTimestamp.indexOf("Z") === -1 ? e.strTimestamp + "Z" : e.strTimestamp)
          : null;

        var detail;
        if (cat === "scheduled") {
          detail = ts ? formatTime(ts) : (e.strTime ? e.strTime.slice(0, 5) : "");
        } else if (cat === "live") {
          detail = e.strProgress || raw || "進行中";
        } else {
          detail = "已完賽";
        }

        var awayScore = e.intAwayScore !== null && e.intAwayScore !== undefined ? Number(e.intAwayScore) : null;
        var homeScore = e.intHomeScore !== null && e.intHomeScore !== undefined ? Number(e.intHomeScore) : null;

        return {
          id: leagueKey + "-" + e.idEvent,
          league: leagueKey,
          tsdbId: e.idEvent,
          raw: e,
          status: cat,
          detail: detail,
          startTime: ts,
          odds: null,
          away: { name: e.strAwayTeam, score: awayScore, logo: e.strAwayTeamBadge || null },
          home: { name: e.strHomeTeam, score: homeScore, logo: e.strHomeTeamBadge || null },
        };
      });
    });
  }

  var FETCHERS = {
    mlb: fetchMLB,
    nba: fetchNBA,
    npb: function (d) { return fetchSportsDBLeague("npb", d); },
    kbo: function (d) { return fetchSportsDBLeague("kbo", d); },
  };

  // ---------- notifications ----------
  function canNotify() {
    return typeof Notification !== "undefined" && Notification.permission === "granted";
  }
  function notifyChange(game, isFinal) {
    if (!state.notify || !canNotify()) return;
    try {
      new Notification(LEAGUES[game.league].label + (isFinal ? " 比賽結束" : " 比分變動"), {
        body: game.away.name + " " + scoreText(game.away.score) + " : " +
              scoreText(game.home.score) + " " + game.home.name + "(" + (game.detail || "") + ")",
        tag: game.id,
      });
    } catch (e) {}
  }

  // ---------- load ----------
  function loadLeague(key) {
    var dateStr = toISODate(state.date);
    var prev = {};
    state.gamesByLeague[key].forEach(function (g) { prev[g.id] = g; });

    return FETCHERS[key](dateStr)
      .then(function (games) {
        games.sort(function (a, b) {
          var pa = pinSet.has(a.id) ? 0 : 1, pb = pinSet.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          var order = { live: 0, scheduled: 1, final: 2, postponed: 3 };
          if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
          return new Date(a.startTime) - new Date(b.startTime);
        });

        games.forEach(function (g) {
          var old = prev[g.id];
          if (old && (String(old.away.score) !== String(g.away.score) || String(old.home.score) !== String(g.home.score))) {
            state.changedIds.push(g.id);
            notifyChange(g, false);
          } else if (old && old.status === "live" && g.status === "final") {
            state.changedIds.push(g.id);
            notifyChange(g, true);
          }
          recordOdds(g);
        });

        state.gamesByLeague[key] = games;
        state.errorByLeague[key] = null;
      })
      .catch(function (err) {
        state.errorByLeague[key] = err.message || "載入失敗";
      });
  }

  function loadAll() {
    state.loading = true;
    render();
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    return Promise.allSettled(keys.map(loadLeague)).then(function () {
      state.loading = false;
      state.lastUpdatedStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      saveSnapshot();
      render();
      updateStatusText();
    });
  }

  // ---------- snapshot cache (instant paint on reload) ----------
  function saveSnapshot() {
    try {
      store.set("snap", JSON.stringify({
        date: toISODate(state.date),
        data: state.gamesByLeague,
        t: Date.now(),
      }));
    } catch (e) {}
  }
  function restoreSnapshot() {
    try {
      var snap = JSON.parse(store.get("snap"));
      if (snap && snap.date === toISODate(new Date()) && snap.data) {
        state.gamesByLeague = snap.data;
        state.loading = false;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------- adaptive refresh ----------
  function computeInterval() {
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    var anyLive = false, anyPre = false;
    keys.forEach(function (k) {
      state.gamesByLeague[k].forEach(function (g) {
        if (g.status === "live") anyLive = true;
        if (g.status === "scheduled") anyPre = true;
      });
    });
    if (anyLive) return 10000;
    if (anyPre && isSameDay(state.date, new Date())) return 30000;
    return 60000;
  }

  function scheduleNext() {
    if (sched.timeout) clearTimeout(sched.timeout);
    sched.timeout = null;
    if (!state.autoRefresh) { sched.nextAt = 0; updateStatusText(); return; }
    var iv = computeInterval();
    sched.nextAt = Date.now() + iv;
    sched.timeout = setTimeout(function () {
      if (document.hidden) { scheduleNext(); return; }
      loadAll().then(scheduleNext);
    }, iv);
  }

  function updateStatusText() {
    var el = document.getElementById("updatedAt");
    if (!el) return;
    var txt = state.lastUpdatedStr ? "最後更新 " + state.lastUpdatedStr : "尚未更新";
    if (!state.autoRefresh) {
      txt += " · 自動更新關閉";
    } else if (sched.nextAt) {
      var s = Math.max(0, Math.round((sched.nextAt - Date.now()) / 1000));
      txt += " · " + s + " 秒後更新";
    }
    el.textContent = txt;
  }

  // ---------- scoreboard render ----------
  function teamLogoHtml(team) {
    if (team.logo) {
      return '<img class="team-logo" src="' + esc(team.logo) + '" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'team-logo-fallback\'}))">';
    }
    return '<span class="team-logo-fallback"></span>';
  }

  function scoreText(score) {
    return score === null || score === undefined ? "-" : String(score);
  }

  function gameCardHtml(game, color) {
    var homeWin = game.status === "final" && game.home.score !== null && game.away.score !== null && Number(game.home.score) > Number(game.away.score);
    var awayWin = game.status === "final" && game.home.score !== null && game.away.score !== null && Number(game.away.score) > Number(game.home.score);

    var statusHtml;
    if (game.status === "live") {
      statusHtml = '<span class="status-pill live"><span class="live-dot"></span>LIVE</span>';
    } else if (game.status === "final") {
      statusHtml = '<span class="status-pill final">已完賽</span>';
    } else if (game.status === "postponed") {
      statusHtml = '<span class="status-pill final">延賽</span>';
    } else {
      statusHtml = '<span class="status-pill scheduled">未開始</span>';
    }

    var pinned = pinSet.has(game.id);
    var pinBtn = '<button class="pin-btn' + (pinned ? " pinned" : "") + '" data-pin="' + esc(game.id) + '" title="釘選置頂">' + (pinned ? "★" : "☆") + '</button>';

    var oddsHtml = "";
    if (game.odds && game.status === "scheduled") {
      var sum = oddsSummary(game.odds);
      var badge = oddsMoveBadge(game.odds);
      if (sum || badge) oddsHtml = '<div class="odds-row">' + sum + badge + '</div>';
    }

    return (
      '<div class="game-card clickable" data-gid="' + esc(game.id) + '" style="--league-color:' + color + '">' +
        '<div class="game-status-row"><span class="status-left">' + pinBtn + statusHtml + '</span><span class="game-detail">' + esc(game.detail || "") + '</span></div>' +
        '<div class="team-row' + (awayWin ? " winner" : "") + '">' +
          '<div class="team-info">' + teamLogoHtml(game.away) + '<span class="team-name">' + esc(game.away.name) + '</span></div>' +
          '<span class="team-score">' + esc(scoreText(game.away.score)) + '</span>' +
        '</div>' +
        '<div class="team-row' + (homeWin ? " winner" : "") + '">' +
          '<div class="team-info">' + teamLogoHtml(game.home) + '<span class="team-name">' + esc(game.home.name) + '</span></div>' +
          '<span class="team-score">' + esc(scoreText(game.home.score)) + '</span>' +
        '</div>' +
        oddsHtml +
      '</div>'
    );
  }

  function skeletonHtml() {
    var out = "";
    for (var i = 0; i < 3; i++) out += '<div class="skeleton"></div>';
    return out;
  }

  function sectionHtml(key) {
    var league = LEAGUES[key];
    var games = state.gamesByLeague[key];
    var error = state.errorByLeague[key];
    var showLoading = state.loading && games.length === 0 && !error;

    var body;
    if (error) {
      body = '<div class="error-state">' + esc(error) + '<br><button onclick="window.__scoreApp.retryLeague(\'' + key + '\')">重試</button></div>';
    } else if (showLoading) {
      body = '<div class="game-grid">' + skeletonHtml() + '</div>';
    } else if (games.length === 0) {
      body = '<div class="empty-state">這天沒有賽事</div>';
    } else {
      body = '<div class="game-grid">' + games.map(function (g) { return gameCardHtml(g, league.color); }).join("") + '</div>';
    }

    return (
      '<section class="league-section" data-league="' + key + '">' +
        '<div class="league-section-header">' +
          '<span class="league-dot" style="background:' + league.color + '"></span>' +
          '<h2>' + league.label + '</h2>' +
          '<span class="league-count">' + (error ? "" : games.length + " 場") + '</span>' +
        '</div>' +
        body +
      '</section>'
    );
  }

  function render(force) {
    var keys = state.filter === "all" ? LEAGUE_ORDER : [state.filter];
    var container = document.getElementById("content");
    var structureKey = keys.join(",") + "|" + toISODate(state.date);

    if (force || container.dataset.structure !== structureKey) {
      container.dataset.structure = structureKey;
      sectionCache = {};
      var parts = keys.map(function (k) {
        var h = sectionHtml(k);
        sectionCache[k] = h;
        return h;
      });
      container.innerHTML = parts.join("");
    } else {
      keys.forEach(function (k) {
        var h = sectionHtml(k);
        if (sectionCache[k] === h) return;
        sectionCache[k] = h;
        var el = container.querySelector('section[data-league="' + k + '"]');
        if (el) {
          var tmp = document.createElement("div");
          tmp.innerHTML = h;
          el.replaceWith(tmp.firstElementChild);
        }
      });
    }

    // flash score changes
    state.changedIds.forEach(function (id) {
      var card = container.querySelector('[data-gid="' + id + '"]');
      if (card) {
        card.classList.add("flash");
        setTimeout(function () { card.classList.remove("flash"); }, 2600);
      }
    });
    state.changedIds = [];

    document.getElementById("dateLabel").textContent = formatDateLabel(state.date);
  }

  // ================================================================
  // Game detail modal
  // ================================================================

  function findGame(gid) {
    for (var i = 0; i < LEAGUE_ORDER.length; i++) {
      var arr = state.gamesByLeague[LEAGUE_ORDER[i]];
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].id === gid) return arr[j];
      }
    }
    return null;
  }

  function statusPillHtml(game) {
    if (game.status === "live") return '<span class="status-pill live"><span class="live-dot"></span>LIVE</span>';
    if (game.status === "final") return '<span class="status-pill final">已完賽</span>';
    if (game.status === "postponed") return '<span class="status-pill final">延賽</span>';
    return '<span class="status-pill scheduled">未開始</span>';
  }

  function detailHeaderHtml(game, awaySub, homeSub) {
    function teamCol(t, sub) {
      var img = t.logo ? '<img src="' + esc(t.logo) + '" alt="" onerror="this.style.display=\'none\'">' : "";
      return '<div class="detail-team">' + img +
        '<span class="name">' + esc(t.name) + '</span>' +
        (sub ? '<span class="sub">' + esc(sub) + '</span>' : "") +
        '</div>';
    }
    var scoreHtml;
    if (game.status === "scheduled" || game.status === "postponed") {
      scoreHtml = '<div class="detail-score"><span class="sep">vs</span></div>';
    } else {
      scoreHtml = '<div class="detail-score">' + esc(scoreText(game.away.score)) +
        '<span class="sep">:</span>' + esc(scoreText(game.home.score)) + '</div>';
    }
    return (
      '<div class="detail-header">' +
        '<span class="detail-league">' + LEAGUES[game.league].label + '</span>' +
        statusPillHtml(game) +
      '</div>' +
      '<div class="detail-matchup">' +
        teamCol(game.away, awaySub || "客隊") + scoreHtml + teamCol(game.home, homeSub || "主隊") +
      '</div>' +
      '<div class="detail-status-line">' + esc(game.detail || "") + '</div>'
    );
  }

  function sectionBlock(title, inner) {
    return '<div class="detail-section"><h3>' + esc(title) + '</h3>' + inner + '</div>';
  }

  function probBarHtml(awayLabel, homeLabel, awayPct, homePct) {
    return (
      '<div class="prob-bar-wrap">' +
        '<div class="prob-labels"><span>' + esc(awayLabel) + ' <b>' + awayPct.toFixed(1) + '%</b></span>' +
        '<span><b>' + homePct.toFixed(1) + '%</b> ' + esc(homeLabel) + '</span></div>' +
        '<div class="prob-bar"><div class="away-part" style="width:' + awayPct + '%"></div>' +
        '<div class="home-part" style="width:' + homePct + '%"></div></div>' +
      '</div>'
    );
  }

  // ---------- odds detail sections ----------
  function oddsDetailHtml(game) {
    var html = "";
    var od = game.odds;
    if (od) {
      function cell(s) {
        if (!s) return "-";
        var line = s.line ? esc(s.line) + " " : "";
        return line + esc(s.cur || "-");
      }
      function openCell(s) {
        if (!s) return "-";
        var line = s.lineOpen ? esc(s.lineOpen) + " " : "";
        return line + esc(s.open || "-");
      }
      var rows = "";
      if (od.mlAway) {
        rows += '<tr><td>勝負(客)' + '</td><td>' + openCell(od.mlAway) + '</td><td><b>' + cell(od.mlAway) + '</b></td></tr>';
        rows += '<tr><td>勝負(主)' + '</td><td>' + openCell(od.mlHome) + '</td><td><b>' + cell(od.mlHome) + '</b></td></tr>';
      }
      if (od.spAway) {
        rows += '<tr><td>讓分(客)</td><td>' + openCell(od.spAway) + '</td><td><b>' + cell(od.spAway) + '</b></td></tr>';
        rows += '<tr><td>讓分(主)</td><td>' + openCell(od.spHome) + '</td><td><b>' + cell(od.spHome) + '</b></td></tr>';
      }
      if (od.over) {
        rows += '<tr><td>大分</td><td>' + openCell(od.over) + '</td><td><b>' + cell(od.over) + '</b></td></tr>';
        rows += '<tr><td>小分</td><td>' + openCell(od.under) + '</td><td><b>' + cell(od.under) + '</b></td></tr>';
      }
      if (rows) {
        html += sectionBlock("賠率" + (od.provider ? "(" + od.provider + ")" : ""),
          '<div class="table-wrap"><table class="stat-table" style="min-width:320px">' +
          '<tr><th>市場</th><th>開盤</th><th>目前</th></tr>' + rows + '</table></div>' +
          betButtonsHtml(game) +
          espnMoveNote(od, game) +
          '<div class="detail-note">美式賠率,僅供參考。</div>');
      }
    }

    // filled asynchronously from data/odds/<league>.json (see hydrateOddsHistory)
    html += '<div class="detail-section odds-hist-slot" id="oddsHistSlot" style="display:none"></div>';

    var log = getOddsLog(game.id);
    if (log.length > 1) {
      var items = log.slice(-12).reverse().map(function (e) {
        return '<li><span class="mt">' + formatTime(new Date(e.t).toISOString()) + '</span><span>' + esc(e.s) + '</span></li>';
      }).join("");
      html += sectionBlock("賠率異動紀錄", '<ul class="move-list">' + items + '</ul>' +
        '<div class="detail-note">僅記錄本瀏覽器開啟頁面期間觀測到的變化。</div>');
    }
    return html;
  }

  function betButtonsHtml(game) {
    var od = game.odds;
    if (!od || game.status === "final" || game.status === "postponed") return "";
    var btns = "";
    function b(market, side, label) {
      btns += '<button class="bet-rec" data-market="' + market + '" data-side="' + side + '">' + esc(label) + '</button>';
    }
    if (od.mlAway && od.mlAway.cur) b("ml", "away", "客勝 " + od.mlAway.cur);
    if (od.mlHome && od.mlHome.cur) b("ml", "home", "主勝 " + od.mlHome.cur);
    if (od.spAway && od.spAway.cur) b("sp", "away", "客 " + (od.spAway.line || "") + " " + od.spAway.cur);
    if (od.spHome && od.spHome.cur) b("sp", "home", "主 " + (od.spHome.line || "") + " " + od.spHome.cur);
    if (od.over && od.over.cur) b("ou", "over", "大 " + stripOU(od.over.line) + " " + od.over.cur);
    if (od.under && od.under.cur) b("ou", "under", "小 " + stripOU(od.under.line) + " " + od.under.cur);
    if (!btns) return "";
    return '<div class="bet-actions"><span class="bet-actions-label">記錄注單:</span>' + btns + '</div>';
  }

  // ---------- line movement analysis (which side the market is warming to) ----------
  // vig-free home win probability implied by a snapshot's moneyline
  function snapFairHome(s) {
    if (!s || !s.mlA || !s.mlH) return null;
    var a = impliedProb(s.mlA), h = impliedProb(s.mlH);
    if (a === null || h === null || a + h === 0) return null;
    return h / (a + h);
  }

  function moveVerdictHtml(votesHome, votesAway, game) {
    if (votesHome === votesAway) {
      return '<div class="move-verdict flat">⚖️ 市場動向:雙方評價變化不大或方向分歧,暫無明顯傾斜。</div>';
    }
    var homeFav = votesHome > votesAway;
    var name = homeFav ? game.home.name : game.away.name;
    return '<div class="move-verdict ' + (homeFav ? "home" : "away") + '">📈 市場動向:<b>' +
      esc(name) + (homeFav ? "(主)" : "(客)") + '</b> 越來越被看好。</div>';
  }

  function lineMoveAnalysis(entry, game) {
    var snaps = entry.snaps || [];
    if (snaps.length < 2) return "";
    var first = snaps[0], last = snaps[snaps.length - 1];
    var votesHome = 0, votesAway = 0;
    var msgs = [];

    // moneyline: shift in vig-free implied probability
    var f = snapFairHome(first), l = snapFairHome(last);
    if (f !== null && l !== null) {
      var d = (l - f) * 100;
      if (Math.abs(d) >= 1) {
        if (d > 0) votesHome++; else votesAway++;
        var side = d > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
        msgs.push("勝負盤:主隊市場中性機率由 " + pctStr(f) + " 移至 <b>" + pctStr(l) + "</b>(" +
          (d >= 0 ? "+" : "") + d.toFixed(1) + " 百分點),資金流向 <b>" + esc(side) + "</b>。");
      } else {
        msgs.push("勝負盤:隱含機率自開盤僅變動 " + (d >= 0 ? "+" : "") + d.toFixed(1) + " 百分點,市場對勝負的評價大致持平。");
      }
    }

    // spread depth: spA is the away line; more negative = away asked to give more points
    var sf = Number(first.spA), sl = Number(last.spA);
    if (isFinite(sf) && isFinite(sl) && sf !== sl) {
      var towardAway = sl < sf;
      if (towardAway) votesAway++; else votesHome++;
      msgs.push("讓分盤:客隊盤口由 " + esc(String(first.spA)) + " 移至 <b>" + esc(String(last.spA)) + "</b>," +
        (towardAway
          ? "客隊被要求讓出更多分數,市場對<b>" + esc(game.away.name) + "(客)</b>的信心增強"
          : "盤口向主隊方向移動,市場對<b>" + esc(game.home.name) + "(主)</b>的評價上升") + "。");
    }

    // total: market's expectation of combined scoring
    var tf = Number(first.tot), tl = Number(last.tot);
    if (isFinite(tf) && isFinite(tl) && tf !== tl) {
      msgs.push("大小盤:總分線由 " + esc(String(first.tot)) + " 調整至 <b>" + esc(String(last.tot)) + "</b>," +
        (tl > tf ? "市場預期總得分上修,大分方向獲得資金支持" : "市場預期總得分下修,小分方向獲得資金支持") + "。");
    }

    // late window: compare the last ~6h against the overall move to flag steam / reversal
    var cutoff = last.t - 6 * 3600000;
    var recentFirst = null;
    for (var i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t >= cutoff) { recentFirst = snaps[i]; break; }
    }
    if (recentFirst && f !== null && l !== null) {
      var rf = snapFairHome(recentFirst);
      if (rf !== null) {
        var rd = (l - rf) * 100, od = (l - f) * 100;
        if (Math.abs(rd) >= 1.5) {
          var recentSide = rd > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
          var sameDir = (rd > 0) === (od > 0) && Math.abs(od) >= 1;
          msgs.push("近 6 小時:<b>" + esc(recentSide) + "</b> 隱含機率再升 " + Math.abs(rd).toFixed(1) + " 個百分點," +
            (sameDir ? "與整體走勢同向,盤口持續傾斜,注意臨場 steam move" : "與早盤方向相反,可能有消息面(先發/傷兵)引發市場反轉") + "。");
        }
      }
    }

    if (!msgs.length) return "";
    return moveVerdictHtml(votesHome, votesAway, game) +
      '<div class="analysis-box" style="margin-bottom:10px">' +
      msgs.map(function (m) { return "<p>" + m + "</p>"; }).join("") + '</div>';
  }

  // same idea but from ESPN's own open vs. current prices (works without our sampling)
  function espnMoveNote(od, game) {
    if (!od || !od.mlAway || !od.mlHome) return "";
    var oa = impliedProb(od.mlAway.open), oh = impliedProb(od.mlHome.open);
    var ca = impliedProb(od.mlAway.cur), ch = impliedProb(od.mlHome.cur);
    if (oa === null || oh === null || ca === null || ch === null) return "";
    if (oa + oh === 0 || ca + ch === 0) return "";
    var f0 = oh / (oa + oh), f1 = ch / (ca + ch);
    var d = (f1 - f0) * 100;
    if (Math.abs(d) < 1) return "";
    var side = d > 0 ? game.home.name + "(主)" : game.away.name + "(客)";
    return '<div class="detail-note">開盤至今,<b>' + esc(side) + '</b> 的市場中性勝率由 ' +
      pctStr(f0) + ' 升至 ' + pctStr(f1) + ',為市場資金較看好的一方。</div>';
  }

  // card badge: which side has gained implied probability since open
  function oddsMoveBadge(od) {
    if (!od || !od.mlAway || !od.mlHome) return "";
    var oa = impliedProb(od.mlAway.open), oh = impliedProb(od.mlHome.open);
    var ca = impliedProb(od.mlAway.cur), ch = impliedProb(od.mlHome.cur);
    if (oa === null || oh === null || ca === null || ch === null) return "";
    if (oa + oh === 0 || ca + ch === 0) return "";
    var d = (ch / (ca + ch) - oh / (oa + oh)) * 100;
    if (Math.abs(d) < 1.5) return "";
    return '<span class="move-badge ' + (d > 0 ? "home" : "away") + '" title="開盤至今勝負盤隱含機率變化,箭頭指向市場趨熱的一方">' +
      (d > 0 ? "📈主" : "📈客") + " +" + Math.abs(d).toFixed(1) + '</span>';
  }

  function histTableHtml(entry, startIso) {
    var snaps = entry.snaps || [];
    if (!snaps.length) return "";
    var close = closingSnap(entry, startIso);
    var shown = snaps.slice(-24);
    var rows = "";
    for (var i = shown.length - 1; i >= 0; i--) {
      var s = shown[i], prev = i > 0 ? shown[i - 1] : null;
      var mark = function (field) {
        var v = s[field] === undefined || s[field] === null ? "-" : String(s[field]);
        var changed = prev && String(prev[field] === undefined ? "" : prev[field]) !== String(s[field] === undefined ? "" : s[field]);
        return changed ? "<b>" + esc(v) + "</b>" : esc(v);
      };
      rows += '<tr' + (close && s.t === close.t ? ' class="close-row"' : '') + '>' +
        '<td>' + esc(formatDateTime(new Date(s.t).toISOString())) +
          (close && s.t === close.t ? ' <span class="close-tag">收盤</span>' : '') + '</td>' +
        '<td>' + mark("mlA") + ' / ' + mark("mlH") + '</td>' +
        '<td>' + mark("spA") + ' (' + mark("spAO") + ')</td>' +
        '<td>' + mark("tot") + ' (' + mark("oO") + '/' + mark("uO") + ')</td>' +
        '</tr>';
    }
    return '<div class="table-wrap"><table class="stat-table" style="min-width:460px">' +
      '<tr><th>時間</th><th>勝負(客/主)</th><th>讓分(客)</th><th>大小(O/U)</th></tr>' + rows + '</table></div>' +
      '<div class="detail-note">由本站排程每 20 分鐘採樣 ESPN 盤口,僅在數字變動時記錄。</div>';
  }

  function hydrateOddsHistory(game) {
    if (game.league !== "mlb" && game.league !== "nba") return;
    fetchOddsHistory(game.league).then(function (data) {
      if (modal.game !== game) return; // modal switched or closed meanwhile
      var slot = document.getElementById("oddsHistSlot");
      if (!slot) return;
      var entry = data && findHistEntry(data, game.espnId, game.away.name, game.home.name, game.startTime);
      if (!entry || !(entry.snaps || []).length) return;
      slot.style.display = "";
      slot.innerHTML = "<h3>盤口走勢與市場動向</h3>" +
        lineMoveAnalysis(entry, game) +
        histTableHtml(entry, game.startTime);
    });
  }

  // ---------- MLB team form (standings) ----------
  function getMlbForm() {
    if (mlbFormCache.map && Date.now() - mlbFormCache.t < 600000) return Promise.resolve(mlbFormCache.map);
    var season = new Date().getFullYear();
    return fetchJson("https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=" + season)
      .then(function (d) {
        var map = {};
        (d.records || []).forEach(function (r) {
          (r.teamRecords || []).forEach(function (tr) {
            var lt = ((tr.records && tr.records.splitRecords) || []).find(function (x) { return x.type === "lastTen"; });
            map[tr.team.id] = {
              streak: tr.streak ? tr.streak.streakCode : null,
              lastTen: lt ? lt.wins + "-" + lt.losses : null,
            };
          });
        });
        mlbFormCache = { t: Date.now(), map: map };
        return map;
      })
      .catch(function () { return {}; });
  }

  // ---------- MLB detail ----------
  function renderMlbDetail(game, body) {
    return fetchJson("https://statsapi.mlb.com/api/v1.1/game/" + game.gamePk + "/feed/live").then(function (f) {
      var gd = f.gameData || {};
      var ld = f.liveData || {};
      var html = detailHeaderHtml(
        game,
        recordText(gd.teams && gd.teams.away),
        recordText(gd.teams && gd.teams.home)
      );

      if (game.status === "scheduled" || game.status === "postponed") {
        return renderMlbPreview(game, gd, ld, html, body);
      }

      // line score
      var ls = ld.linescore || {};
      var innings = ls.innings || [];
      if (innings.length > 0) {
        var head = '<tr><th>隊伍</th>';
        innings.forEach(function (inn) {
          var cls = (game.status === "live" && ls.currentInning === inn.num) ? ' class="current-inning"' : "";
          head += '<th' + cls + '>' + inn.num + '</th>';
        });
        head += '<th>R</th><th>H</th><th>E</th></tr>';

        function lsRow(name, side) {
          var row = '<tr><td>' + esc(name) + '</td>';
          innings.forEach(function (inn) {
            var v = inn[side] && inn[side].runs !== undefined ? inn[side].runs : "-";
            row += '<td>' + esc(v) + '</td>';
          });
          var tot = (ls.teams && ls.teams[side]) || {};
          row += '<td><b>' + esc(tot.runs !== undefined ? tot.runs : "-") + '</b></td>' +
                 '<td>' + esc(tot.hits !== undefined ? tot.hits : "-") + '</td>' +
                 '<td>' + esc(tot.errors !== undefined ? tot.errors : "-") + '</td></tr>';
          return row;
        }
        html += sectionBlock("逐局比分",
          '<div class="table-wrap"><table class="stat-table">' + head +
          lsRow(game.away.name, "away") + lsRow(game.home.name, "home") +
          '</table></div>');
      }

      // decisions
      var dec = ld.decisions;
      if (dec && (dec.winner || dec.loser || dec.save)) {
        var parts = [];
        if (dec.winner) parts.push("勝投 <b>" + esc(dec.winner.fullName) + "</b>");
        if (dec.loser) parts.push("敗投 <b>" + esc(dec.loser.fullName) + "</b>");
        if (dec.save) parts.push("救援 <b>" + esc(dec.save.fullName) + "</b>");
        html += sectionBlock("投手勝敗", '<div class="analysis-box"><p>' + parts.join("、") + '</p></div>');
      }

      // player stats
      var box = ld.boxscore && ld.boxscore.teams;
      if (box) {
        html += mlbBattingSection(game.away.name + " 打擊", box.away);
        html += mlbPitchingSection(game.away.name + " 投手", box.away);
        html += mlbBattingSection(game.home.name + " 打擊", box.home);
        html += mlbPitchingSection(game.home.name + " 投手", box.home);
      }

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  function recordText(t) {
    var r = t && t.record && t.record.leagueRecord;
    if (!r) return "";
    return r.wins + "勝" + r.losses + "敗";
  }

  function mlbBattingSection(title, teamBox) {
    var ids = (teamBox && teamBox.batters) || [];
    if (!ids.length) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.stats || !p.stats.batting || p.stats.batting.atBats === undefined) return;
      var b = p.stats.batting;
      if ((b.atBats || 0) === 0 && (b.baseOnBalls || 0) === 0 && (b.hitByPitch || 0) === 0 && (b.sacFlies || 0) === 0) return;
      var season = (p.seasonStats && p.seasonStats.batting) || {};
      rows += '<tr><td>' + esc(p.person.fullName) + ' <span class="starter-mark">' + esc(p.position ? p.position.abbreviation : "") + '</span></td>' +
        '<td>' + (b.atBats || 0) + '</td><td>' + (b.runs || 0) + '</td><td>' + (b.hits || 0) + '</td>' +
        '<td>' + (b.rbi || 0) + '</td><td>' + (b.baseOnBalls || 0) + '</td><td>' + (b.strikeOuts || 0) + '</td>' +
        '<td>' + esc(season.avg || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return sectionBlock(title,
      '<div class="table-wrap"><table class="stat-table">' +
      '<tr><th>球員</th><th>打數</th><th>得分</th><th>安打</th><th>打點</th><th>四壞</th><th>三振</th><th>打擊率</th></tr>' +
      rows + '</table></div>');
  }

  function mlbPitchingSection(title, teamBox) {
    var ids = (teamBox && teamBox.pitchers) || [];
    if (!ids.length) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.stats || !p.stats.pitching || p.stats.pitching.inningsPitched === undefined) return;
      var s = p.stats.pitching;
      var season = (p.seasonStats && p.seasonStats.pitching) || {};
      var note = s.note ? ' <span class="starter-mark">' + esc(s.note) + '</span>' : "";
      rows += '<tr><td>' + esc(p.person.fullName) + note + '</td>' +
        '<td>' + esc(s.inningsPitched || "0") + '</td><td>' + (s.hits || 0) + '</td><td>' + (s.runs || 0) + '</td>' +
        '<td>' + (s.earnedRuns || 0) + '</td><td>' + (s.baseOnBalls || 0) + '</td><td>' + (s.strikeOuts || 0) + '</td>' +
        '<td>' + esc(season.era || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return sectionBlock(title,
      '<div class="table-wrap"><table class="stat-table">' +
      '<tr><th>球員</th><th>局數</th><th>被安打</th><th>失分</th><th>自責分</th><th>四壞</th><th>三振</th><th>ERA</th></tr>' +
      rows + '</table></div>');
  }

  function mlbLineupSection(title, teamBox) {
    var ids = (teamBox && teamBox.batters) || [];
    if (ids.length < 9) return "";
    var rows = "";
    ids.forEach(function (pid) {
      var p = teamBox.players["ID" + pid];
      if (!p || !p.battingOrder) return;
      var orderNum = Number(p.battingOrder);
      if (orderNum % 100 !== 0) return; // substitutes have non-x00 orders
      var sb = (p.seasonStats && p.seasonStats.batting) || {};
      rows += '<tr><td>' + (orderNum / 100) + '. ' + esc(p.person.fullName) +
        ' <span class="starter-mark">' + esc(p.position ? p.position.abbreviation : "") + '</span></td>' +
        '<td>' + esc(sb.avg || "-") + '</td>' +
        '<td>' + esc(sb.homeRuns !== undefined ? sb.homeRuns : "-") + '</td>' +
        '<td>' + esc(sb.ops || "-") + '</td></tr>';
    });
    if (!rows) return "";
    return '<div><div class="detail-note" style="margin:0 0 4px"><b>' + esc(title) + '</b></div>' +
      '<div class="table-wrap"><table class="stat-table" style="min-width:0">' +
      '<tr><th>先發打線</th><th>打擊率</th><th>全壘打</th><th>OPS</th></tr>' +
      rows + '</table></div></div>';
  }

  // ---------- MLB first-inning (NRFI/YRFI) data ----------
  var fiCache = {};
  function getTeamFirstInningRates(teamId) {
    if (!teamId) return Promise.resolve(null);
    var hit = fiCache[teamId];
    if (hit && Date.now() - hit.t < 600000) return Promise.resolve(hit.v);
    var end = new Date(); end.setDate(end.getDate() - 1);
    var start = new Date(); start.setDate(start.getDate() - 30);
    var url = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=" + teamId +
      "&startDate=" + toISODate(start) + "&endDate=" + toISODate(end) + "&hydrate=linescore";
    return fetchJson(url).then(function (data) {
      var games = [];
      (data.dates || []).forEach(function (d) { games = games.concat(d.games || []); });
      games = games.filter(function (g) {
        return g.status && g.status.abstractGameState === "Final" &&
          g.linescore && g.linescore.innings && g.linescore.innings[0];
      }).slice(-15);
      if (!games.length) return null;
      var off = 0, def = 0;
      games.forEach(function (g) {
        var isAway = g.teams.away.team.id === teamId;
        var inn1 = g.linescore.innings[0];
        var own = isAway ? inn1.away : inn1.home;
        var opp = isAway ? inn1.home : inn1.away;
        if (own && Number(own.runs) > 0) off++;
        if (opp && Number(opp.runs) > 0) def++;
      });
      var v = { n: games.length, off: off, def: def, offRate: off / games.length, defRate: def / games.length };
      fiCache[teamId] = { t: Date.now(), v: v };
      return v;
    }).catch(function () { return null; });
  }

  function getPitcherFirstInningSplit(pid) {
    if (!pid) return Promise.resolve(null);
    var season = new Date().getFullYear();
    return fetchJson("https://statsapi.mlb.com/api/v1/people/" + pid +
        "/stats?stats=statSplits&group=pitching&sitCodes=i01&season=" + season)
      .then(function (d) {
        var sp = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0];
        return sp ? sp.stat : null;
      })
      .catch(function () { return null; });
  }

  function renderMlbPreview(game, gd, ld, headerHtml, body) {
    var pp = gd.probablePitchers || {};
    var pitcherIds = [];
    if (pp.away) pitcherIds.push(pp.away.id);
    if (pp.home) pitcherIds.push(pp.home.id);

    var statFetches = pitcherIds.map(function (pid) {
      return fetchJson("https://statsapi.mlb.com/api/v1/people/" + pid + "?hydrate=stats(group=[pitching],type=[season])")
        .catch(function () { return null; });
    });

    var awayTeamId = gd.teams && gd.teams.away && gd.teams.away.id;
    var homeTeamId = gd.teams && gd.teams.home && gd.teams.home.id;

    return Promise.all([
      getMlbForm(),
      Promise.all(statFetches),
      getTeamFirstInningRates(awayTeamId),
      getTeamFirstInningRates(homeTeamId),
      getPitcherFirstInningSplit(pp.away && pp.away.id),
      getPitcherFirstInningSplit(pp.home && pp.home.id),
    ]).then(function (results) {
      var formMap = results[0];
      var awayFi = results[2], homeFi = results[3];
      var awayP1 = results[4], homeP1 = results[5];
      var statsById = {};
      results[1].forEach(function (r) {
        if (r && r.people && r.people[0]) {
          var person = r.people[0];
          var splits = person.stats && person.stats[0] && person.stats[0].splits;
          statsById[person.id] = (splits && splits[0] && splits[0].stat) || {};
        }
      });

      var html = headerHtml;

      // probable pitchers
      function pitcherCard(teamLabel, p) {
        if (!p) return '<div class="pitcher-card"><div class="p-team">' + esc(teamLabel) + '</div><div class="p-name">先發投手未定</div></div>';
        var st = statsById[p.id] || {};
        return '<div class="pitcher-card">' +
          '<div class="p-team">' + esc(teamLabel) + '</div>' +
          '<div class="p-name">' + esc(p.fullName) + '</div>' +
          '<div class="p-stats">' +
            '<span>戰績 <b>' + esc((st.wins !== undefined ? st.wins : "-") + "-" + (st.losses !== undefined ? st.losses : "-")) + '</b></span>' +
            '<span>ERA <b>' + esc(st.era || "-") + '</b></span>' +
            '<span>三振 <b>' + esc(st.strikeOuts !== undefined ? st.strikeOuts : "-") + '</b></span>' +
            '<span>WHIP <b>' + esc(st.whip || "-") + '</b></span>' +
            '<span>局數 <b>' + esc(st.inningsPitched || "-") + '</b></span>' +
          '</div></div>';
      }
      html += sectionBlock("預定先發投手",
        '<div class="pitcher-compare">' +
        pitcherCard(game.away.name + "(客)", pp.away) +
        pitcherCard(game.home.name + "(主)", pp.home) +
        '</div>');

      // confirmed lineups (posted ~1-3 hours before first pitch)
      var box = ld && ld.boxscore && ld.boxscore.teams;
      var awayLineup = box ? mlbLineupSection(game.away.name, box.away) : "";
      var homeLineup = box ? mlbLineupSection(game.home.name, box.home) : "";
      if (awayLineup || homeLineup) {
        html += sectionBlock("先發打線(已公布)",
          '<div class="lineup-grid">' + awayLineup + homeLineup + '</div>');
      } else {
        html += sectionBlock("先發打線",
          '<div class="analysis-box"><p>先發打線尚未公布,MLB 通常於開賽前 1–3 小時公布,屆時重新開啟本視窗即可看到。</p></div>');
      }

      // meta
      var metaItems = [];
      var dt = gd.datetime && gd.datetime.dateTime;
      if (dt) metaItems.push(["開賽時間", formatDateTime(dt)]);
      if (gd.venue && gd.venue.name) metaItems.push(["球場", gd.venue.name]);
      if (gd.weather && gd.weather.condition) {
        var w = gd.weather.condition;
        if (gd.weather.temp) {
          var c = Math.round((Number(gd.weather.temp) - 32) * 5 / 9);
          w += " " + c + "°C";
        }
        metaItems.push(["天氣", w]);
      }
      if (metaItems.length) {
        html += sectionBlock("比賽資訊",
          '<div class="meta-grid">' + metaItems.map(function (m) {
            return '<div class="meta-item"><div class="k">' + esc(m[0]) + '</div><div class="v">' + esc(m[1]) + '</div></div>';
          }).join("") + '</div>');
      }

      // analysis from records + pitcher stats + recent form
      var awayTeam = gd.teams && gd.teams.away;
      var homeTeam = gd.teams && gd.teams.home;
      var ar = awayTeam && awayTeam.record && awayTeam.record.leagueRecord;
      var hr = homeTeam && homeTeam.record && homeTeam.record.leagueRecord;
      var analysis = [];
      if (ar && hr) {
        var aPct = Number(ar.pct), hPct = Number(hr.pct);
        analysis.push("<b>" + esc(game.away.name) + "</b> 目前 " + ar.wins + " 勝 " + ar.losses + " 敗(勝率 " + ar.pct + "),<b>" +
          esc(game.home.name) + "</b> " + hr.wins + " 勝 " + hr.losses + " 敗(勝率 " + hr.pct + ")。" +
          (Math.abs(aPct - hPct) < 0.03 ? "兩隊戰績接近,實力在伯仲之間。"
            : (aPct > hPct ? "客隊整體戰績較佳。" : "主隊整體戰績較佳,加上主場優勢值得留意。")));

        var aForm = awayTeam && formMap[awayTeam.id];
        var hForm = homeTeam && formMap[homeTeam.id];
        if (aForm && hForm && aForm.lastTen && hForm.lastTen) {
          analysis.push("近況:客隊近十場 <b>" + esc(aForm.lastTen) + "</b>" + (aForm.streak ? "(" + esc(aForm.streak) + ")" : "") +
            ",主隊近十場 <b>" + esc(hForm.lastTen) + "</b>" + (hForm.streak ? "(" + esc(hForm.streak) + ")" : "") + "。");
        }

        var aSt = pp.away ? (statsById[pp.away.id] || {}) : null;
        var hSt = pp.home ? (statsById[pp.home.id] || {}) : null;
        if (aSt && hSt && aSt.era && hSt.era) {
          var aera = Number(aSt.era), hera = Number(hSt.era);
          analysis.push("先發對決:" + esc(pp.away.fullName) + "(ERA " + aSt.era + ")對上 " +
            esc(pp.home.fullName) + "(ERA " + hSt.era + ")," +
            (Math.abs(aera - hera) < 0.5 ? "兩位先發表現相近,勝負可能取決於牛棚與打線發揮。"
              : (aera < hera ? "客隊先發防禦率較佳,壓制力略勝一籌。" : "主隊先發防禦率較佳,壓制力略勝一籌。")));
        }

        var total = aPct + hPct;
        if (total > 0) {
          var awayShare = (aPct / total) * 100;
          html += sectionBlock("戰績勝率比較", probBarHtml(game.away.name, game.home.name, awayShare, 100 - awayShare));
        }
      }
      if (analysis.length) {
        html += sectionBlock("賽前分析",
          '<div class="analysis-box">' + analysis.map(function (p) { return "<p>" + p + "</p>"; }).join("") + '</div>' +
          '<div class="detail-note">分析為根據球隊戰績與投手數據之簡易推估,僅供參考。</div>');
      }

      // first-inning (NRFI/YRFI) analysis
      var nrfiProb = null;
      if (awayFi || homeFi) {
        var inner = "";
        var pA, pH;
        // blend each offense's 1st-inning scoring rate with the opponent's 1st-inning concede rate
        if (awayFi && homeFi) {
          pA = (awayFi.offRate + homeFi.defRate) / 2;
          pH = (homeFi.offRate + awayFi.defRate) / 2;
        } else if (awayFi) { pA = awayFi.offRate; pH = awayFi.defRate; }
        else { pA = homeFi.defRate; pH = homeFi.offRate; }
        var nrfi = (1 - pA) * (1 - pH) * 100;
        nrfiProb = nrfi / 100;
        inner += probBarHtml("YRFI 首局有得分", "NRFI 首局無得分", 100 - nrfi, nrfi);

        var fiRows = "";
        function fiRow(name, fi) {
          if (!fi) return "";
          return '<tr><td>' + esc(name) + '</td>' +
            '<td>' + fi.off + ' / ' + fi.n + '(' + Math.round(fi.offRate * 100) + '%)</td>' +
            '<td>' + fi.def + ' / ' + fi.n + '(' + Math.round(fi.defRate * 100) + '%)</td></tr>';
        }
        fiRows += fiRow(game.away.name, awayFi) + fiRow(game.home.name, homeFi);
        var nGames = (awayFi || homeFi).n;
        if (fiRows) {
          inner += '<div class="table-wrap" style="margin-top:10px"><table class="stat-table" style="min-width:320px">' +
            '<tr><th>近 ' + nGames + ' 場</th><th>首局有得分</th><th>首局有失分</th></tr>' + fiRows + '</table></div>';
        }

        var fiNotes = [];
        function p1Note(p, st) {
          if (!p || !st || !st.era) return;
          var seasonSt = statsById[p.id] || {};
          var line = esc(p.fullName) + " 首局 ERA <b>" + esc(st.era) + "</b>(共 " + esc(st.inningsPitched || "-") + " 局,WHIP " + esc(st.whip || "-") + ")";
          var sEra = seasonSt.era ? Number(seasonSt.era) : null;
          var fEra = Number(st.era);
          if (sEra !== null && !isNaN(fEra)) {
            var diff = fEra - sEra;
            if (diff > 0.75) line += ",明顯高於其球季 ERA " + esc(seasonSt.era) + ",開局偏不穩";
            else if (diff < -0.75) line += ",低於其球季 ERA " + esc(seasonSt.era) + ",開局表現穩健";
            else line += ",與其球季 ERA " + esc(seasonSt.era) + " 相近";
          }
          fiNotes.push("<p>" + line + "。</p>");
        }
        p1Note(pp.away, awayP1);
        p1Note(pp.home, homeP1);
        fiNotes.push('<p>綜合兩隊近況估算,本場 <b>NRFI(首局雙方皆未得分)機率約 ' + Math.round(nrfi) + '%</b>。</p>');
        inner += '<div class="analysis-box" style="margin-top:10px">' + fiNotes.join("") + '</div>' +
          '<div class="detail-note">依兩隊近 ' + nGames + ' 場首局得失分與先發投手首局分項數據之簡易估算,僅供參考。</div>';

        html += sectionBlock("首局得失分分析(NRFI / YRFI)", inner);
      }

      // American odds analysis (model vs. market implied probability)
      var oa = oddsImpliedAnalysis(game.odds);
      if (oa) {
        var oaInner = oa.tableHtml;
        var oaNotes = [oa.vigNote];

        // model home win prob: record share + last-10 share + starter ERA edge + home advantage
        var modelH = null;
        if (ar && hr) {
          var comps = [];
          var aP = Number(ar.pct), hP = Number(hr.pct);
          if (aP + hP > 0) comps.push(hP / (aP + hP));
          function l10rate(f) {
            if (!f || !f.lastTen) return null;
            var parts = f.lastTen.split("-");
            var w = Number(parts[0]), l = Number(parts[1]);
            return (w + l) > 0 ? w / (w + l) : null;
          }
          var aL10 = l10rate(aForm), hL10 = l10rate(hForm);
          if (aL10 !== null && hL10 !== null && aL10 + hL10 > 0) comps.push(hL10 / (aL10 + hL10));
          if (comps.length) {
            modelH = comps.reduce(function (x, y) { return x + y; }, 0) / comps.length;
            var aEraN = aSt && aSt.era ? Number(aSt.era) : NaN;
            var hEraN = hSt && hSt.era ? Number(hSt.era) : NaN;
            if (!isNaN(aEraN) && !isNaN(hEraN)) {
              modelH += clampNum((aEraN - hEraN) * 0.04, -0.06, 0.06);
            }
            modelH += 0.035; // home advantage
            modelH = clampNum(modelH, 0.05, 0.95);
          }
        }

        if (modelH !== null) {
          var edgeH = modelH - oa.fairH, edgeA = (1 - modelH) - oa.fairA;
          oaNotes.push("<p>模型估計:主隊勝率 <b>" + pctStr(modelH) + "</b>,市場隱含機率 " + pctStr(oa.fairH) +
            "(差距 " + (edgeH >= 0 ? "+" : "") + (edgeH * 100).toFixed(1) + "%);客隊 <b>" + pctStr(1 - modelH) +
            "</b>,市場隱含機率 " + pctStr(oa.fairA) + "(差距 " + (edgeA >= 0 ? "+" : "") + (edgeA * 100).toFixed(1) + "%)。</p>");
        }

        oaInner += '<div class="analysis-box" style="margin-top:10px">' + oaNotes.join("") + '</div>' +
          '<div class="detail-note">模型為戰績/近十場/先發投手之簡易統計推估,與市場數據比較僅供參考。</div>';
        html += sectionBlock("美式賠率分析", oaInner);
      }

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  // ---------- NBA detail ----------
  function renderNbaDetail(game, body) {
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + game.espnId).then(function (s) {
      var comp = (s.header && s.header.competitions && s.header.competitions[0]) || {};
      var competitors = comp.competitors || [];
      var homeC = competitors.find(function (c) { return c.homeAway === "home"; }) || {};
      var awayC = competitors.find(function (c) { return c.homeAway === "away"; }) || {};

      function rec(c) {
        var r = (c.record || []).find(function (x) { return x.type === "total"; }) || (c.record || [])[0];
        return r ? r.summary + "(勝-敗)" : "";
      }
      var html = detailHeaderHtml(game, rec(awayC), rec(homeC));

      if (game.status === "scheduled" || game.status === "postponed") {
        html += nbaPreviewSections(game, s, awayC, homeC);
        html += oddsDetailHtml(game);
        body.innerHTML = html;
        return;
      }

      // quarter line score
      var aLs = awayC.linescores || [];
      var hLs = homeC.linescores || [];
      var n = Math.max(aLs.length, hLs.length);
      if (n > 0) {
        var head = '<tr><th>隊伍</th>';
        for (var i = 0; i < n; i++) head += '<th>' + (i < 4 ? "Q" + (i + 1) : "OT" + (i - 3)) + '</th>';
        head += '<th>總分</th></tr>';
        function qRow(name, ls, total) {
          var row = '<tr><td>' + esc(name) + '</td>';
          for (var i = 0; i < n; i++) {
            row += '<td>' + esc(ls[i] ? ls[i].displayValue : "-") + '</td>';
          }
          row += '<td><b>' + esc(total) + '</b></td></tr>';
          return row;
        }
        html += sectionBlock("逐節比分",
          '<div class="table-wrap"><table class="stat-table">' + head +
          qRow(game.away.name, aLs, scoreText(game.away.score)) +
          qRow(game.home.name, hLs, scoreText(game.home.score)) +
          '</table></div>');
      }

      // player stats
      var teams = (s.boxscore && s.boxscore.players) || [];
      teams.forEach(function (t) {
        var stat = t.statistics && t.statistics[0];
        if (!stat || !stat.athletes) return;
        var names = stat.names || [];
        var cols = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "FG", "3PT", "+/-"];
        var colIdx = cols.map(function (c) { return names.indexOf(c); });
        var zhCols = { MIN: "分鐘", PTS: "得分", REB: "籃板", AST: "助攻", STL: "抄截", BLK: "阻攻", FG: "投籃", "3PT": "三分", "+/-": "+/-" };

        var head = '<tr><th>球員</th>' + cols.map(function (c) { return '<th>' + zhCols[c] + '</th>'; }).join("") + '</tr>';
        var rows = "";
        stat.athletes.forEach(function (a) {
          if (!a.stats || a.stats.length === 0) return;
          var starter = a.starter ? ' <span class="starter-mark">先發</span>' : "";
          rows += '<tr><td>' + esc(a.athlete.displayName) + starter + '</td>' +
            colIdx.map(function (idx) { return '<td>' + esc(idx >= 0 ? a.stats[idx] : "-") + '</td>'; }).join("") + '</tr>';
        });
        if (rows) {
          html += sectionBlock(t.team.displayName + " 球員數據",
            '<div class="table-wrap"><table class="stat-table">' + head + rows + '</table></div>');
        }
      });

      // game leaders
      var leaders = s.leaders || [];
      if (leaders.length) {
        var lRows = "";
        leaders.forEach(function (teamLeaders) {
          (teamLeaders.leaders || []).forEach(function (cat) {
            if (["points", "rebounds", "assists"].indexOf(cat.name) === -1) return;
            var top = cat.leaders && cat.leaders[0];
            if (!top) return;
            var zh = { points: "得分", rebounds: "籃板", assists: "助攻" }[cat.name];
            lRows += '<li><span>' + esc(teamLeaders.team ? teamLeaders.team.abbreviation : "") + " " + zh + ":<b>" +
              esc(top.athlete.displayName) + "</b></span><span>" + esc(top.displayValue) + "</span></li>";
          });
        });
        if (lRows) html += sectionBlock("數據領先者", '<ul class="injury-list">' + lRows + '</ul>');
      }

      html += oddsDetailHtml(game);
      body.innerHTML = html;
    });
  }

  function nbaPreviewSections(game, s, awayC, homeC) {
    var html = "";

    var pred = s.predictor;
    var aProj = pred && pred.awayTeam && parseFloat(pred.awayTeam.gameProjection);
    var hProj = pred && pred.homeTeam && parseFloat(pred.homeTeam.gameProjection);
    if (aProj && hProj) {
      html += sectionBlock("ESPN 勝率預測", probBarHtml(game.away.name, game.home.name, aProj, hProj));
    }

    var series = s.seasonseries && s.seasonseries[0];
    var analysis = [];
    if (series && series.summary) {
      analysis.push("本季對戰:<b>" + esc(series.summary) + "</b>" + (series.seriesScore ? "(" + esc(series.seriesScore) + ")" : "") + "。");
    }
    function recSummary(c) {
      var r = (c.record || []).find(function (x) { return x.type === "total"; }) || (c.record || [])[0];
      return r ? r.summary : null;
    }
    var ar = recSummary(awayC), hr = recSummary(homeC);
    if (ar && hr) {
      analysis.push("戰績:<b>" + esc(game.away.name) + "</b> " + esc(ar) + ",<b>" + esc(game.home.name) + "</b> " + esc(hr) + "。");
    }
    if (analysis.length) {
      html += sectionBlock("賽前分析", '<div class="analysis-box">' + analysis.map(function (p) { return "<p>" + p + "</p>"; }).join("") + '</div>');
    }

    if (s.article && s.article.headline) {
      var desc = s.article.description ? "<p>" + esc(s.article.description) + "</p>" : "";
      html += sectionBlock("賽事焦點(ESPN)",
        '<div class="analysis-box"><p><b>' + esc(s.article.headline) + '</b></p>' + desc + '</div>');
    }

    var injuries = s.injuries || [];
    var iRows = "";
    injuries.forEach(function (teamInj) {
      (teamInj.injuries || []).forEach(function (inj) {
        iRows += '<li><span>' + esc(teamInj.team ? teamInj.team.abbreviation : "") + " " +
          esc(inj.athlete ? inj.athlete.displayName : "") + '</span><span class="injury-status">' + esc(inj.status || "") + '</span></li>';
      });
    });
    if (iRows) html += sectionBlock("傷兵名單", '<ul class="injury-list">' + iRows + '</ul>');

    // American odds analysis (model = ESPN predictor when available)
    var oa = oddsImpliedAnalysis(game.odds);
    if (oa) {
      var oaInner = oa.tableHtml;
      var oaNotes = [oa.vigNote];
      if (aProj && hProj && aProj + hProj > 0) {
        var modelH = hProj / (aProj + hProj);
        var edgeH = modelH - oa.fairH, edgeA = (1 - modelH) - oa.fairA;
        oaNotes.push("<p>ESPN 預測:主隊勝率 <b>" + pctStr(modelH) + "</b>,市場隱含機率 " + pctStr(oa.fairH) +
          "(差距 " + (edgeH >= 0 ? "+" : "") + (edgeH * 100).toFixed(1) + "%);客隊 <b>" + pctStr(1 - modelH) +
          "</b>,市場隱含機率 " + pctStr(oa.fairA) + "(差距 " + (edgeA >= 0 ? "+" : "") + (edgeA * 100).toFixed(1) + "%)。</p>");
        if (edgeH >= edgeA && edgeH > 0.02) {
          oaNotes.push("<p>模型預測:<b>" + esc(game.home.name) + "</b> 勝率 " + pctStr(modelH) + ",高於市場隱含機率 " + pctStr(oa.fairH) + "。</p>");
        } else if (edgeA > edgeH && edgeA > 0.02) {
          oaNotes.push("<p>模型預測:<b>" + esc(game.away.name) + "</b> 勝率 " + pctStr(1 - modelH) + ",高於市場隱含機率 " + pctStr(oa.fairA) + "。</p>");
        } else {
          oaNotes.push("<p>模型預測與市場隱含機率接近,無明顯落差。</p>");
        }
      }
      oaInner += '<div class="analysis-box" style="margin-top:10px">' + oaNotes.join("") + '</div>' +
        '<div class="detail-note">以 ESPN 勝率預測與市場隱含機率比較,僅供參考。</div>';
      html += sectionBlock("美式賠率分析", oaInner);
    }

    if (!html) {
      html = sectionBlock("賽前資訊", '<div class="analysis-box"><p>暫無更多賽前資料,開賽後將顯示逐節比分與球員數據。</p></div>');
    }
    return html;
  }

  // ---------- NPB / KBO detail ----------
  function parseTsdbInnings(str) {
    if (!str) return null;
    var blocks = String(str).split(/<br\s*\/?>\s*<br\s*\/?>/i);
    var out = [];
    blocks.forEach(function (b) {
      var m = b.match(/^\s*(.*?)\s+Innings:\s*<br\s*\/?>\s*([\d\s]+?)\s*(?:<br\s*\/?>\s*Hits:\s*(\d+)\s*-\s*Errors:\s*(\d+))?\s*$/i);
      if (m && m[2].trim()) {
        out.push({
          name: m[1].trim(),
          innings: m[2].trim().split(/\s+/).map(Number),
          hits: m[3] !== undefined ? Number(m[3]) : null,
          errors: m[4] !== undefined ? Number(m[4]) : null,
        });
      }
    });
    return out.length >= 2 ? out : null;
  }

  function renderTsdbDetail(game, body) {
    return fetchJson("https://www.thesportsdb.com/api/v1/json/123/lookupevent.php?id=" + game.tsdbId)
      .catch(function () { return null; })
      .then(function (data) {
        var e = (data && data.events && data.events[0]) || game.raw || {};
        var html = detailHeaderHtml(game, null, null);

        var parsed = parseTsdbInnings(e.strResult);
        if (parsed) {
          var awayBlock = parsed.find(function (p) { return p.name === game.away.name; });
          var homeBlock = parsed.find(function (p) { return p.name === game.home.name; });
          if (!awayBlock || !homeBlock) { homeBlock = parsed[0]; awayBlock = parsed[1]; }

          var n = Math.max(awayBlock.innings.length, homeBlock.innings.length);
          var head = '<tr><th>隊伍</th>';
          for (var i = 1; i <= n; i++) head += '<th>' + i + '</th>';
          head += '<th>R</th><th>H</th><th>E</th></tr>';

          function iRow(name, blk, total) {
            var row = '<tr><td>' + esc(name) + '</td>';
            for (var i = 0; i < n; i++) {
              row += '<td>' + (blk.innings[i] !== undefined ? blk.innings[i] : "-") + '</td>';
            }
            var runs = total !== null && total !== undefined ? total : blk.innings.reduce(function (a, b) { return a + b; }, 0);
            row += '<td><b>' + esc(runs) + '</b></td>' +
              '<td>' + esc(blk.hits !== null ? blk.hits : "-") + '</td>' +
              '<td>' + esc(blk.errors !== null ? blk.errors : "-") + '</td></tr>';
            return row;
          }
          html += sectionBlock("逐局比分",
            '<div class="table-wrap"><table class="stat-table">' + head +
            iRow(game.away.name, awayBlock, game.away.score) +
            iRow(game.home.name, homeBlock, game.home.score) +
            '</table></div>');
        } else if (game.status !== "scheduled") {
          html += sectionBlock("逐局比分",
            '<div class="analysis-box"><p>逐局比分尚未提供,通常於比賽結束後更新。</p></div>');
        }

        var metaItems = [];
        if (game.startTime) metaItems.push(["開賽時間(台北)", formatDateTime(game.startTime)]);
        if (e.strVenue) metaItems.push(["球場", e.strVenue]);
        if (e.strCity) metaItems.push(["城市", e.strCity]);
        if (e.intRound && e.intRound !== "0") metaItems.push(["輪次", e.intRound]);
        if (e.strSeason) metaItems.push(["球季", e.strSeason]);
        if (metaItems.length) {
          html += sectionBlock("比賽資訊",
            '<div class="meta-grid">' + metaItems.map(function (m) {
              return '<div class="meta-item"><div class="k">' + esc(m[0]) + '</div><div class="v">' + esc(m[1]) + '</div></div>';
            }).join("") + '</div>');
        }

        if (game.status === "scheduled") {
          html += sectionBlock("賽前資訊",
            '<div class="analysis-box"><p>此聯盟的免費資料來源未提供先發名單、球員數據與賠率;開賽後可在此查看逐局比分。</p></div>');
        } else {
          html += '<div class="detail-note">此聯盟的資料來源未提供球員個人數據。</div>';
        }

        body.innerHTML = html;
      });
  }

  // ---------- modal control ----------
  var DETAIL_RENDERERS = { mlb: renderMlbDetail, nba: renderNbaDetail, npb: renderTsdbDetail, kbo: renderTsdbDetail };

  function loadDetail(game) {
    var body = document.getElementById("modalBody");
    return DETAIL_RENDERERS[game.league](game, body).then(function () {
      hydrateOddsHistory(game);
    }).catch(function (err) {
      body.innerHTML = detailHeaderHtml(game, null, null) +
        '<div class="error-state">詳細資料載入失敗:' + esc(err.message || err) +
        '<br><button onclick="window.__scoreApp.reloadDetail()">重試</button></div>';
    });
  }

  function openDetail(game) {
    modal.game = game;
    modal.betlog = false;
    var m = document.getElementById("modal");
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.getElementById("modalBody").innerHTML =
      detailHeaderHtml(game, null, null) +
      '<div class="detail-loading"><div class="spinner"></div>載入詳細資料中…</div>';
    loadDetail(game);

    if (modal.timer) clearInterval(modal.timer);
    if (game.status === "live") {
      modal.timer = setInterval(function () {
        if (!document.hidden && modal.game) loadDetail(modal.game);
      }, 15000);
    }
  }

  function closeDetail() {
    modal.game = null;
    modal.betlog = false;
    if (modal.timer) { clearInterval(modal.timer); modal.timer = null; }
    var m = document.getElementById("modal");
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ---------- controls ----------
  function loadAndReschedule() {
    return loadAll().then(scheduleNext);
  }

  function setFilter(key) {
    state.filter = key;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.league === key);
    });
    loadAndReschedule();
  }

  function clearGames() {
    LEAGUE_ORDER.forEach(function (k) {
      state.gamesByLeague[k] = [];
      state.errorByLeague[k] = null;
    });
  }

  function shiftDate(days) {
    var d = new Date(state.date);
    d.setDate(d.getDate() + days);
    state.date = d;
    clearGames();
    loadAndReschedule();
  }

  function goToday() {
    state.date = new Date();
    clearGames();
    loadAndReschedule();
  }

  function retryLeague(key) {
    state.errorByLeague[key] = null;
    render();
    loadLeague(key).then(function () { render(); });
  }

  function setNotifyButton() {
    var btn = document.getElementById("notifBtn");
    btn.textContent = state.notify ? "🔔" : "🔕";
    btn.title = state.notify ? "比分變動通知:開啟(點擊關閉)" : "比分變動通知:關閉(點擊開啟)";
  }

  function init() {
    cleanupOddsLogs();

    document.getElementById("leagueTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab");
      if (btn) setFilter(btn.dataset.league);
    });
    document.getElementById("prevDay").addEventListener("click", function () { shiftDate(-1); });
    document.getElementById("nextDay").addEventListener("click", function () { shiftDate(1); });
    document.getElementById("dateLabel").addEventListener("click", goToday);
    document.getElementById("refreshBtn").addEventListener("click", function (e) {
      e.currentTarget.classList.add("spinning");
      loadAndReschedule().then(function () {
        var b = document.getElementById("refreshBtn");
        if (b) b.classList.remove("spinning");
      });
    });
    document.getElementById("autoRefreshToggle").addEventListener("change", function (e) {
      state.autoRefresh = e.target.checked;
      scheduleNext();
    });
    document.getElementById("notifBtn").addEventListener("click", function () {
      if (state.notify) {
        state.notify = false;
        store.set("notif", "0");
        setNotifyButton();
        return;
      }
      if (typeof Notification === "undefined") return;
      Notification.requestPermission().then(function (p) {
        state.notify = p === "granted";
        store.set("notif", state.notify ? "1" : "0");
        setNotifyButton();
      });
    });
    document.getElementById("themeBtn").addEventListener("click", function () {
      var root = document.documentElement;
      var current = root.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store.set("scoreapp-theme", next);
      document.getElementById("themeBtn").textContent = next === "dark" ? "🌙" : "☀️";
    });

    // card click: pin toggle or open detail
    document.getElementById("content").addEventListener("click", function (e) {
      var pin = e.target.closest(".pin-btn");
      if (pin) {
        togglePin(pin.dataset.pin);
        LEAGUE_ORDER.forEach(function (k) {
          state.gamesByLeague[k].sort(function (a, b) {
            var pa = pinSet.has(a.id) ? 0 : 1, pb = pinSet.has(b.id) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            var order = { live: 0, scheduled: 1, final: 2, postponed: 3 };
            if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
            return new Date(a.startTime) - new Date(b.startTime);
          });
        });
        render();
        return;
      }
      var card = e.target.closest(".game-card.clickable");
      if (!card) return;
      var game = findGame(card.dataset.gid);
      if (game) openDetail(game);
    });
    document.getElementById("modalClose").addEventListener("click", closeDetail);
    document.getElementById("modalBackdrop").addEventListener("click", closeDetail);

    // bet log: header button + delegated actions inside the modal
    document.getElementById("betlogBtn").addEventListener("click", openBetLog);
    document.getElementById("modalBody").addEventListener("click", function (e) {
      var rec = e.target.closest(".bet-rec");
      if (rec && modal.game) {
        var pick = recordBet(modal.game, rec.dataset.market, rec.dataset.side);
        if (pick) {
          rec.classList.add("done");
          rec.disabled = true;
          rec.textContent = "✓ 已記錄";
        }
        return;
      }
      var del = e.target.closest(".bet-del");
      if (del) { deleteBet(del.dataset.id); return; }
      if (e.target.id === "kellyCalcBtn") { runKelly(); return; }
      if (e.target.id === "betExportBtn") { exportBetsCsv(); return; }
      if (e.target.id === "betClearBtn") { clearBets(); return; }
    });
    document.getElementById("modalBody").addEventListener("change", function (e) {
      var inp = e.target.closest(".bet-stake");
      if (inp) setBetStake(inp.dataset.id, inp.value);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.game) closeDetail();
    });

    // resume immediately when tab becomes visible again
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.autoRefresh && sched.nextAt && Date.now() > sched.nextAt) {
        loadAndReschedule();
      }
    });

    var savedTheme = store.get("scoreapp-theme");
    if (savedTheme) {
      document.documentElement.setAttribute("data-theme", savedTheme);
      document.getElementById("themeBtn").textContent = savedTheme === "dark" ? "🌙" : "☀️";
    }
    state.notify = store.get("notif") === "1" && canNotify();
    setNotifyButton();

    window.__scoreApp = {
      retryLeague: retryLeague,
      reloadDetail: function () { if (modal.game) openDetail(modal.game); },
    };

    // instant paint from last snapshot, then refresh
    if (restoreSnapshot()) render();
    loadAndReschedule();
    setInterval(updateStatusText, 1000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
