/* ---------------- shared state ---------------- */

let currentJobId = null;
let pollTimer = null;
let lastStatus = null;

let allFindings = [];   // raw findings from the last loaded job (scan result or history entry)
let currentMeta = {};
let readOnlyView = false; // true when viewing a history entry rather than a live scan

const filterState = {
  severity: null,   // null = all, else 'CRITICAL' etc
  search: '',
  category: '',
  verifyOnly: false,
  sortKey: 'severity',
  sortDir: 'desc',
  page: 1,
  pageSize: 25,
};

const SEV_ORDER = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

/* ---------------- toasts ---------------- */

function toast(msg, kind) {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

/* ---------------- tabs ---------------- */

const tabButtons = document.querySelectorAll('.tab-btn');
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  tabButtons.forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
  document.getElementById('pane-' + name).classList.add('active');

  if (name === 'history') loadHistory();
  if (name === 'compare') loadCompareOptions();
}

/* ---------------- scan form ---------------- */

const form = document.getElementById('scan-form');
const consoleEl = document.getElementById('console');
const scanBtn = document.getElementById('scan-btn');
const minConfSlider = document.getElementById('min-conf');
const minConfVal = document.getElementById('min-conf-val');

minConfSlider.addEventListener('input', () => {
  minConfVal.textContent = minConfSlider.value;
});

document.getElementById('console-clear').addEventListener('click', () => {
  consoleEl.innerHTML = '<div class="console-line dim">$ cleared</div>';
});

// remember last target for convenience
try {
  const savedTarget = localStorage.getItem('mpf_last_target');
  if (savedTarget) document.getElementById('target').value = savedTarget;
} catch (e) { /* storage unavailable, ignore */ }

function log(msg, cls) {
  const line = document.createElement('div');
  line.className = 'console-line' + (cls ? ' ' + cls : '');
  line.textContent = msg;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setPipelineStep(status) {
  const steps = document.querySelectorAll('#pipeline-steps li');
  const order = ['crawling', 'extracting', 'validating', 'done'];
  const idx = order.indexOf(status);
  steps.forEach((li) => {
    const stepIdx = order.indexOf(li.dataset.step);
    li.classList.remove('active', 'complete');
    if (stepIdx < idx) li.classList.add('complete');
    else if (stepIdx === idx) li.classList.add('active');
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = document.getElementById('target').value.trim();
  if (!target) return;

  const confirmAuthorized = document.getElementById('confirm-authorized').checked;
  if (!confirmAuthorized) {
    log('! You must confirm you are authorized to test this target before scanning.', 'warn');
    toast('Confirm authorization before scanning', 'warn');
    return;
  }

  try { localStorage.setItem('mpf_last_target', target); } catch (e) { /* ignore */ }

  readOnlyView = false;
  setButtonBusy(true);
  consoleEl.innerHTML = '';
  resetPipeline();
  hideFindings('Scan in progress...');
  lastStatus = null;

  log(`$ mass-pii-finder scan ${target}`, null);
  log('$ authorized-scope check: confirmed by user', 'dim');

  const scopeExtra = document.getElementById('scope-extra').value
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const payload = {
    target,
    confirm_authorized: confirmAuthorized,
    max_files: parseInt(document.getElementById('max-files').value, 10),
    timeout: parseInt(document.getElementById('timeout').value, 10),
    probe: document.getElementById('probe').checked,
    min_confidence: parseInt(minConfSlider.value, 10),
    scope: scopeExtra,
    rate_limit: parseFloat(document.getElementById('rate-limit').value),
    enumerate_subdomains: document.getElementById('enumerate-subdomains').checked,
    no_subdomains: document.getElementById('no-subdomains').checked,
    no_robots: document.getElementById('no-robots').checked,
  };

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) {
      log('! ' + data.error, 'warn');
      toast(data.error, 'warn');
      setButtonBusy(false);
      return;
    }
    currentJobId = data.job_id;
    pollTimer = setInterval(pollStatus, 900);
  } catch (err) {
    log('! request failed: ' + err.message, 'warn');
    toast('Request failed: ' + err.message, 'warn');
    setButtonBusy(false);
  }
});

