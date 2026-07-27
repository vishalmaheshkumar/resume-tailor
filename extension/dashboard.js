(function () {
  'use strict';

  let allJobs = [];
  let activeStatus = '';
  let activeSite = '';
  let searchTerm = '';

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function applyFilters() {
    return allJobs.filter((job) => {
      if (activeStatus && job.status !== activeStatus) return false;
      if (activeSite && job.site !== activeSite) return false;
      if (searchTerm) {
        const haystack = `${job.title} ${job.company}`.toLowerCase();
        if (!haystack.includes(searchTerm.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
  }

  function renderCounts() {
    const counts = { new: 0, ready: 0, applied: 0, skipped: 0 };
    allJobs.forEach((j) => { if (counts[j.status] !== undefined) counts[j.status]++; });
    document.getElementById('dash-counts').innerHTML =
      `<strong>${allJobs.length}</strong> total · ${counts.new} new · ${counts.ready} ready · ` +
      `${counts.applied} applied · ${counts.skipped} skipped`;
  }

  function renderSiteOptions() {
    const select = document.getElementById('dash-site-filter');
    const sites = [...new Set(allJobs.map((j) => j.site).filter(Boolean))].sort();
    const current = select.value;
    select.innerHTML = '<option value="">All sites</option>' +
      sites.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    select.value = sites.includes(current) ? current : '';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }

  function render() {
    const rows = applyFilters();
    const tbody = document.getElementById('dash-rows');
    const empty = document.getElementById('dash-empty');

    if (!allJobs.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = 'No jobs in the store yet — run a scan or single-job extraction from the side panel first.';
      renderCounts();
      return;
    }
    if (!rows.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = 'No jobs match the current filters.';
      renderCounts();
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = rows.map((job) => {
      const isLinkedInWrapped = (job.apply_url || '').includes('linkedin.com');
      const needsResolve = job.site === 'linkedin' && job.apply_type === 'external' && job.job_id;
      return `
      <tr data-key="${escapeHtml(job.job_key)}">
        <td class="dash-cell-title">
          ${job.url ? `<a class="dash-link" href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title || 'Untitled role')}</a>` : escapeHtml(job.title || 'Untitled role')}
        </td>
        <td>${escapeHtml(job.company || '—')}</td>
        <td>${escapeHtml(job.location || '—')}</td>
        <td>${escapeHtml(job.site || '—')}</td>
        <td><span class="dash-badge dash-badge-${job.apply_type || 'unknown'}">${
          job.apply_type === 'easy_apply' ? '⚡ Easy Apply' : job.apply_type === 'external' ? '🔗 External' : '? Unknown'
        }</span></td>
        <td class="dash-cell-sub" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${job.apply_url ? escapeHtml(job.apply_url) : '—'}
          ${isLinkedInWrapped && needsResolve ? '<div style="color:#f59e0b;">⚠️ unresolved (LinkedIn link)</div>' : ''}
        </td>
        <td>
          <select class="dash-status-select s-${job.status}" data-key="${escapeHtml(job.job_key)}">
            <option value="new" ${job.status === 'new' ? 'selected' : ''}>New</option>
            <option value="ready" ${job.status === 'ready' ? 'selected' : ''}>Ready</option>
            <option value="applied" ${job.status === 'applied' ? 'selected' : ''}>Applied</option>
            <option value="skipped" ${job.status === 'skipped' ? 'selected' : ''}>Skipped</option>
          </select>
        </td>
        <td class="dash-cell-sub">${fmtDate(job.last_seen_at || job.scraped_at)}</td>
        <td style="white-space:nowrap;">
          ${job.apply_url ? `<button class="dash-open-btn" data-url="${escapeHtml(job.apply_url)}">Open ↗</button>` : ''}
          ${needsResolve ? `<button class="dash-open-btn" data-resolve-key="${escapeHtml(job.job_key)}" data-job-title="${escapeHtml(job.title)}" data-job-company="${escapeHtml(job.company)}" title="Click through LinkedIn's Apply link and capture the real destination">🔗 Resolve</button>` : ''}
          <button class="dash-open-btn" data-edit-key="${escapeHtml(job.job_key)}" title="Paste the real apply URL yourself">✏️</button>
        </td>
      </tr>
    `;
    }).join('');

    tbody.querySelectorAll('.dash-status-select').forEach((sel) => {
      sel.onchange = async () => {
        await window.RTJobStore.setStatus(sel.dataset.key, sel.value);
        const job = allJobs.find((j) => j.job_key === sel.dataset.key);
        if (job) job.status = sel.value;
        sel.className = 'dash-status-select s-' + sel.value;
        renderCounts();
      };
    });

    tbody.querySelectorAll('.dash-open-btn').forEach((btn) => {
      if (btn.dataset.url) {
        btn.onclick = () => window.open(btn.dataset.url, '_blank');
      } else if (btn.dataset.resolveKey) {
        btn.onclick = () => resolveApplyUrl(btn.dataset.resolveKey, btn.dataset.jobTitle, btn.dataset.jobCompany);
      } else if (btn.dataset.editKey) {
        btn.onclick = () => manualEditApplyUrl(btn.dataset.editKey);
      }
    });
  }

  async function loadJobs() {
    allJobs = await window.RTJobStore.getAllJobs();
    renderSiteOptions();
    render();
  }

  async function manualEditApplyUrl(jobKey) {
    const job = allJobs.find((j) => j.job_key === jobKey);
    const current = job?.apply_url || '';
    const url = prompt('Paste the real apply URL for this job:', current);
    if (!url || url === current) return;
    await window.RTJobStore.setApplyUrl(jobKey, url);
    if (job) job.apply_url = url;
    render();
  }

  // Opens the LinkedIn job's own page (a stable direct URL, independent of search-result
  // context), waits for it to load, then has content.js click the Apply link and report back.
  // The actual resolved destination arrives later via the RT_APPLY_URL_RESOLVED broadcast from
  // background.js, once it's tracked the click-through to wherever it really lands.
  // Follows the SAME path the scanner used: reuse whichever LinkedIn search-results tab is
  // already open and let content.js click that job's card in the list (React state update,
  // same as the scanner) — never navigate to a direct /jobs/view/<id>/ URL, which doesn't have
  // the search layout's lazy-column structure and breaks detail-panel detection.
  async function getLinkedInTab() {
    const [tab] = await chrome.tabs.query({ url: '*://*.linkedin.com/*' });
    if (!tab) return null;
    await chrome.tabs.update(tab.id, { active: true });
    return tab;
  }

  async function resolveApplyUrl(jobKey, jobTitle, jobCompany) {
    const status = document.getElementById('dash-counts');
    const prevText = status.innerHTML;
    status.innerHTML = `<strong>Resolving…</strong> looking for an open LinkedIn tab…`;

    try {
      const tab = await getLinkedInTab();
      if (!tab) {
        status.innerHTML = '❌ No LinkedIn tab open — open the search-results page you scanned this job from and try again.';
        setTimeout(() => { status.innerHTML = prevText; }, 5000);
        return;
      }

      let result;
      try {
        result = await chrome.tabs.sendMessage(tab.id, { type: 'RT_RESOLVE_APPLY_URL', jobKey, jobTitle, jobCompany });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        result = await chrome.tabs.sendMessage(tab.id, { type: 'RT_RESOLVE_APPLY_URL', jobKey, jobTitle, jobCompany });
      }

      if (!result?.ok) {
        status.innerHTML = `❌ ${result?.error || 'Could not click Apply on that page.'}`;
      } else if (result.apply_type === 'easy_apply') {
        status.innerHTML = `⚡ ${result.message}`;
      } else {
        status.innerHTML = `🔗 Clicked Apply — waiting for the destination to settle…`;
      }
    } catch (err) {
      status.innerHTML = `❌ ${err.message}`;
    }

    setTimeout(() => { status.innerHTML = prevText; }, 4000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'RT_APPLY_URL_RESOLVED') return;
    const job = allJobs.find((j) => j.job_key === msg.jobKey);
    if (job) job.apply_url = msg.url;
    render();
    const status = document.getElementById('dash-counts');
    const prevText = status.innerHTML;
    status.innerHTML = `✅ Resolved: ${msg.url.slice(0, 80)}`;
    setTimeout(() => { status.innerHTML = prevText; }, 5000);
  });

  function init() {
    document.getElementById('dash-search').oninput = (e) => {
      searchTerm = e.target.value;
      render();
    };

    document.querySelectorAll('.dash-pill').forEach((pill) => {
      pill.onclick = () => {
        document.querySelectorAll('.dash-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        activeStatus = pill.dataset.status;
        render();
      };
    });

    document.getElementById('dash-site-filter').onchange = (e) => {
      activeSite = e.target.value;
      render();
    };

    document.getElementById('dash-refresh').onclick = loadJobs;
    document.getElementById('dash-export').onclick = async () => {
      const n = await window.RTJobStore.exportAllAsJson();
      alert(`Exported ${n} job(s).`);
    };

    loadJobs();
  }

  init();
})();
