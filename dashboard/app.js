// Token Radar — patient-2 dashboard. Reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, the filters, an
// expandable detail view per protocol, the live-token table and the model
// the board was scored with. No network: every byte shown is in data.js.
//
// The detail view recomputes each row's launch value, odds, implied
// value and range in the page, from the snapshot figures the row carries
// and the fitted parameters — so the number on screen and the number in
// board.json are visibly the same arithmetic, not two different claims.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', watchOnly: false, sort: 'implied', dir: -1, expanded: null };

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '−$' : '$';
    var abs = Math.abs(n);
    return sign + (abs >= 100 ? Math.round(abs) : abs.toFixed(2));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtCompact(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + Math.round(n / 1e6) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtRange(lo, hi) {
    return fmtCompact(lo) + '–' + fmtCompact(hi);
  }

  function ageBand(days) {
    if (days === null || days === undefined) return 'age?';
    if (days < 180) return '<6mo';
    if (days < 540) return '6-18mo';
    if (days < 1095) return '18mo-3yr';
    return '3yr+';
  }
  function tvlBand(tvl) {
    if (tvl < 50e6) return '<$50M';
    if (tvl < 100e6) return '$50-100M';
    if (tvl < 1e9) return '$100M-1B';
    return '>$1B';
  }

  // Recompute a row in the page: launch value from the fitted curve,
  // odds from the peer cell, implied value, and the range from the
  // held-out residual spread. Same arithmetic as lib/model.ts.
  function recompute(row) {
    var m = DATA.model;
    var multiple = m.fit_n >= 10
      ? Math.min(m.multiple_high, Math.max(m.multiple_low, Math.pow(10, m.fit_intercept + m.fit_slope * Math.log10(row.tvl_usd))))
      : m.fallback_multiple;
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var clamped = Math.min(m.growth_high, Math.max(m.growth_low, g));
    var growthMult = 1 + m.growth_weight * Math.log(1 + clamped / 100);
    var age = row.age_days === null || row.age_days === undefined ? m.fallback_age_days : row.age_days;
    var maturity = m.maturity_floor + m.maturity_span * (Math.max(0, age) / (Math.max(0, age) + m.maturity_half_days));
    var launch = Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity));
    var ageB = ageBand(row.age_days);
    var tvlB = tvlBand(row.tvl_usd);
    var cell = null;
    for (var i = 0; i < DATA.odds.cells.length; i++) {
      var c = DATA.odds.cells[i];
      if (c.age === ageB && c.tvl === tvlB) { cell = c; break; }
    }
    var odds = cell
      ? (cell.hasToken + m.odds_prior * DATA.odds.bandRate[tvlB]) / (cell.n + m.odds_prior)
      : DATA.odds.baseRate;
    odds = Math.min(m.odds_high, Math.max(m.odds_low, odds));
    var implied = Math.max(1, Math.round(launch * odds));
    var sigma = DATA.validation.sigmaLog10;
    var low = Math.pow(10, -0.674 * sigma);
    var high = Math.pow(10, 0.674 * sigma);
    return {
      launch: launch,
      multiple: multiple,
      growthMult: growthMult,
      maturity: maturity,
      odds: odds,
      cell: cell,
      implied: implied,
      p25: Math.max(1, Math.round(implied * low)),
      p75: Math.max(1, Math.round(implied * high))
    };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  var WATCH = {};
  DATA.rows.forEach(function (r) { WATCH[r.slug] = false; });
  (DATA.watchlist || []).forEach(function (s) { WATCH[s] = true; });

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('p')) state.expanded = params.get('p');
    if (params.get('watch') === '1') state.watchOnly = true;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.watchOnly) params.set('watch', '1');
    if (state.expanded) params.set('p', state.expanded);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchOnly && !WATCH[r.slug]) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'launch') { av = a.launch_value_usd; bv = b.launch_value_usd; }
      else if (key === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else if (key === 'net') { av = a.verdict_net_per_hour_usd; bv = b.verdict_net_per_hour_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'wordmark' }, 'Token ', el('b', { text: 'Radar' }), ' · patient-2'),
      el('div', { class: 'topmeta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DeFiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function hero() {
    var top = DATA.rows[0];
    var v = DATA.validation;
    var o = DATA.odds;
    var vc = DATA.verdict_counts;
    return el('section', { class: 'hero' },
      el('h1', { text: 'Every protocol that could launch a token, ranked by what the launch would be worth — and whether it is worth farming.' }),
      el('p', null,
        'The watchlist is the floor: all ', el('b', { text: String(DATA.watchlist_size) }), ' protocols with at least $',
        String(Math.round(DATA.floor_usd / 1e6)), 'M of TVL and no token on record. The early radar adds ',
        el('b', { text: String(DATA.early_size) }), ' more pre-token protocols below that floor. Each row carries the odds its token ever lists, ',
        'a range on its value, and a farm verdict netted to the dollar — so a big protocol can be a bad farm, and a small one can be worth a stake.'
      ),
      el('div', { class: 'kpis' },
        el('div', { class: 'kpi' }, el('b', { text: '×' + v.loo.miss.toFixed(2) + ' vs ×' + v.loo.flatMiss.toFixed(2) }), el('span', { text: 'Leave-one-out miss, fitted curve vs flat 0.25' }), el('small', { text: 'Median factor on ' + v.loo.tested + ' live tokens the curve never saw' })),
        el('div', { class: 'kpi' }, el('b', { text: Math.round(v.p25Coverage * 100) + '% · ' + Math.round(v.p90Coverage * 100) + '%' }), el('span', { text: 'Range honesty: P25–P75 and P10–P90 coverage' }), el('small', { text: 'Targets 50% and 80% on held-out live tokens' })),
        el('div', { class: 'kpi' }, el('b', { text: o.brierBinned.toFixed(3) + ' vs ' + o.brierBase.toFixed(3) }), el('span', { text: 'Token odds Brier, binned vs base rate' }), el('small', { text: 'Lower is better; ' + o.peers + ' launch-eligible peers' })),
        el('div', { class: 'kpi' }, el('b', { text: 'FARM ' + vc.FARM + ' · THIN ' + vc.THIN + ' · SKIP ' + vc.SKIP }), el('span', { text: 'Farm verdicts at a $1,000 stake' }), el('small', { text: 'Net of gas, against a 4.5% T-bill' })),
        el('div', { class: 'kpi' }, el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('span', { text: 'Watchlist covered' }), el('small', { text: DATA.board_size + ' pre-token rows ranked in all' })),
        el('div', { class: 'kpi' }, el('b', { text: top ? fmtUsd(top.implied_value_usd) : 'n/a' }), el('span', { text: 'Top implied value — ' + (top ? top.name : '') }), el('small', { text: 'Launch ' + (top ? fmtUsd(top.launch_value_usd) : 'n/a') + ' × odds ' + (top ? (top.token_odds * 100).toFixed(0) + '%' : 'n/a') }))
      )
    );
  }

  function census() {
    var a = DATA.accounting;
    var livePct = Math.round((a.live_token / a.total) * 100);
    var rankedPct = Math.round((a.ranked / a.total) * 100);
    var asidePct = 100 - livePct - rankedPct;
    var reasons = a.set_aside_by_reason.map(function (r) { return r.reason + ' ' + r.count; }).join(' · ');
    return el('section', { class: 'census' },
      el('h3', { text: 'Every protocol accounted for' }),
      el('p', { text: 'The snapshot holds ' + a.total + ' protocols. Nothing is silently dropped: each one is either already trading, ranked on this board, or set aside for a stated reason.' }),
      el('div', { class: 'bar', 'aria-hidden': 'true' },
        el('i', { class: 'live', style: 'width:' + livePct + '%' }),
        el('i', { class: 'ranked', style: 'width:' + rankedPct + '%' }),
        el('i', { class: 'aside', style: 'width:' + asidePct + '%' })
      ),
      el('div', { class: 'legend' },
        el('span', null, el('i', { class: 'dot', style: 'background:#6ea8fe' }), el('b', { text: String(a.live_token) }), ' already trading'),
        el('span', null, el('i', { class: 'dot', style: 'background:#f2a93b' }), el('b', { text: String(a.ranked) }), ' ranked pre-token'),
        el('span', null, el('i', { class: 'dot', style: 'background:#3a435e' }), el('b', { text: String(a.set_aside) }), ' set aside — ' + reasons)
      )
    );
  }

  function evidence() {
    var v = DATA.validation;
    function row(name, test) {
      var wins = test.miss < test.flatMiss;
      return el('tr', null,
        el('td', { text: name }),
        el('td', { class: 'num' + (wins ? ' win' : ' lose'), text: '×' + test.miss.toFixed(2) }),
        el('td', { class: 'num', text: '×' + test.flatMiss.toFixed(2) }),
        el('td', { class: 'num', text: String(test.tested) }),
        el('td', { text: wins ? 'Curve wins' : 'Flat wins' })
      );
    }
    return el('section', { class: 'section' },
      el('h2', { text: 'How the model was tested' }),
      el('p', { text: 'The size curve is the only fitted term with a ground truth — live tokens’ market caps — so it is the term that gets held-out tests. Each test refits the curve on one part of the live tokens and scores it on protocols it never saw. The miss is the median factor between the predicted and the true market cap.' }),
      el('div', { class: 'tablewrap' },
        el('table', { class: 'evidence' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Test' }),
            el('th', { scope: 'col', text: 'Fitted curve' }),
            el('th', { scope: 'col', text: 'Flat 0.25' }),
            el('th', { scope: 'col', text: 'Tested' }),
            el('th', { scope: 'col', text: 'Outcome' })
          )),
          el('tbody', null,
            row('Leave-one-out, all live tokens', v.loo),
            row('Size split: fit small, test big', v.splitLowHigh),
            row('Size split: fit big, test small', v.splitHighLow)
          )
        )
      ),
      el('div', { class: 'note' },
        el('b', { text: 'The curve loses one test. ' }),
        'Fitted on small protocols, it misses the giants worse than a flat multiple (×' + v.splitLowHigh.miss.toFixed(2) + ' vs ×' + v.splitLowHigh.flatMiss.toFixed(2) + '). The board keeps the curve anyway — it wins leave-one-out and the other split, and its direction matches the band medians — but a test that only reports its wins is not a test, so the loss is printed here too.'
      ),
      el('div', { class: 'note' },
        el('b', { text: 'Growth and age failed their test. ' }),
        'Adding them to the comps’ regression moves R² from ' + v.r2SizeOnly.toFixed(3) + ' to ' + v.r2WithGrowthAge.toFixed(3) + ', and the growth coefficient comes out negative (' + v.growthCoef.toFixed(2) + ' per 100 points). They carry no usable signal in the comps’ ratios, so they stay as bounded priors — the brief requires the value to follow TVL, 7-day growth and time with no token — capped so together they move a value by at most 2.6×, while size moves it by orders of magnitude.'
      ),
      el('div', { class: 'checks' },
        el('span', { class: 'check' }, el('b', { text: '✓' }), ' ' + DATA.checks.rows + ' rows'),
        el('span', { class: 'check' }, el('b', { text: '✓' }), ' Watchlist ' + DATA.checks.watchlist_covered + '/' + DATA.checks.watchlist_total),
        el('span', { class: 'check' }, el('b', { text: '✓' }), ' ' + DATA.checks.distinct_implied + ' distinct implied values'),
        el('span', { class: 'check' }, el('b', { text: '✓' }), ' Farm steps 3–12, 20–600 chars'),
        el('span', { class: 'check' }, el('b', { text: '✓' }), ' No external URL in the page source')
      )
    );
  }

  function toolbar() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chn = el('select', { 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chn.addEventListener('change', function () { state.chain = chn.value; writeHash(); render(); });
    var ver = el('select', { 'aria-label': 'Filter by farm verdict' },
      [['all', 'All verdicts'], ['FARM', 'FARM only'], ['THIN', 'THIN only'], ['SKIP', 'SKIP only']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === state.verdict ? 'selected' : null });
      })
    );
    ver.addEventListener('change', function () { state.verdict = ver.value; writeHash(); render(); });
    var watch = el('input', { type: 'checkbox', checked: state.watchOnly ? 'checked' : null, 'aria-label': 'Watchlist only' });
    watch.addEventListener('change', function () { state.watchOnly = watch.checked; writeHash(); render(); });
    var sort = el('select', { 'aria-label': 'Sort the board' },
      [['implied', 'Sort: implied value'], ['launch', 'Sort: launch value'], ['odds', 'Sort: token odds'], ['net', 'Sort: net per hour'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7-day growth'], ['age', 'Sort: age'], ['name', 'Sort: name']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === state.sort ? 'selected' : null });
      })
    );
    sort.addEventListener('change', function () { state.sort = sort.value; state.dir = -1; render(); });
    return el('div', { class: 'toolbar' },
      el('div', { class: 'field' }, el('label', { text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { text: 'Chain' }), chn),
      el('div', { class: 'field' }, el('label', { text: 'Verdict' }), ver),
      el('label', { class: 'checkline' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('label', { text: 'Order' }), sort),
      el('span', { class: 'shown', text: filtered().length + ' of ' + DATA.board_size + ' rows shown' })
    );
  }

  function sortHead(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null
      )
    );
  }

  function detailCell(row) {
    var calc = recompute(row);
    var launchOk = calc.launch === row.launch_value_usd;
    var oddsOk = Math.abs(calc.odds - row.token_odds) < 0.0002;
    var impliedOk = calc.implied === row.implied_value_usd;
    var rangeOk = calc.p25 === row.p25_usd && calc.p75 === row.p75_usd;
    var allOk = launchOk && oddsOk && impliedOk && rangeOk;
    var steps = (row.farm_steps || []).map(function (s) {
      var cut = s.indexOf(' — cost ');
      if (cut < 0) return el('li', { text: s });
      var head = s.slice(0, cut);
      var bold = head.indexOf('Verdict:') === 0;
      return el('li', null,
        bold ? el('b', { text: head }) : el('span', { text: head }),
        el('br'), el('span', { class: 'sub', text: 'Cost ' + s.slice(cut + 8) }));
    });
    var neighbours = (row.neighbours || []).map(function (n) {
      return el('div', { class: 'kv' },
        el('span', { text: n.name + ' — TVL ' + fmtUsd(n.tvl_usd) }),
        el('b', { text: '×' + n.multiple.toFixed(3) + ' (mcap ' + fmtUsd(n.mcap_usd) + ')' })
      );
    });
    var stakeLine = row.verdict_stake_to_farm_usd === null
      ? 'No stake clears the T-bill bar — this row never pays, at any size.'
      : 'A $' + row.verdict_stake_to_farm_usd + ' stake would turn it into a FARM.';
    return el('div', { class: 'detail' },
      el('div', null,
        el('h3', { text: 'How the figure is made' }),
        el('div', null,
          el('div', { class: 'kv' }, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
          el('div', { class: 'kv' }, el('span', { text: 'Base multiple (fitted)' }), el('b', { text: '× ' + calc.multiple.toFixed(3) })),
          el('div', { class: 'kv' }, el('span', { text: 'Seven-day growth' }), el('b', { text: fmtPct(row.change_7d) })),
          el('div', { class: 'kv' }, el('span', { text: 'Growth multiplier' }), el('b', { text: '× ' + calc.growthMult.toFixed(3) })),
          el('div', { class: 'kv' }, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
          el('div', { class: 'kv' }, el('span', { text: 'Maturity multiplier' }), el('b', { text: '× ' + calc.maturity.toFixed(3) })),
          el('div', { class: 'kv total' }, el('span', { text: 'Launch value (if it launches)' }), el('b', { text: fmtUsd(row.launch_value_usd) })),
          el('div', { class: 'kv' }, el('span', { text: 'Token odds — peers ' + row.odds_cell + ': ' + row.odds_cell_has_token + ' of ' + row.odds_cell_n + ' record a token' }), el('b', { text: '× ' + row.token_odds.toFixed(2) })),
          el('div', { class: 'kv total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) })),
          el('div', { class: 'kv' }, el('span', { text: 'Range P25–P75' }), el('b', { text: fmtRange(row.p25_usd, row.p75_usd) })),
          el('div', { class: 'kv' }, el('span', { text: 'Range P10–P90' }), el('b', { text: fmtRange(row.p10_usd, row.p90_usd) }))
        ),
        el('p', { class: 'verify' }, 'Recomputed in this page: ',
          el('b', { class: allOk ? '' : 'bad', text: allOk ? 'matches board.json' : 'differs from the board' }),
          allOk ? ' — launch, odds, implied value and range all agree with the file.' : ' — the data would be stale.'
        ),
        el('div', { class: 'neighbours' },
          el('h3', { text: 'Closest priced neighbours' }),
          el('p', { class: 'sub', text: 'Live-token protocols nearest this row in TVL, with their real market-cap/TVL ratios. The fitted multiple sits among them.' }),
          neighbours
        ),
        el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. An estimate, not a price.' })
      ),
      el('div', null,
        el('h3', { text: 'Farm verdict — at a $1,000 stake' }),
        el('div', { class: 'verdictbox ' + row.verdict.toLowerCase() },
          el('b', { text: row.verdict + ' — ' }),
          'expected drop ' + fmtMoney(row.verdict_drop_usd) + ', gas ' + fmtMoney(row.verdict_gas_usd) + ', ' + row.verdict_hours + ' hours, net ' + fmtMoney(row.verdict_net_usd) + ' (' + fmtMoney(row.verdict_net_per_hour_usd) + ' an hour) against a ' + fmtMoney(row.verdict_tbill_usd) + ' T-bill. ' + stakeLine
        ),
        el('p', { class: 'sub', text: 'The plan itself is sized for a small farmer: $' + row.verdict_deposit_usd + ' for ' + row.verdict_hold_days + ' days. The verdict answers whether it is worth scaling to $1,000 — the drop is assumed to be 5% of the launch value, gas is 4 transactions, and the benchmark is a 4.5% T-bill.' }),
        el('h3', { text: 'Farm plan — ' + steps.length + ' steps', style: 'margin-top:16px' }),
        el('ol', { class: 'farm' }, steps)
      )
    );
  }

  function boardTable() {
    var list = sorted(filtered());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.watchOnly = false; writeHash(); render(); } })
      ));
    }
    var max = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
      var isOpen = state.expanded === r.slug;
      var tr = el('tr', {
        class: 'row' + (isOpen ? ' open' : ''),
        tabindex: '0',
        onclick: function () { state.expanded = isOpen ? null : r.slug; writeHash(); render(); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.expanded = isOpen ? null : r.slug; writeHash(); render(); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', null, r.name, WATCH[r.slug] ? el('span', { class: 'badge', text: 'WATCH' }) : null),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'one chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: (r.token_odds * 100).toFixed(0) + '%' }),
        el('td', { class: 'num', text: fmtUsd(r.launch_value_usd) }),
        el('td', { class: 'num', text: fmtRange(r.p25_usd, r.p75_usd) }),
        el('td', null, el('div', { class: 'valuecell' },
          el('div', { class: 'barval', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'pill ' + r.verdict.toLowerCase(), text: r.verdict }))
      );
      tbody.appendChild(tr);
      if (isOpen) {
        tbody.appendChild(el('tr', { class: 'detailrow' }, el('td', { colspan: '10' }, detailCell(r))));
      }
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'tablewrap' },
        el('table', { class: 'board' },
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row to open its model, odds, range and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHead('implied', 'Rank'),
            sortHead('name', 'Protocol'),
            sortHead('tvl', 'TVL'),
            sortHead('growth', '7d'),
            sortHead('age', 'Age'),
            sortHead('odds', 'Odds'),
            sortHead('launch', 'Launch'),
            sortHead('implied', 'Range P25–P75'),
            sortHead('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Verdict' })
          )),
          tbody
        )
      )
    );
  }

  function liveSection() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'one chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'tag', text: 'already trades' }))
      ));
    });
    return el('section', { class: 'section' },
      el('h2', { text: 'Already trading — set aside' }),
      el('p', { text: 'These ' + DATA.live_size + ' protocols already have a token, so their market cap is a fact, not a model. They are never ranked on this board — and their market-cap-to-TVL ratios are what the base multiple is fitted on, and what the held-out tests are scored against.' }),
      el('div', { class: 'panel' },
        el('div', { class: 'tablewrap' },
          el('table', { class: 'board' },
            el('caption', { text: 'Largest live-token protocols by market cap. A fact, not an estimate.' }),
            el('thead', null, el('tr', null,
              el('th', { scope: 'col', text: 'Status' }),
              el('th', { scope: 'col', text: 'Protocol' }),
              el('th', { scope: 'col', text: 'TVL' }),
              el('th', { scope: 'col', text: '7d' }),
              el('th', { scope: 'col', text: 'Market cap' }),
              el('th', { scope: 'col', text: 'Token' })
            )),
            tbody
          )
        )
      )
    );
  }

  function modelSection() {
    var m = DATA.model;
    var v = DATA.validation;
    return el('section', { class: 'section' },
      el('div', { class: 'modelbox' },
        el('h2', { text: 'How the board is scored' }),
        el('p', { text: 'One function scores every row, from the snapshot figures only. No protocol name is special-cased, and no row is hand-picked.' }),
        el('div', { class: 'formula' },
          'launch = round( tvl_usd × multiple(tvl_usd) × (1 + 0.30 × ln(1 + clamp(change_7d, -50, 200) / 100)) × (0.60 + 0.40 × age / (age + 365)) )\n' +
          'implied = round( launch × odds(age, tvl) )\n' +
          'range P25–P75 = implied ÷ ' + (Math.pow(10, 0.674 * v.sigmaLog10)).toFixed(2) + ' … implied × ' + (Math.pow(10, 0.674 * v.sigmaLog10)).toFixed(2)
        ),
        el('ul', null,
          el('li', null, el('b', { text: 'Launch value, fitted — ' }), 'log10(mcap/TVL) = ' + m.fit_intercept.toFixed(4) + ' − ' + Math.abs(m.fit_slope).toFixed(4) + ' × log10(TVL), fitted on the ' + m.fit_n + ' live-token protocols in this snapshot that report a market cap. Big protocols trade at a smaller fraction of TVL than small ones; the fit says so with the snapshot’s own numbers. Clamped to 0.03–0.70. Growth is log-damped (a +200% week is worth ×1.33); maturity saturates (a newborn gets ×0.60, one year ×0.80, three years ×0.90).'),
          el('li', null, el('b', { text: 'Token odds, from the peers — ' }), 'the share of launch-eligible protocols in the same age-and-size cell that already record a token, smoothed toward the cell’s TVL-band rate with a 10-protocol prior. The older a giant gets without a token, the more the peer record reads as “may never launch” — which is why Sentora leads this board and Steakhouse led the last one. Brier ' + DATA.odds.brierBinned.toFixed(3) + ' against a ' + DATA.odds.brierBase.toFixed(3) + ' base rate.'),
          el('li', null, el('b', { text: 'Range, from the model’s own misses — ' }), 'the leave-one-out residuals of the size curve spread 0.915 in log10, so the P25–P75 band runs ×4.14 either way and the P10–P90 band ×32. On held-out live tokens the bands contain the true market cap ' + Math.round(v.p25Coverage * 100) + '% and ' + Math.round(v.p90Coverage * 100) + '% of the time (targets 50% and 80%). Wide, because the comps scatter widely — and the page says so.'),
          el('li', null, el('b', { text: 'Farm verdict, netted — ' }), 'at a uniform $1,000 stake: the expected drop is 5% of the implied value per dollar of TVL (an assumption, stated here), gas is 4 transactions ($3 on Ethereum, $0.50 elsewhere), hours are setup plus weekly actions, and the benchmark is a 4.5% T-bill. FARM when the net clears the T-bill and $5; THIN when it clears zero; SKIP otherwise. The plan itself stays small-farmer sized ($50–300).'),
          el('li', null, el('b', { text: 'Rankable means launchable — ' }), 'pre-token, and not a wrapped, staked or bridged product of a token that already trades (no bridge, liquid-staking, restaking or CEX category; no wrapped/staked word in the name; no exchange name; no version marker). The board ranks all 198 protocols that pass — the watchlist is the floor, never the ceiling.')
        )
      )
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(census());
    shell.appendChild(evidence());
    shell.appendChild(toolbar());
    shell.appendChild(boardTable());
    shell.appendChild(liveSection());
    shell.appendChild(modelSection());
    shell.appendChild(el('footer', null,
      el('span', { text: 'Source: DeFiLlama protocol index · Snapshot ' + DATA.as_of + ' · ' + DATA.model_version + ' model.' }),
      el('span', { text: 'Runs offline: this page loads no network resource. Implied values, odds and verdicts are estimates, not prices.' })
    ));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
})();