function resetPipeline() {
  document.querySelectorAll('#pipeline-steps li').forEach((li) => li.classList.remove('active', 'complete'));
}

async function pollStatus() {
  if (!currentJobId) return;
  const res = await fetch(`/api/status/${currentJobId}`);
  const data = await res.json();

  if (data.status !== lastStatus) {
    log(`$ ${data.progress}`, data.status === 'error' ? 'warn' : null);
    setPipelineStep(data.status);
    lastStatus = data.status;
  }

  if (data.status === 'done') {
    clearInterval(pollTimer);
    renderResults(data.findings || [], data.meta || {});
    setButtonBusy(false);
    toast('Scan complete', 'ok');
  } else if (data.status === 'error') {
    clearInterval(pollTimer);
    setButtonBusy(false);
    toast(data.progress || 'Scan failed', 'warn');
  }
}

function setButtonBusy(busy) {
  scanBtn.disabled = busy;
  scanBtn.querySelector('.btn-label').textContent = busy ? 'Scanning...' : 'Run scan';
  scanBtn.querySelector('.btn-spinner').hidden = !busy;
}

function hideFindings(message) {
  document.getElementById('findings-table-wrap').hidden = true;
  document.getElementById('findings-toolbar').hidden = true;
  document.getElementById('sev-bar').hidden = true;
  const empty = document.getElementById('empty-state');
  empty.hidden = false;
  empty.querySelector('p').textContent = message;
}

/* ---------------- findings rendering / filter / sort / paginate ---------------- */

function renderResults(findings, meta) {
  allFindings = findings;
  currentMeta = meta;
  filterState.severity = null;
  filterState.search = '';
  filterState.category = '';
  filterState.verifyOnly = false;
  filterState.page = 1;
  document.getElementById('findings-search').value = '';
  document.getElementById('verify-only').checked = false;
  document.querySelectorAll('.stat').forEach((s) => s.classList.remove('active'));

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  findings.forEach((f) => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
  document.getElementById('stat-critical').textContent = counts.CRITICAL;
  document.getElementById('stat-high').textContent = counts.HIGH;
  document.getElementById('stat-medium').textContent = counts.MEDIUM;
  document.getElementById('stat-low').textContent = counts.LOW;

  const total = findings.length || 1;
  const bar = document.getElementById('sev-bar');
  bar.hidden = findings.length === 0;
  document.getElementById('sev-bar-crit').style.width = (counts.CRITICAL / total * 100) + '%';
  document.getElementById('sev-bar-high').style.width = (counts.HIGH / total * 100) + '%';
  document.getElementById('sev-bar-med').style.width = (counts.MEDIUM / total * 100) + '%';
  document.getElementById('sev-bar-low').style.width = (counts.LOW / total * 100) + '%';

  if (!readOnlyView) {
    log(`$ scanned ${meta.js_file_count || 0} JS file(s), found ${meta.sourcemap_count || 0} exposed sourcemap(s)`, 'ok');
    if (meta.pages_crawled) log(`$ crawled ${meta.pages_crawled} in-scope page(s)`, 'dim');
    if (meta.subdomain_count) log(`$ ${meta.subdomain_count} subdomain(s) found via passive CT log lookup`, 'dim');
    if (meta.scope_excluded_sample && meta.scope_excluded_sample.length) {
      log(`$ ${meta.scope_excluded_sample.length} URL(s) excluded as out-of-scope (not fetched)`, 'dim');
    }
    if (meta.sourcemaps && meta.sourcemaps.length) {
      meta.sourcemaps.slice(0, 5).forEach((sm) => log('  sourcemap: ' + sm, 'warn'));
    }
    log(`$ ${findings.length} finding(s) after triage`, 'ok');
  }

  populateCategoryFilter(findings);

  if (!findings.length) {
    hideFindings(readOnlyView
      ? 'This scan produced no findings above its confidence threshold.'
      : 'No findings above the selected confidence threshold. Try lowering min confidence, or the target may simply be clean.');
    return;
  }

  document.getElementById('empty-state').hidden = true;
  document.getElementById('findings-table-wrap').hidden = false;
  document.getElementById('findings-toolbar').hidden = false;

  applyFilters();
}

function populateCategoryFilter(findings) {
  const sel = document.getElementById('category-filter');
  const cats = Array.from(new Set(findings.map((f) => f.category).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

document.getElementById('findings-search').addEventListener('input', (e) => {
  filterState.search = e.target.value.trim().toLowerCase();
  filterState.page = 1;
  applyFilters();
});
document.getElementById('category-filter').addEventListener('change', (e) => {
  filterState.category = e.target.value;
  filterState.page = 1;
  applyFilters();
});
document.getElementById('verify-only').addEventListener('change', (e) => {
  filterState.verifyOnly = e.target.checked;
  filterState.page = 1;
  applyFilters();
});
document.querySelectorAll('.stat').forEach((btn) => {
  btn.addEventListener('click', () => {
    const sev = btn.dataset.filterSev;
    filterState.severity = filterState.severity === sev ? null : sev;
    filterState.page = 1;
    document.querySelectorAll('.stat').forEach((s) => s.classList.toggle('active', s.dataset.filterSev === filterState.severity));
    applyFilters();
  });
});
document.querySelectorAll('.findings-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (filterState.sortKey === key) {
      filterState.sortDir = filterState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      filterState.sortKey = key;
      filterState.sortDir = 'desc';
    }
    applyFilters();
  });
});

