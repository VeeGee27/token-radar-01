// Launch Radar — the dashboard (plain JavaScript, no framework, no network).
//
// Reads window.RADAR (written by main.ts from the sealed snapshot), renders the KPI
// strip, the methodology, the sortable/filterable board, and a detail view per protocol.
// Query parameters, for deep links and screenshots: ?detail=<slug> opens a protocol,
// ?cat=<category> and ?status=watchlist|early pre-apply filters, ?q=<text> pre-fills search.

(function () {
  'use strict';

  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.body.innerHTML = '<p style="padding:32px">Launch Radar: no data. The program writes data.js beside this page.</p>';
    return;
  }

  var rows = R.rows;
  var model = R.model;

  /** Escape text for HTML: names come from the snapshot, never trust them raw. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  function moneyFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function pct(change) {
    if (change === null || change === undefined) return '<span class="flat">—</span>';
    var cls = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    var sign = change > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + change.toFixed(1) + '%</span>';
  }

  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }

  function catName(c) {
    return c === null || c === undefined ? 'Uncategorised' : c;
  }

  /* ---------------------------------------------------------- KPI strip */

  function renderKpis() {
    var top = rows[0];
    var kpis = [
      { label: 'Watchlist', value: String(R.watchlist_size), sub: 'protocols at or above the $50M floor, no token recorded' },
      { label: 'Board rows', value: String(rows.length), sub: R.pre_token_count + ' pre-token protocols in the snapshot' },
      { label: 'Top implied value', value: money(R.top_value_usd), sub: top ? top.name : '—' },
      { label: 'Median implied value', value: money(R.median_value_usd), sub: 'across all ' + rows.length + ' rows' },
      { label: 'Model fit', value: 'R² ' + model.r2.toFixed(2), sub: 'fitted on ' + model.comps + ' token-trading comps' },
    ];
    document.getElementById('kpis').innerHTML = kpis
      .map(function (k) {
        return '<div class="kpi"><div class="label">' + esc(k.label) + '</div><div class="value">' + esc(k.value) + '</div><div class="sub">' + esc(k.sub) + '</div></div>';
      })
      .join('');
    document.getElementById('as-of').textContent = R.as_of;
  }

  /* ------------------------------------------------------- methodology */

  function renderMethod() {
    var f = 'log10(implied) = ' + model.intercept.toFixed(4) + ' + ' + model.slope.toFixed(4) +
      ' × log10(TVL) + category term + log10(growth × age)';
    document.getElementById('method-formula').textContent = f;
    var t = model.tests;
    document.getElementById('method-comps').innerHTML =
      'Fitted by ordinary least squares on <strong>' + model.comps +
      '</strong> protocols whose token trades (positive market cap and TVL): log10(market cap) on ' +
      'log10(TVL), plus a shrunken median-residual term per category (n ≥ 3, shrunk n/(n+5)). ' +
      'Residual spread σ = <strong>' + model.resid_sd.toFixed(2) + '</strong> in log10 — about a ' +
      'factor of ' + Math.pow(10, model.resid_sd).toFixed(1) + '×. Growth and age are capped ' +
      'judgement nudges (×0.90–1.20 and ×1.00–1.10), never fitted coefficients: fitting them ' +
      'made held-out error worse.';
    document.getElementById('method-tests').innerHTML =
      '<strong>' + esc(t[0].name) + ':</strong> ' + t[0].train + ' train / ' + t[0].test +
      ' test — median error <strong>' + t[0].median_pct_error.toFixed(0) + '%</strong>, ' +
      t[0].within_2x_pct.toFixed(0) + '% of predictions within 2× of the real market cap.<br>' +
      '<strong>' + esc(t[1].name) + ':</strong> ' + t[1].train + ' train / ' + t[1].test +
      ' test — median error <strong>' + t[1].median_pct_error.toFixed(0) + '%</strong>, ' +
      t[1].within_2x_pct.toFixed(0) + '% within 2×. Both are computed by the program on every run.';
  }

  /* ---------------------------------------------------------- controls */

  var state = { q: '', cat: '', chain: '', status: '', sort: 'value' };

  function uniqueSorted(values) {
    return Array.from(new Set(values)).sort(function (a, b) {
      return String(a).localeCompare(String(b));
    });
  }

  function renderFilters() {
    var catSel = document.getElementById('f-cat');
    uniqueSorted(rows.map(function (r) { return catName(r.category); })).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    });
    var chainSel = document.getElementById('f-chain');
    uniqueSorted(rows.flatMap(function (r) { return r.chains; })).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      chainSel.appendChild(o);
    });
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      if (state.cat && catName(r.category) !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.status && r.status !== state.status) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days); },
      name: function (a, b) { return a.name.localeCompare(b.name); },
    }[state.sort] || function (a, b) { return b.implied_value_usd - a.implied_value_usd; };
    return out.sort(by);
  }

  /* ------------------------------------------------------------- board */

  var selectedSlug = null;

  function renderBoard() {
    var list = filtered();
    var body = document.getElementById('board-body');
    body.innerHTML = list
      .map(function (r) {
        var badge = r.status === 'watchlist'
          ? '<span class="badge badge-watch">Watchlist</span>'
          : '<span class="badge badge-early">Early</span>';
        return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === selectedSlug ? ' class="selected"' : '') + '>' +
          '<td class="num rank">' + r.rank + '</td>' +
          '<td><span class="proto-name">' + esc(r.name) + '</span>' + badge +
          '<br><span class="proto-slug">' + esc(r.slug) + '</span></td>' +
          '<td>' + esc(catName(r.category)) + '</td>' +
          '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
          '<td class="num">' + money(r.tvl_usd) + '</td>' +
          '<td class="num">' + pct(r.change_7d) + '</td>' +
          '<td class="num">' + ageText(r.age_days) + '</td>' +
          '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
          '<td class="num">' + money(r.deposit_usd) + '</td>' +
          '</tr>';
      })
      .join('');
    document.getElementById('count').textContent =
      list.length + ' of ' + rows.length + ' rows';
    body.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openDetail(tr.getAttribute('data-slug'));
      });
    });
  }

  /* ------------------------------------------------------------- detail */

  function figure(label, value, sub) {
    return '<div class="figure"><div class="label">' + esc(label) + '</div><div class="value">' + value +
      '</div><div class="sub">' + esc(sub || '') + '</div></div>';
  }

  function openDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selectedSlug = slug;
    document.getElementById('detail').hidden = false;
    document.getElementById('detail-name').textContent = '#' + r.rank + ' — ' + r.name;
    document.getElementById('detail-sub').textContent =
      r.slug + ' · ' + catName(r.category) + ' · ' + r.chains.join(', ') +
      (r.status === 'watchlist' ? ' · on the watchlist' : ' · below the $50M floor');
    var figs = figure('TVL', money(r.tvl_usd), 'whole dollars: ' + moneyFull(r.tvl_usd)) +
      figure('7-day change', pct(r.change_7d), 'TVL change over 7 days') +
      figure('Age', ageText(r.age_days), r.listed_at ? 'listed ' + r.listed_at : 'listing date unknown') +
      figure('Farm deposit', money(r.deposit_usd), 'sized to TVL, $100–$2,500');
    document.getElementById('detail-figures').innerHTML = figs;
    var catSign = r.cat_term_log >= 0 ? '+' : '';
    document.getElementById('detail-terms').innerHTML =
      'base&nbsp;&nbsp;&nbsp;= 10^(' + model.intercept.toFixed(4) + ' + ' + model.slope.toFixed(4) +
      ' × log10(TVL)) = <strong>' + moneyFull(r.base_value_usd) + '</strong><br>' +
      'category&nbsp;= ' + catSign + r.cat_term_log.toFixed(3) + ' in log10 (' + esc(catName(r.category)) + ')<br>' +
      'growth&nbsp;&nbsp;= ×' + r.growth_factor.toFixed(3) + ' (7d change ' +
      (r.change_7d === null ? 'unreported' : r.change_7d.toFixed(1) + '%') + ', capped)<br>' +
      'age&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ×' + r.age_factor.toFixed(3) + ' (' + ageText(r.age_days) +
      ' with no token, capped)<br>' +
      '<span class="result">implied&nbsp;= ' + moneyFull(r.implied_value_usd) + '</span>';
    document.getElementById('detail-steps').innerHTML = r.farm_steps
      .map(function (s) { return '<li>' + esc(s) + '</li>'; })
      .join('');
    renderBoard();
    document.getElementById('detail').scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  document.getElementById('detail-close').addEventListener('click', function () {
    selectedSlug = null;
    document.getElementById('detail').hidden = true;
    renderBoard();
  });

  /* -------------------------------------------------------------- wiring */

  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value;
    renderBoard();
  });
  document.getElementById('f-cat').addEventListener('change', function (e) {
    state.cat = e.target.value;
    renderBoard();
  });
  document.getElementById('f-chain').addEventListener('change', function (e) {
    state.chain = e.target.value;
    renderBoard();
  });
  document.getElementById('f-status').addEventListener('change', function (e) {
    state.status = e.target.value;
    renderBoard();
  });
  document.getElementById('f-sort').addEventListener('change', function (e) {
    state.sort = e.target.value;
    renderBoard();
  });

  renderKpis();
  renderMethod();
  renderFilters();
  renderBoard();

  // Deep links: ?detail=<slug>, ?cat=<category>, ?status=watchlist|early, ?q=<text>.
  var params = new URLSearchParams(window.location.search);
  var preCat = params.get('cat');
  if (preCat) {
    state.cat = preCat;
    document.getElementById('f-cat').value = preCat;
  }
  var preStatus = params.get('status');
  if (preStatus === 'watchlist' || preStatus === 'early') {
    state.status = preStatus;
    document.getElementById('f-status').value = preStatus;
  }
  var preQ = params.get('q');
  if (preQ) {
    state.q = preQ;
    document.getElementById('q').value = preQ;
  }
  if (preCat || preStatus || preQ) renderBoard();
  var preDetail = params.get('detail');
  if (preDetail) openDetail(preDetail);
})();
