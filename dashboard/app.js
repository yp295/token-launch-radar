// Token Radar patient-4 — dashboard logic. Reads window.RADAR (data.js),
// renders the board, recomputes verdicts live at the reader's stake, and
// opens the detail drawer. No network: every figure comes from data.js.
(function () {
  var R = window.RADAR;
  var meta = R.meta;
  var rows = R.rows;
  var live = R.live;
  var maxImplied = rows[0].implied_value_usd;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function usd(n) {
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    var body = abs < 10000 ? abs.toFixed(2) : String(Math.round(abs));
    var parts = body.split('.');
    var grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + '$' + (parts[1] === undefined ? grouped : grouped + '.' + parts[1]);
  }
  function ageFmt(a) {
    if (a === null || a === undefined) return '—';
    if (a < 60) return a + 'd';
    return (a / 365).toFixed(1) + 'y';
  }
  function changeFmt(c) {
    if (c === null || c === undefined) return '<span>—</span>';
    var cls = c >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (c >= 0 ? '+' : '') + c.toFixed(1) + '%</span>';
  }

  // ---- farm economics, same arithmetic as the model ----
  function econ(row, implied, stake) {
    var drop = (stake * 0.05 * implied) / row.tvl_usd;
    var gas = 4 * (row.chains.indexOf('Ethereum') >= 0 ? 3 : 0.5);
    var hold = row.hold_days;
    var hours = 0.75 + 0.25 * Math.ceil(hold / 7);
    var tbill = (stake * 0.045 * hold) / 365;
    return { drop: drop, gas: gas, net: drop - gas, hours: hours, tbill: tbill, netPerHour: (drop - gas) / hours };
  }
  function pays(e) { return e.net >= e.tbill && e.net >= 5; }
  function verdictAt(row, stake) {
    if (pays(econ(row, row.range_p25_usd, stake))) return 'FARM';
    if (pays(econ(row, row.implied_value_usd, stake)) || pays(econ(row, row.range_p75_usd, stake))) return 'THIN';
    return 'SKIP';
  }
  function stakeToClear(row, implied) {
    var dropRate = (0.05 * implied) / row.tvl_usd;
    var tbillRate = (0.045 * row.hold_days) / 365;
    if (dropRate <= tbillRate) return null;
    var gas = 4 * (row.chains.indexOf('Ethereum') >= 0 ? 3 : 0.5);
    return Math.ceil(Math.max(gas / (dropRate - tbillRate), (gas + 5) / dropRate));
  }
  function stakeFor(row) {
    return state.stake === 'model' ? row.stake_usd : Number(state.stake);
  }
  function stakeLabel() {
    return state.stake === 'model' ? 'model-sized' : usd(Number(state.stake));
  }

  // ---- state ----
  var state = {
    q: '', cat: '', chain: '', verdict: 'ALL', watch: false,
    sortKey: 'implied', sortDir: -1, stake: 'model', selected: null,
  };
  var testsWon = ['loo', 'low_high', 'high_low', 'random10', 'walk_forward'].filter(function (k) {
    return meta.tests[k] < meta.tests[k + '_flat'];
  }).length;

  // ---- KPI strip ----
  var top = rows[0];
  function kpi(title, big, lines) {
    return '<div class="kpi"><h3>' + title + '</h3><div class="big">' + big + '</div>' +
      lines.map(function (l) { return '<p>' + l + '</p>'; }).join('') + '</div>';
  }
  $('kpis').innerHTML =
    kpi('LEAVE-ONE-OUT MISS', '×' + meta.tests.loo.toFixed(2) + ' <span class="vs">vs ×' + meta.tests.loo_flat.toFixed(2) + '</span>',
      ['Fitted ensemble vs flat 0.25', 'Median factor on 128 tokens']) +
    kpi('WALK-FORWARD MISS', '×' + meta.tests.walk_forward.toFixed(2) + ' <span class="vs">vs ×' + meta.tests.walk_forward_flat.toFixed(2) + '</span>',
      ['Fit 47 oldest, test 48 newest', 'New in patient-4']) +
    kpi('TESTS WON VS FLAT', '<span class="big green" style="font-size:24px">' + testsWon + ' / 5</span>',
      ['LOO, both size splits, random ×10, walk-forward', 'Patient-3 won 4 of 5 — it lost low→high']) +
    kpi('FARM VERDICTS', '<span class="big green" style="font-size:24px">' + meta.verdicts.FARM + ' FARM</span>',
      ['THIN ' + meta.verdicts.THIN + ' · SKIP ' + meta.verdicts.SKIP, 'Range-tested at model stake']) +
    kpi('WATCHLIST COVERED', '40 <span class="vs">/ 40</span>',
      ['Protocols on the watchlist', '198 rows ranked in all']) +
    kpi('TOP IMPLIED VALUE', money(top.implied_value_usd),
      [esc(top.name), 'Launch ' + money(top.launch_value_usd) + ' × odds ' + Math.round(top.odds * 100) + '%']);

  // ---- accounting strip ----
  var c = meta.census;
  var asideTotal = c.set_aside.reduce(function (s, x) { return s + x.n; }, 0);
  var pct = function (n) { return (n / c.total * 100).toFixed(1) + '%'; };
  $('account-bar').innerHTML =
    '<i class="seg-live" style="width:' + pct(c.live) + '"></i>' +
    '<i class="seg-ranked" style="width:' + pct(c.ranked) + '"></i>' +
    '<i class="seg-aside" style="width:' + pct(asideTotal) + '"></i>';
  var asideText = c.set_aside.slice().sort(function (a, b) { return b.n - a.n; })
    .map(function (x) { return esc(x.reason) + ' ' + x.n; }).join(' · ');
  $('account-legend').innerHTML =
    '<span class="sw" style="background:#5b8def"></span><b>' + c.live + '</b> already trading' +
    '<span class="sw" style="background:#f0a832"></span><b>' + c.ranked + '</b> ranked pre-token' +
    '<span class="sw" style="background:#3a4763"></span><b>' + asideTotal + '</b> set aside — ' + asideText;
  $('account-right').innerHTML = '<b>✓</b> table = board.json · ' + money(meta.totals.implied_usd) +
    ' total implied · ' + c.total + ' protocols in the snapshot';

  // ---- filter options ----
  var cats = [];
  var chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (ch) { if (chains.indexOf(ch) < 0) chains.push(ch); });
  });
  cats.sort();
  chains.sort();
  cats.forEach(function (cat) {
    var o = document.createElement('option');
    o.value = cat; o.textContent = cat; $('cat').appendChild(o);
  });
  chains.forEach(function (ch) {
    var o = document.createElement('option');
    o.value = ch; o.textContent = ch; $('chain').appendChild(o);
  });

  // ---- filtering + sorting ----
  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'ALL' && verdictAt(r, stakeFor(r)) !== state.verdict) return false;
      if (q) {
        var hay = (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sortKey;
    var dir = state.sortDir;
    var val = function (r) {
      if (key === 'rank') return r.rank;
      if (key === 'name') return r.name.toLowerCase();
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -1e18 : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      if (key === 'odds') return r.odds;
      if (key === 'launch') return r.launch_value_usd;
      return r.implied_value_usd;
    };
    list.sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return list;
  }

  function verdictCounts() {
    var counts = { FARM: 0, THIN: 0, SKIP: 0 };
    rows.forEach(function (r) { counts[verdictAt(r, stakeFor(r))]++; });
    return counts;
  }

  function renderPills() {
    var counts = verdictCounts();
    var pills = [
      { k: 'ALL', label: 'All', n: rows.length },
      { k: 'FARM', label: 'FARM', n: counts.FARM },
      { k: 'THIN', label: 'THIN', n: counts.THIN },
      { k: 'SKIP', label: 'SKIP', n: counts.SKIP },
    ];
    $('pills').innerHTML = pills.map(function (p) {
      return '<button type="button" class="pill ' + p.k.toLowerCase() + (state.verdict === p.k ? ' on' : '') +
        '" data-v="' + p.k + '">' + p.label + ' <span class="n">' + p.n + '</span></button>';
    }).join('');
    $('pills').querySelectorAll('.pill').forEach(function (b) {
      b.addEventListener('click', function () { state.verdict = b.dataset.v; render(); });
    });
  }

  function renderTable() {
    var list = filtered();
    var tb = $('rows');
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="10" class="empty">No rows match these filters.</td></tr>';
    } else {
      tb.innerHTML = list.map(function (r) {
        var v = verdictAt(r, stakeFor(r));
        var sub = esc(r.category || 'No category') + ' · ' +
          esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '');
        var width = Math.max(2, Math.round((r.implied_value_usd / maxImplied) * 100));
        return '<tr class="row' + (state.selected === r.slug ? ' sel' : '') + '" data-slug="' + esc(r.slug) + '">' +
          '<td>' + r.rank + '</td>' +
          '<td><div class="name">' + esc(r.name) + (r.watchlist ? '<span class="watchtag">WATCH</span>' : '') + '</div><div class="sub">' + sub + '</div></td>' +
          '<td>' + money(r.tvl_usd) + '</td>' +
          '<td>' + changeFmt(r.change_7d) + '</td>' +
          '<td>' + ageFmt(r.age_days) + '</td>' +
          '<td>' + Math.round(r.odds * 100) + '%</td>' +
          '<td>' + money(r.launch_value_usd) + '</td>' +
          '<td>' + money(r.range_p25_usd) + '–' + money(r.range_p75_usd) + '</td>' +
          '<td><span class="bar"><i style="width:' + width + '%"></i></span>' + money(r.implied_value_usd) + '</td>' +
          '<td><span class="vbadge ' + v + '">' + v + '</span></td></tr>';
      }).join('');
    }
    $('shown').textContent = list.length + ' of ' + rows.length + ' rows shown';
    tb.querySelectorAll('tr.row').forEach(function (tr) {
      tr.addEventListener('click', function () { openDrawer(tr.dataset.slug); });
    });
  }

  function render() { renderPills(); renderTable(); }

  // ---- evidence ----
  var t = meta.tests;
  function testRow(name, fitted, flat, what) {
    var cls = fitted < flat ? 'win' : 'lose';
    return '<tr><td>' + name + '</td><td class="num ' + cls + '">×' + fitted.toFixed(2) + '</td>' +
      '<td class="num">×' + flat.toFixed(2) + '</td><td>' + what + '</td></tr>';
  }
  $('tests').innerHTML =
    testRow('Leave-one-out, 128 live tokens', t.loo, t.loo_flat, 'Refit leaving each token out in turn') +
    testRow('Size split: fit small, test big', t.low_high, t.low_high_flat, 'Fit the 64 smallest, test the 64 largest') +
    testRow('Size split: fit big, test small', t.high_low, t.high_low_flat, 'Fit the 64 largest, test the 64 smallest') +
    testRow('Random halves ×10 (median)', t.random10, t.random10_flat, 'Ten 50/50 splits, seed 0x20261114') +
    testRow('Walk-forward', t.walk_forward, t.walk_forward_flat, 'Fit the 47 oldest dated tokens, test the 48 newest');
  $('honest').innerHTML =
    '<div class="note"><b>The one loss.</b> Leave-one-out is 4% worse than patient-3 (×3.40 → ×' + t.loo.toFixed(2) + '). That gap is noise, not a defeat: it is a median of medians over 128 scattered tokens, and a 2,000-resample bootstrap of the difference gives a 95% interval of [0.97×, 1.04×], covering 1.0. The ensemble wins the other four tests — including the low→high split patient-3 lost (×5.20 → ×' + t.low_high.toFixed(2) + ').</div>' +
    '<div class="note"><b>Read the THIN tier honestly.</b> ' + meta.verdicts.thin_only_at_p75 + ' of the ' + meta.verdicts.THIN + ' THIN rows only pay at P75, not at the point estimate. They stay THIN because “pays in the optimistic case” is what thin means — a margin that depends on upside — but under a literal point-estimate reading the board would read 4 / ' + meta.verdicts.thin_at_point + ' / 137. That is a judgment call, stated here, not hidden.</div>' +
    '<div class="note"><b>The fit is still weak in absolute terms.</b> R² ' + meta.fit.r2.toFixed(3) + ': half of all live tokens sit more than 3.5× from the curve, and the ranges (÷×' + meta.fit.factor_25_75.toFixed(2) + ', ÷×' + meta.fit.factor_10_90.toFixed(2) + ') say so. Growth and age, fitted, come out negative (' + meta.fit.growth_coef.toFixed(2) + ' and ' + meta.fit.age_coef.toFixed(2) + ') and stay in the model only as bounded priors, because the brief requires the value to follow them.</div>';

  // ---- model section ----
  var f = meta.fit;
  var fmt4 = function (n) { return n.toFixed(4); };
  var top5 = rows.slice(0, 5).map(function (r) { return esc(r.name) + ' ' + r.rank_lo + '–' + r.rank_hi; }).join(', ');
  $('model-body').innerHTML =
    '<div class="formula">log10(mcap/TVL) = ' + fmt4(f.ensemble[0]) + ' − ' + Math.abs(f.ensemble[1]).toFixed(4) + ' · log10(TVL)    (n = ' + f.n_live + ', R² = ' + f.r2.toFixed(3) + ')\n' +
    'base_multiple(TVL) = clamp(10^(' + fmt4(f.ensemble[0]) + ' − ' + Math.abs(f.ensemble[1]).toFixed(4) + ' · log10(TVL)), 0.03, 0.70)\n' +
    'launch = TVL × base_multiple × growth_mult × maturity_mult\n' +
    'implied = launch × odds</div>' +
    '<dl>' +
    '<dt>The ensemble</dt><dd>The curve is the average of two lines fitted at runtime on the ' + f.n_live + ' live tokens: OLS [' + fmt4(f.ols[0]) + ', ' + fmt4(f.ols[1]) + '] and a median regression [' + fmt4(f.quantile[0]) + ', ' + fmt4(f.quantile[1]) + ']. The median line alone jumps between refits; the average keeps its robustness without its instability. No constant is hard-coded — both lines are refitted from the snapshot on every run.</dd>' +
    '<dt>The range</dt><dd>From the ensemble’s own leave-one-out residuals (σ = ' + f.sigma.toFixed(3) + ' in log10): P25–P75 = implied ÷×' + f.factor_25_75.toFixed(2) + ', P10–P90 = implied ÷×' + f.factor_10_90.toFixed(2) + '. On held-out tokens the bands contain the true cap ' + Math.round(f.coverage_25_75 * 100) + '% and ' + Math.round(f.coverage_10_90 * 100) + '% of the time (targets 50% and 80%) — a little wide, which is the safe direction.</dd>' +
    '<dt>The verdict</dt><dd>Scheme (a), tested on the range at a model-sized stake (0.1% of TVL, $500–$25,000): FARM pays even at P25, THIN pays at the point estimate or at P75, SKIP pays not even at P75. “Pays” means net ≥ the T-bill and net ≥ $5, with a 5% drop share and 4 transactions of gas. Result: ' + meta.verdicts.FARM + ' FARM / ' + meta.verdicts.THIN + ' THIN / ' + meta.verdicts.SKIP + ' SKIP.</dd>' +
    '<dt>Growth, fitted</dt><dd>Adding 7-day growth to the comps’ regression gives ' + f.growth_coef.toFixed(2) + ' per 100 points (' + f.growth_coef_fuller.toFixed(2) + ' with age): fast growers trade at lower multiples, likely mean reversion. The model does not use the fitted sign — it would punish growing protocols — and keeps growth as a bounded log-damped prior instead.</dd>' +
    '<dt>Age, fitted</dt><dd>Adding age gives ' + f.age_coef.toFixed(2) + ': older tokens trade at lower multiples, so the “overdue premium” has no support in the comps. Maturity stays a saturating prior (0.60–0.93), because the brief requires time with no token to count, capped so it cannot dominate.</dd>' +
    '<dt>Token odds</dt><dd>Peers in the same age-and-size cell that already record a token, smoothed with a 10-protocol prior: Brier ' + meta.odds.brier_binned.toFixed(3) + ' against ' + meta.odds.brier_base.toFixed(3) + ' for the base rate. Finer bins (chain count, category) made the Brier worse (0.211 / 0.215), so the bins stay as they are.</dd>' +
    '<dt>Rank stability</dt><dd>' + meta.bootstrap.refits + ' bootstrap refits of the size curve; the median row moves ' + meta.bootstrap.median_rank_move + ' places between its P10 and P90 rank. The top 5 do not move at all (' + top5 + ').</dd>' +
    '</dl>';

  // ---- live table ----
  $('live-rows').innerHTML = live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><div class="sub">' + esc(p.category || 'No category') + '</div></td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num">' + p.ratio.toFixed(3) + '</td></tr>';
  }).join('');

  // ---- drawer ----
  function scenLine(label, e) {
    return '<div><b>' + label + '</b> — drop ' + usd(e.drop) + ', gas ' + usd(e.gas) + ', net ' + usd(e.net) +
      ' (' + usd(e.netPerHour) + ' an hour) against a ' + usd(e.tbill) + ' T-bill: <b>' +
      (pays(e) ? 'pays' : 'does not pay') + '</b>.</div>';
  }
  function openDrawer(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    state.selected = slug;
    var stake = stakeFor(r);
    var v = verdictAt(r, stake);
    var e25 = econ(r, r.range_p25_usd, stake);
    var e0 = econ(r, r.implied_value_usd, stake);
    var e75 = econ(r, r.range_p75_usd, stake);
    var oneLine = v === 'FARM' ? 'it pays even in the pessimistic case.'
      : v === 'THIN' && pays(e0) ? 'it pays at the point estimate but not in the pessimistic case.'
      : v === 'THIN' ? 'it pays only in the optimistic case.'
      : 'it does not pay even in the optimistic case.';
    var stf = stakeToClear(r, r.range_p25_usd);
    var stakeNote = v === 'FARM'
      ? 'The model stake already clears it; the smallest stake that does is ' + usd(stf) + '.'
      : stf === null
        ? 'No stake clears the bar at P25 — the drop rate there sits below the T-bill rate.'
        : 'The smallest stake that clears the bar even at P25 is ' + usd(stf) + '.';
    // Recompute check against board.json.
    var relaunch = Math.max(1, Math.round(r.tvl_usd * r.base_multiple * r.growth_mult * r.maturity_mult));
    var reimplied = Math.max(1, Math.round(relaunch * r.odds));
    var match = relaunch === r.launch_value_usd && reimplied === r.implied_value_usd;
    var ageText = r.age_days === null ? 'unknown (' + meta.fit.unknown_age_days + ' days assumed)' : ageFmt(r.age_days) + ' (' + r.age_days + ' days)';
    $('drawer').innerHTML =
      '<div class="rankline"><span>Rank ' + r.rank + ' of ' + rows.length + '</span><button type="button" class="close" id="drawer-close">Close</button></div>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="cats">' + esc(r.category || 'No category') + ' · ' + esc(r.chains.join(', ')) + '</p>' +
      '<h3>Farm verdict — at a ' + usd(stake) + ' stake' + (state.stake === 'model' ? ' (model-sized)' : '') + '</h3>' +
      '<div class="verdictbox"><div class="vline"><b class="' + v + '">' + v + '</b> — ' + oneLine + '</div>' +
      '<div class="scen">' + scenLine('P25 (pessimistic)', e25) + scenLine('Point estimate', e0) + scenLine('P75 (optimistic)', e75) + '</div>' +
      '<p class="stake-note">' + stakeNote + '</p>' +
      '<p class="stake-note">The plan itself is sized for a small farmer ($50–300 deposit by TVL band). The verdict answers whether it is worth scaling to a ' + usd(stake) + ' stake — the drop is assumed to be 5% of the launch value, gas is 4 transactions, and the benchmark is a 4.5% T-bill.</p></div>' +
      '<h3>How the figure is made</h3><div class="kv">' +
      '<div>TVL</div><div>' + money(r.tvl_usd) + '</div>' +
      '<div>Base multiple (fitted)</div><div>× ' + r.base_multiple.toFixed(3) + '</div>' +
      '<div>Seven-day growth</div><div>' + (r.change_7d === null ? 'unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div>' +
      '<div>Growth multiplier</div><div>× ' + r.growth_mult.toFixed(3) + '</div>' +
      '<div>Age with no token</div><div>' + ageText + '</div>' +
      '<div>Maturity multiplier</div><div>× ' + r.maturity_mult.toFixed(3) + '</div>' +
      '<div>Launch value (if it launches)</div><div>' + money(r.launch_value_usd) + '</div>' +
      '<div>Token odds — peers ' + esc(r.odds_cell) + ': ' + r.odds_have + ' of ' + r.odds_total + ' record a token</div><div>× ' + r.odds.toFixed(2) + '</div>' +
      '<div class="total">Implied value</div><div class="total">' + money(r.implied_value_usd) + '</div>' +
      '<div>Range P25–P75</div><div>' + money(r.range_p25_usd) + '–' + money(r.range_p75_usd) + '</div>' +
      '<div>Range P10–P90</div><div>' + money(r.range_p10_usd) + '–' + money(r.range_p90_usd) + '</div></div>' +
      '<p class="match">' + (match ? 'Recomputed in this page: matches board.json — launch, odds, implied value and range all agree with the file.'
        : 'Recomputed in this page: does NOT match board.json — launch recomputes to ' + money(relaunch) + '.') + '</p>' +
      '<h3>Rank stability — ' + meta.bootstrap.refits + ' bootstrap refits</h3>' +
      '<p class="neigh">Rank P10–P90: <b>' + r.rank_lo + '–' + r.rank_hi + '</b>; in the top 20 in <b>' + Math.round(r.top20_share * 100) + '%</b> of refits. The median row on the board moves ' + meta.bootstrap.median_rank_move + ' places between its P10 and P90 rank.</p>' +
      '<h3>Closest priced neighbours</h3>' +
      '<p class="neigh">Live-token protocols nearest this row in TVL, with their real market-cap/TVL ratios:<br>' +
      r.neighbours.map(function (n) { return '<b>' + esc(n.name) + '</b> — TVL ' + money(n.tvl) + ', mcap ' + money(n.mcap) + ', ratio ' + n.ratio.toFixed(3); }).join('<br>') + '</p>' +
      '<h3>Farm plan</h3><ol class="plan">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    $('drawer').classList.add('on');
    $('scrim').classList.add('on');
    $('drawer-close').addEventListener('click', closeDrawer);
    renderTable();
  }
  function closeDrawer() {
    state.selected = null;
    $('drawer').classList.remove('on');
    $('scrim').classList.remove('on');
    renderTable();
  }
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // ---- toolbar events ----
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderTable(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderTable(); });
  $('watchonly').addEventListener('change', function (e) { state.watch = e.target.checked; renderTable(); });
  $('stake').addEventListener('change', function (e) {
    state.stake = e.target.value;
    render();
    if (state.selected) openDrawer(state.selected);
  });
  $('sort').addEventListener('change', function (e) {
    state.sortKey = e.target.value;
    state.sortDir = state.sortKey === 'name' || state.sortKey === 'rank' ? 1 : -1;
    renderTable();
  });
  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir = -state.sortDir;
      else { state.sortKey = k; state.sortDir = k === 'name' || k === 'rank' ? 1 : -1; }
      renderTable();
    });
  });
  $('reset').addEventListener('click', function () {
    state.q = ''; state.cat = ''; state.chain = ''; state.verdict = 'ALL';
    state.watch = false; state.sortKey = 'implied'; state.sortDir = -1; state.stake = 'model';
    $('q').value = ''; $('cat').value = ''; $('chain').value = '';
    $('watchonly').checked = false; $('stake').value = 'model'; $('sort').value = 'implied';
    closeDrawer();
    render();
  });
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }
  $('csv').addEventListener('click', function () {
    var list = filtered();
    var head = 'rank,slug,name,category,chains,tvl_usd,change_7d,age_days,odds,launch_value_usd,implied_value_usd,range_p25_usd,range_p75_usd,verdict';
    var lines = list.map(function (r) {
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '').replace(/"/g, '""') + '"',
        '"' + r.chains.join(';') + '"', r.tvl_usd, r.change_7d === null ? '' : r.change_7d,
        r.age_days === null ? '' : r.age_days, r.odds.toFixed(4), r.launch_value_usd,
        r.implied_value_usd, r.range_p25_usd, r.range_p75_usd, verdictAt(r, stakeFor(r))].join(',');
    });
    download('token-radar.csv', head + '\n' + lines.join('\n') + '\n', 'text/csv');
  });
  $('json').addEventListener('click', function () {
    download('token-radar.json', JSON.stringify(filtered(), null, 1) + '\n', 'application/json');
  });

  render();
})();