function applyFilters() {
  let rows = allFindings.filter((f) => {
    if (filterState.severity && f.severity !== filterState.severity) return false;
    if (filterState.category && f.category !== filterState.category) return false;
    if (filterState.verifyOnly && !f.needs_manual_verification) return false;
    if (filterState.search) {
      const blob = [f.type, f.category, f.value, ...(f.source_files || [])].join(' ').toLowerCase();
      if (!blob.includes(filterState.search)) return false;
    }
    return true;
  });

  const { sortKey, sortDir } = filterState;
  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === 'severity') { av = SEV_ORDER[a.severity] || 0; bv = SEV_ORDER[b.severity] || 0; }
    else if (sortKey === 'confidence') { av = a.confidence; bv = b.confidence; }
    else { av = (a[sortKey] || '').toString().toLowerCase(); bv = (b[sortKey] || '').toString().toLowerCase(); }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  document.querySelectorAll('.findings-table th.sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === sortKey) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sortDir === 'asc' ? '↑' : '↓';
      th.appendChild(arrow);
    }
  });

  renderTable(rows);
}

function renderTable(rows) {
  const findingsBody = document.getElementById('findings-body');
  const pageSize = filterState.pageSize;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  if (filterState.page > totalPages) filterState.page = totalPages;
  const start = (filterState.page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  findingsBody.innerHTML = '';

  if (!pageRows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="dim" style="text-align:center; padding:24px;">No findings match the current filters.</td>`;
    findingsBody.appendChild(tr);
  }

  pageRows.forEach((f, i) => {
    const tr = document.createElement('tr');
    const files = linkList(f.source_files);
    const verifyFlag = f.needs_manual_verification ? '<span class="verify-flag">VERIFY</span>' : '';
    tr.innerHTML = `
      <td>${start + i + 1}</td>
      <td><span class="sev-badge sev-${f.severity}">${f.severity}</span>${verifyFlag}</td>
      <td>${escapeHtml(f.type)}</td>
      <td>${f.confidence}</td>
      <td><span class="val-code">${escapeHtml(truncate(f.value, 70))}</span></td>
      <td class="src-files">${files}</td>
    `;
    tr.addEventListener('click', () => openDrawer(f));
    findingsBody.appendChild(tr);
  });

  document.getElementById('findings-count-label').textContent =
    `${rows.length} finding${rows.length === 1 ? '' : 's'} shown (of ${allFindings.length} total)`;

  renderPager(totalPages);
  wireExports();
}

function renderPager(totalPages) {
  const pager = document.getElementById('pager');
  pager.innerHTML = '';
  if (totalPages <= 1) return;

  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (opts.active) b.classList.add('active');
    if (opts.disabled) b.disabled = true;
    b.addEventListener('click', () => { filterState.page = page; renderTable(currentFilteredRows()); });
    return b;
  };

  pager.appendChild(mkBtn('‹', Math.max(1, filterState.page - 1), { disabled: filterState.page === 1 }));
  const windowSize = 5;
  let startPage = Math.max(1, filterState.page - Math.floor(windowSize / 2));
  let endPage = Math.min(totalPages, startPage + windowSize - 1);
  startPage = Math.max(1, endPage - windowSize + 1);
  for (let p = startPage; p <= endPage; p++) {
    pager.appendChild(mkBtn(String(p), p, { active: p === filterState.page }));
  }
  pager.appendChild(mkBtn('›', Math.min(totalPages, filterState.page + 1), { disabled: filterState.page === totalPages }));
}

// re-derive currently filtered/sorted rows (cheap, avoids storing extra state)
function currentFilteredRows() {
  let rows = allFindings.filter((f) => {
    if (filterState.severity && f.severity !== filterState.severity) return false;
    if (filterState.category && f.category !== filterState.category) return false;
    if (filterState.verifyOnly && !f.needs_manual_verification) return false;
    if (filterState.search) {
      const blob = [f.type, f.category, f.value, ...(f.source_files || [])].join(' ').toLowerCase();
      if (!blob.includes(filterState.search)) return false;
    }
    return true;
  });
  const { sortKey, sortDir } = filterState;
  rows.sort((a, b) => {
    let av, bv;
    if (sortKey === 'severity') { av = SEV_ORDER[a.severity] || 0; bv = SEV_ORDER[b.severity] || 0; }
    else if (sortKey === 'confidence') { av = a.confidence; bv = b.confidence; }
    else { av = (a[sortKey] || '').toString().toLowerCase(); bv = (b[sortKey] || '').toString().toLowerCase(); }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

/* ---------------- export dropdown ---------------- */

function wireExports() {
  const toggle = document.getElementById('export-toggle');
  const menu = document.getElementById('export-menu');
  toggle.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  };
  document.querySelectorAll('#export-menu button').forEach((b) => {
    b.onclick = () => {
      if (!currentJobId) return;
      window.location = `/api/report/${currentJobId}/${b.dataset.fmt}`;
      menu.hidden = true;
    };
  });
}
document.addEventListener('click', () => {
  const menu = document.getElementById('export-menu');
  if (menu) menu.hidden = true;
});

/* ---------------- keyboard shortcuts ---------------- */

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    const activePane = document.querySelector('.tab-pane.active');
    if (activePane && activePane.id === 'pane-scan' && !document.getElementById('findings-toolbar').hidden) {
      e.preventDefault();
      document.getElementById('findings-search').focus();
    }
  }
  if (e.key === 'Escape') {
    closeDrawer();
  }
});

/* ---------------- detail drawer ---------------- */

const drawer = document.getElementById('detail-drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const drawerContent = document.getElementById('drawer-content');
const drawerClose = document.getElementById('drawer-close');

function openDrawer(f) {
  const notes = (f.validation && f.validation.notes) || [];
  const files = (f.source_files || []).map(shortUrl).join('<br>');
  let decodedHtml = '';
  if (f.validation && f.validation.decoded) {
    decodedHtml = kvBlock('Decoded JWT', JSON.stringify(f.validation.decoded, null, 2), true);
  }
  let probeHtml = '';
  if (f.validation && f.validation.endpoint_probe) {
    probeHtml = kvBlock('Endpoint probe', JSON.stringify(f.validation.endpoint_probe, null, 2), true);
  }
  const verifyFlag = f.needs_manual_verification ? '<span class="verify-flag">NEEDS MANUAL VERIFY</span>' : '';

  drawerContent.innerHTML = `
    <h3><span class="sev-badge sev-${f.severity}">${f.severity}</span> ${escapeHtml(f.type)} ${verifyFlag}</h3>
    ${kvBlock('Value', f.value)}
    <div class="kv"><div class="k">Confidence</div><div class="v">${f.confidence} / 100</div></div>
    <div class="kv"><div class="k">Category</div><div class="v">${escapeHtml(f.category)}</div></div>
    <div class="kv"><div class="k">Found in</div><div class="v">${files}</div></div>
    ${f.resolved_urls && f.resolved_urls.length ? `<div class="kv"><div class="k">Resolved URL${f.resolved_urls.length > 1 ? 's' : ''}</div><div class="v">${linkList(f.resolved_urls)}</div></div>` : ''}
    ${kvBlock('Context', f.context || '')}
    ${decodedHtml}
    ${probeHtml}
    <div class="kv"><div class="k">Validation notes</div>${notes.map((n) => `<div class="note">${escapeHtml(n)}</div>`).join('') || '<div class="note dim">none</div>'}</div>
  `;
  drawer.classList.add('open');
  drawerOverlay.classList.add('open');

  drawerContent.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, btn));
  });
}

function kvBlock(label, value, pre) {
  const id = 'copy-' + Math.random().toString(36).slice(2, 9);
  return `<div class="kv">
    <div class="k"><span>${escapeHtml(label)}</span><button class="copy-btn" data-copy="${escapeHtml(value)}">copy</button></div>
    <div class="v">${escapeHtml(value)}</div>
  </div>`;
}

function copyToClipboard(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = original; }, 1200);
  }).catch(() => toast('Copy failed', 'warn'));
}

function closeDrawer() {
  drawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
}
drawerClose.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

/* ---------------- history tab ---------------- */

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const rows = await res.json();
    renderHistory(rows);
  } catch (e) {
    toast('Failed to load history: ' + e.message, 'warn');
  }
}
document.getElementById('history-refresh').addEventListener('click', loadHistory);

function renderHistory(rows) {
  const countBadge = document.getElementById('history-count');
  countBadge.hidden = rows.length === 0;
  countBadge.textContent = rows.length;

  const empty = document.getElementById('history-empty');
  const wrap = document.getElementById('history-table-wrap');
  if (!rows.length) {
    empty.hidden = false;
    wrap.hidden = true;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const body = document.getElementById('history-body');
  body.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const started = new Date(r.started_at * 1000).toLocaleString();
    tr.innerHTML = `
      <td class="hist-target">${escapeHtml(r.target)}</td>
      <td class="dim">${started}</td>
      <td class="hist-count">${r.findings_count}</td>
      <td class="hist-count" style="color:var(--crit)">${r.critical_count}</td>
      <td class="hist-count" style="color:var(--high)">${r.high_count}</td>
      <td>
        <div class="hist-actions">
          <button class="btn-ghost" data-act="view">View</button>
          <button class="btn-ghost" data-act="delete">Delete</button>
        </div>
      </td>
    `;
    tr.querySelector('[data-act=view]').addEventListener('click', () => viewHistoryEntry(r.job_id));
    tr.querySelector('[data-act=delete]').addEventListener('click', () => deleteHistoryEntry(r.job_id));
    body.appendChild(tr);
  });
}

async function viewHistoryEntry(jobId) {
  try {
    const res = await fetch(`/api/history/${jobId}`);
    const data = await res.json();
    if (data.error) { toast(data.error, 'warn'); return; }
    currentJobId = jobId;
    readOnlyView = true;
    switchTab('scan');
    document.getElementById('target').value = data.target || '';
    consoleEl.innerHTML = '';
    log(`$ loaded saved scan: ${data.target}`, 'dim');
    resetPipeline();
    document.querySelectorAll('#pipeline-steps li').forEach((li) => li.classList.add('complete'));
    renderResults(data.findings || [], data.meta || {});
    toast('Loaded saved scan', 'info');
  } catch (e) {
    toast('Failed to load scan: ' + e.message, 'warn');
  }
}

async function deleteHistoryEntry(jobId) {
  if (!confirm('Delete this scan from history? This cannot be undone.')) return;
  try {
    await fetch(`/api/history/${jobId}`, { method: 'DELETE' });
    toast('Deleted', 'ok');
    loadHistory();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'warn');
  }
}

/* ---------------- compare tab ---------------- */

async function loadCompareOptions() {
  try {
    const res = await fetch('/api/history');
    const rows = await res.json();
    const optHtml = rows.map((r) => {
      const started = new Date(r.started_at * 1000).toLocaleString();
      return `<option value="${r.job_id}">${escapeHtml(r.target)} — ${started} (${r.findings_count} findings)</option>`;
    }).join('');
    const a = document.getElementById('diff-a');
    const b = document.getElementById('diff-b');
    a.innerHTML = optHtml;
    b.innerHTML = optHtml;
    if (rows.length > 1) { a.selectedIndex = 1; b.selectedIndex = 0; }
  } catch (e) {
    toast('Failed to load history for compare: ' + e.message, 'warn');
  }
}

document.getElementById('diff-run').addEventListener('click', async () => {
  const jobA = document.getElementById('diff-a').value;
  const jobB = document.getElementById('diff-b').value;
  if (!jobA || !jobB) { toast('Pick two scans to compare', 'warn'); return; }
  if (jobA === jobB) { toast('Pick two different scans', 'warn'); return; }
  try {
    const res = await fetch('/api/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_a: jobA, job_b: jobB }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'warn'); return; }
    renderDiff(data);
  } catch (e) {
    toast('Compare failed: ' + e.message, 'warn');
  }
});

function renderDiff(data) {
  const out = document.getElementById('diff-results');
  out.hidden = false;

  const newRows = (data.new || []).map(diffRowHtml).join('') || '<tr><td colspan="4" class="dim">None</td></tr>';
  const resolvedRows = (data.resolved || []).map(diffRowHtml).join('') || '<tr><td colspan="4" class="dim">None</td></tr>';

  out.innerHTML = `
    <div class="diff-summary">
      <div class="diff-stat new"><div class="num">${data.new_count}</div><div class="label">New</div></div>
      <div class="diff-stat resolved"><div class="num">${data.resolved_count}</div><div class="label">Resolved</div></div>
      <div class="diff-stat persisting"><div class="num">${data.persisting_count}</div><div class="label">Persisting</div></div>
    </div>
    <div class="diff-section">
      <h4>New findings (introduced since baseline)</h4>
      <div class="table-scroll"><table class="findings-table">
        <thead><tr><th>Severity</th><th>Type</th><th>Confidence</th><th>Value</th></tr></thead>
        <tbody>${newRows}</tbody>
      </table></div>
    </div>
    <div class="diff-section">
      <h4>Resolved findings (present in baseline, gone now)</h4>
      <div class="table-scroll"><table class="findings-table">
        <thead><tr><th>Severity</th><th>Type</th><th>Confidence</th><th>Value</th></tr></thead>
        <tbody>${resolvedRows}</tbody>
      </table></div>
    </div>
  `;
}

function diffRowHtml(f) {
  return `<tr>
    <td><span class="sev-badge sev-${f.severity}">${f.severity}</span></td>
    <td>${escapeHtml(f.type)}</td>
    <td>${f.confidence}</td>
    <td><span class="val-code">${escapeHtml(truncate(f.value, 60))}</span></td>
  </tr>`;
}

/* ---------------- helpers ---------------- */

function shortUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.pathname.length > 40 ? '...' + parsed.pathname.slice(-40) : parsed.pathname;
  } catch (e) {
    return u;
  }
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Render a list of URLs as full, clickable links. Only http/https/ws(s) URLs
// become anchors; anything else is shown as plain text. stopPropagation keeps
// a link click from also opening the row's detail drawer.
function linkList(urls) {
  if (!urls || !urls.length) return '<span class="dim">—</span>';
  return urls.map((u) => {
    const txt = escapeHtml(u);
    const attr = escapeAttr(u);
    if (/^(https?|wss?):\/\//i.test(u)) {
      return `<a class="src-link" href="${attr}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${attr}">${txt}</a>`;
    }
    return `<span title="${attr}">${txt}</span>`;
  }).join('<br>');
}
