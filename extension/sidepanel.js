// This page (sidepanel.html) is rendered by Chrome's native Side Panel API — its own document,
// in its own browser-chrome surface. It never touches the job page's DOM or CSS at all. The only
// connection to the page is via chrome.tabs.sendMessage to content.js, purely to read JD text.
(function () {
  'use strict';

  const BACKEND_URL = 'https://resume-tailor-production-2dcf.up.railway.app';

  const TRACK_LABELS = {
    fulltime_dev: 'Full-Time — Developer / Engineer',
    werk_dev:     'Werkstudent / Intern — Developer / IT',
    werk_pm:      'Werkstudent / Intern — PM / Strategy / EA',
    fulltime_pm:  'Full-Time — Product Manager',
  };

  const PROJECT_LABELS = {
    P1: 'Formula Student Hybrid',
    P2: 'WIRIN @ IISc',
    P3: 'IoT Research',
    P4: 'AI Resume Tool',
    P5: 'Job Scanner',
    P6: 'BlastMap AI',
    P7: 'MCP Prototype',
    P8: 'Wolflayer',
    P9: 'TÜV SÜD Capability Mapping',
  };

  let analysisData = null;
  let lastExtractedUrl = null;
  // Last AI-generated PROFESSIONAL SUMMARY text per "track:lang", so the online editor can seed
  // itself with what's actually in the PDF you just downloaded instead of the static template default.
  let lastSummaryByKey = {};

  function setStatus(msg, color) {
    const el = document.getElementById('rt-status');
    el.innerHTML = msg;
    el.style.color = color || '#8b87a8';
  }

  function detectSiteLabel(url) {
    try {
      const h = new URL(url).hostname;
      if (h.includes('linkedin.com'))    return 'LinkedIn';
      if (h.includes('greenhouse.io'))   return 'Greenhouse';
      if (h.includes('lever.co'))        return 'Lever';
      if (h.includes('myworkday') || h.includes('workday.com')) return 'Workday';
      if (h.includes('indeed.'))         return 'Indeed';
      if (h.includes('stepstone'))       return 'StepStone';
      return h;
    } catch (_) {
      return 'Job Page';
    }
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO-EXTRACT — ask content.js to read the current tab's JD, then analyze
  // ─────────────────────────────────────────────────────────────
  async function sendExtractMessage(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'RT_EXTRACT' });
    } catch (_) {
      // "Could not establish connection" almost always means content.js never attached —
      // typically because this tab was already open before the extension was installed/reloaded.
      // Inject it on demand and retry once, instead of just failing.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return await chrome.tabs.sendMessage(tabId, { type: 'RT_EXTRACT' });
      } catch (err2) {
        console.warn('[Resume Tailor] content script injection retry failed:', err2);
        return null;
      }
    }
  }

  async function runExtract() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('⚠️ No active tab found.', '#f59e0b');
      return;
    }

    document.getElementById('rt-site-label').textContent = detectSiteLabel(tab.url || '');
    lastExtractedUrl = tab.url;

    const response = await sendExtractMessage(tab.id);
    if (!response) {
      setStatus('⚠️ Could not read this page — reload the tab, then click Re-extract.', '#f59e0b');
      return;
    }

    const { title, company, jd } = response;
    if (!jd || jd.length < 40) {
      setStatus('⚠️ Could not find job text on this page — paste the JD manually.', '#f59e0b');
      return;
    }

    document.getElementById('rt-jd').value = jd.slice(0, 10000);
    if (company) document.getElementById('rt-company').value = company;
    if (title)   document.getElementById('rt-title').value = title;

    // No auto-analyze — extraction just fills the fields. You click "Analyze JD" when you
    // actually want to spend an API call on a job, instead of every tab switch triggering one.
    const found = [`JD ✓`, company ? `Company ✓ (${company})` : `Company ✗`, title ? `Title ✓` : `Title ✗`];
    const allFound = company && title;
    setStatus(`✅ Extracted — ${found.join(', ')}. Click "Analyze JD" when ready.`, allFound ? '#10b981' : '#f59e0b');
  }

  // ─────────────────────────────────────────────────────────────
  // BACKEND CALLS — plain fetch (this page is a normal extension document, not a userscript;
  // the backend's CORS config explicitly exposes X-Cover-Letter-Pdf for this to work cross-origin)
  // ─────────────────────────────────────────────────────────────
  async function callBackend(path, payload, wantBlob) {
    const res = await fetch(BACKEND_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = `Server ${res.status}`;
      try { const e = await res.json(); detail = e.detail || detail; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }

    if (wantBlob) {
      const blob = await res.blob();
      const clB64 = res.headers.get('X-Cover-Letter-Pdf');
      if (clB64) {
        try {
          const bin = atob(clB64.trim());
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          blob._coverLetterPdf = new Blob([buf], { type: 'application/pdf' });
        } catch (err) { console.warn('CL PDF decode failed:', err); }
      }
      const summaryB64 = res.headers.get('X-Summary-B64');
      if (summaryB64) {
        try { blob._summaryText = decodeURIComponent(escape(atob(summaryB64.trim()))); }
        catch (err) { console.warn('Summary decode failed:', err); }
      }
      return blob;
    }
    return res.json();
  }

  async function callBackendGet(path) {
    const res = await fetch(BACKEND_URL + path);
    if (!res.ok) {
      let detail = `Server ${res.status}`;
      try { const e = await res.json(); detail = e.detail || detail; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

  // ─────────────────────────────────────────────────────────────
  // ANALYZE — Stage 1
  // ─────────────────────────────────────────────────────────────
  async function runAnalyze() {
    const jd      = document.getElementById('rt-jd').value.trim();
    const company = document.getElementById('rt-company').value.trim();

    if (!jd) { setStatus('⚠️ Paste a job description first.', '#f59e0b'); return; }

    const btn = document.getElementById('rt-analyze');
    btn.disabled = true;
    btn.textContent = '⏳ Analyzing JD…';
    setStatus('Analyzing fit, keywords, and track…');

    try {
      analysisData = await callBackend('/analyze', { jd, company });
      renderAnalysis(analysisData);

      if (analysisData.track_suggestion) {
        document.getElementById('rt-track').value = analysisData.track_suggestion;
      }

      setStatus('✅ Analysis done. Review below, adjust track if needed, then generate.', '#10b981');
    } catch (err) {
      setStatus('❌ ' + err.message, '#ef4444');
    }

    btn.disabled = false;
    btn.textContent = '🔍 Re-Analyze';
  }

  // ─────────────────────────────────────────────────────────────
  // RENDER ANALYSIS
  // ─────────────────────────────────────────────────────────────
  function renderAnalysis(a) {
    const box = document.getElementById('rt-analysis');
    const score = a.fit_score || 0;
    const scoreColor = score >= 8 ? '#10b981' : score >= 5 ? '#f59e0b' : '#ef4444';
    const scoreEmoji = score >= 8 ? '✅' : score >= 5 ? '⚠️' : '🚫';

    const keywordBadges = (a.ats_keywords || []).map(k =>
      `<span class="rt-badge rt-badge-ok">${escapeHtml(k)}</span>`
    ).join('');

    const missingBadges = (a.missing_keywords || []).map(k =>
      `<span class="rt-badge rt-badge-missing">${escapeHtml(k)}</span>`
    ).join('');

    const projectBadges = (a.projects || []).map(p =>
      `<span class="rt-badge rt-badge-project">${p}: ${escapeHtml(PROJECT_LABELS[p] || p)}</span>`
    ).join('');

    box.innerHTML = `
      <div class="rt-section-label" style="margin-bottom:10px;">Job Analysis</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
        <span style="font-size:10.5px;font-weight:700;color:#8b87a8;letter-spacing:.8px;">FIT SCORE</span>
        <span style="color:${scoreColor};font-size:16px;font-weight:700;">${scoreEmoji} ${score}/10</span>
      </div>
      <div style="font-size:11px;color:#a0a0b8;line-height:1.5;margin-bottom:10px;font-style:italic;">
        ${escapeHtml(a.fit_rationale || '')}
      </div>

      <div class="rt-section-label" style="margin-bottom:4px;">Suggested Track</div>
      <div style="font-size:12px;color:#c4b5fd;margin-bottom:10px;">${escapeHtml(TRACK_LABELS[a.track_suggestion] || a.track_suggestion || '—')}</div>

      <div class="rt-section-label" style="margin-bottom:4px;">ATS Keywords</div>
      <div style="margin-bottom:10px;">${keywordBadges || '<span style="color:#6e6a8a;font-size:11px;">none detected</span>'}</div>

      <div class="rt-section-label" style="margin-bottom:4px;">Missing Keywords</div>
      <div style="margin-bottom:10px;">${missingBadges || '<span style="color:#6e6a8a;font-size:11px;">no notable gaps</span>'}</div>

      <div class="rt-section-label" style="margin-bottom:4px;">Projects to Emphasize</div>
      <div>${projectBadges || '<span style="color:#6e6a8a;font-size:11px;">none selected</span>'}</div>
    `;
    box.style.display = 'block';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─────────────────────────────────────────────────────────────
  // TAILOR — Stage 2
  // ─────────────────────────────────────────────────────────────
  async function runTailor() {
    const jd           = document.getElementById('rt-jd').value.trim();
    const track        = document.getElementById('rt-track').value;
    const customTitle  = document.getElementById('rt-title').value.trim();
    const company      = document.getElementById('rt-company').value.trim();
    const resumeLang   = document.getElementById('rt-resume-lang').value || 'en';
    const specialInstr = document.getElementById('rt-special').value.trim();
    const wantCL       = document.getElementById('rt-cl').checked;
    const lang         = document.getElementById('rt-lang').value || 'en';

    if (!jd) { setStatus('⚠️ Paste a job description first.', '#f59e0b'); return; }

    const btn = document.getElementById('rt-go');
    btn.disabled = true;
    btn.textContent = '⏳ Generating…';

    if (analysisData && analysisData.fit_score && analysisData.fit_score <= 3) {
      if (!confirm(`⚠️ Fit score is ${analysisData.fit_score}/10 — weak match.\n\nContinue anyway?`)) {
        btn.disabled = false;
        btn.textContent = '✨ Generate Tailored Resume';
        return;
      }
    }

    setStatus('Tailoring resume + generating PDF… (10–20s)');

    try {
      const payload = {
        jd, track,
        custom_title:         customTitle,
        company,
        resume_lang:          resumeLang,
        special_instructions: specialInstr,
        cover_letter:         wantCL,
        cl_lang:              lang,
        fit_score:            analysisData?.fit_score    || 7,
        ats_keywords:         analysisData?.ats_keywords || [],
        projects:             analysisData?.projects     || [],
      };

      const pdfBlob = await callBackend('/tailor', payload, true);

      if (pdfBlob._summaryText) {
        lastSummaryByKey[`${track}:${resumeLang}`] = pdfBlob._summaryText;
      }

      const companySlug = company.replace(/[^a-zA-Z0-9]/g,'_').slice(0,30);
      const roleSlug = ({
        fulltime_dev: 'FT_Dev',
        werk_dev:     'Werk_Dev',
        werk_pm:      'Werk_PM',
        fulltime_pm:  'FT_PM',
      }[track]) || 'Resume';
      const filename = companySlug
        ? `Vishal_${companySlug}_${roleSlug}.pdf`
        : `Vishal_Resume_${roleSlug}.pdf`;

      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      setStatus(`✅ <strong>${filename}</strong> downloaded!`, '#10b981');

      if (wantCL && pdfBlob._coverLetterPdf) {
        const clName = companySlug
          ? `Vishal_${companySlug}_${roleSlug}_CoverLetter.pdf`
          : `Vishal_CoverLetter_${roleSlug}.pdf`;
        const clUrl = URL.createObjectURL(pdfBlob._coverLetterPdf);
        const b = document.createElement('a');
        b.href = clUrl; b.download = clName;
        setTimeout(() => { b.click(); setTimeout(() => URL.revokeObjectURL(clUrl), 5000); }, 600);
        setStatus(`✅ <strong>${filename}</strong> + <strong>${clName}</strong> downloaded!`, '#10b981');
      }

    } catch (err) {
      setStatus('❌ ' + err.message, '#ef4444');
    }

    btn.disabled = false;
    btn.textContent = '✨ Generate Tailored Resume';
  }

  // ─────────────────────────────────────────────────────────────
  // BULK SCAN — walks a LinkedIn search-results page (+ pagination) via content.js, opening
  // each job card and collecting title/company/location/JD. No /analyze calls are made here —
  // results just populate a pick list; clicking one loads it into the normal single-job fields,
  // where Analyze stays fully optional before Generate, same as the regular flow.
  // ─────────────────────────────────────────────────────────────
  let scanResults = [];
  let scanInProgress = false;
  let autoLaunchMode = false;
  let autoLaunchedJobKeys = new Set();

  function renderScanResults() {
    const box = document.getElementById('rt-scan-results');
    if (!scanResults.length) { box.innerHTML = ''; return; }
    box.innerHTML = scanResults.map((job, i) => `
      <div class="rt-scan-row" data-idx="${i}" style="${job.already_seen ? 'opacity:.55;' : ''}">
        <div class="rt-scan-row-text">
          <div class="rt-scan-row-title">${escapeHtml(job.title || 'Untitled role')}</div>
          <div class="rt-scan-row-sub">${escapeHtml(job.company || '—')}${job.location ? ' · ' + escapeHtml(job.location) : ''}
            ${job.apply_type === 'easy_apply' ? ' · ⚡ Easy Apply' : job.apply_type === 'external' ? ' · 🔗 External' : ''}
            ${job.already_seen ? ' · seen before' : ''}
          </div>
        </div>
        <button class="rt-scan-row-use" data-autoprep-idx="${i}" style="background:none;border:none;cursor:pointer;">🚀 Auto-Prep</button>
        <span class="rt-scan-row-use">Use →</span>
      </div>
    `).join('');
    box.querySelectorAll('.rt-scan-row').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-autoprep-idx]')) return; // Auto-Prep handled separately below
        const job = scanResults[Number(row.dataset.idx)];
        if (!job) return;
        document.getElementById('rt-jd').value = (job.jd || '').slice(0, 10000);
        document.getElementById('rt-company').value = job.company || '';
        document.getElementById('rt-title').value = job.title || '';
        setStatus(`✅ Loaded "${job.title}" — click Analyze (optional) or Generate.`, '#10b981');
      };
    });
    box.querySelectorAll('[data-autoprep-idx]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const job = scanResults[Number(btn.dataset.autoprepIdx)];
        if (job) launchAutoPrep(job);
      };
    });
  }

  function setScanStatus(msg) {
    document.getElementById('rt-scan-status').textContent = msg || '';
  }

  async function startBulkScan({ autoLaunch = false } = {}) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) { setScanStatus('⚠️ No active tab found.'); return; }

    const maxPages = Math.max(1, parseInt(document.getElementById('rt-scan-pages').value, 10) || 3);
    const maxJobs  = Math.max(1, parseInt(document.getElementById('rt-scan-jobs').value, 10) || 30);
    // Auto-Launch mode needs the apply click to happen WHILE content.js is still sitting on that
    // job's card/detail panel (the same safe path the "resolve external apply links" toggle already
    // uses) — re-locating cards afterward to click Apply would race against the scan loop still
    // moving through the list on the same tab.
    const resolveApplyLinks = autoLaunch || document.getElementById('rt-scan-resolve').checked;

    autoLaunchMode = autoLaunch;
    autoLaunchedJobKeys = new Set();
    scanResults = [];
    renderScanResults();
    scanInProgress = true;
    document.getElementById('rt-scan-start').style.display = 'none';
    document.getElementById('rt-scan-launch').style.display = 'none';
    document.getElementById('rt-scan-stop').style.display = 'block';
    setScanStatus(autoLaunch ? 'Starting scan + auto-launch…' : 'Starting scan…');

    try {
      const response = await sendBulkMessage(tab.id, { type: 'RT_BULK_SCAN_START', options: { maxPages, maxJobs, resolveApplyLinks, autoLaunch } });
      const rawResults = response?.results || [];

      let newCount = 0, seenCount = 0;
      if (autoLaunchMode) {
        // Each job was already upserted (and, if new, auto-launched) the moment it streamed in via
        // RT_BULK_SCAN_PROGRESS below — re-upserting here would see it as "already seen" a second
        // time and wreck the new/seen count, so just read back the flags that path already set.
        for (const job of rawResults) { if (job.already_seen) seenCount++; else newCount++; }
      } else {
        // Dedupe against the offline job store: don't keep re-surfacing jobs already scraped in a
        // past session. Each job still gets upserted (refreshing JD/apply info) even if seen before
        // — only the visible "new" count changes, status is never reset on a re-scan.
        for (const job of rawResults) {
          const { inserted } = await window.RTJobStore.upsertJob(job);
          job.already_seen = !inserted;
          if (inserted) newCount++; else seenCount++;
        }
      }
      scanResults = rawResults;
      renderScanResults();
      setScanStatus(`✅ Done — ${newCount} new, ${seenCount} already seen (${scanResults.length} total).` +
        (autoLaunchMode ? ` Auto-launched ${newCount} job(s) — see Auto-Prep Tasks above.` : ''));
    } catch (err) {
      setScanStatus('❌ ' + err.message);
    }

    scanInProgress = false;
    autoLaunchMode = false;
    document.getElementById('rt-scan-start').style.display = 'block';
    document.getElementById('rt-scan-launch').style.display = 'block';
    document.getElementById('rt-scan-stop').style.display = 'none';
  }

  async function sendBulkMessage(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // APPLICATION AUTOFILL — runs on whatever page is currently active (the application form),
  // not the job-tailoring fields above. content.js does the extraction/fill; the Gemini call
  // happens server-side via POST /autofill, so no API key ever ships in this extension.
  // ─────────────────────────────────────────────────────────────
  async function runAutofillOnPage() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      document.getElementById('rt-autofill-status').textContent = '⚠️ No active tab found.';
      return;
    }

    const btn = document.getElementById('rt-autofill-start');
    const statusEl = document.getElementById('rt-autofill-status');
    btn.disabled = true;
    btn.textContent = '⏳ Filling…';
    statusEl.textContent = 'Reading form fields and asking Gemini…';

    try {
      const result = await sendBulkMessage(tab.id, { type: 'RT_AUTOFILL' });
      if (!result || !result.ok) {
        statusEl.textContent = '❌ ' + (result?.error || 'Autofill failed.');
      } else {
        statusEl.textContent = `✅ Filled ${result.filled}/${result.total} field(s)` +
          (result.failed ? ` · ${result.failed} couldn't be matched` : '') +
          ' · password fields skipped.';
      }
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
    }

    btn.disabled = false;
    btn.textContent = '🤖 AI Autofill This Page';
  }

  async function stopBulkScan() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    setScanStatus('Stopping…');
    try { await chrome.tabs.sendMessage(tab.id, { type: 'RT_BULK_SCAN_STOP' }); } catch (_) { /* ignore */ }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'RT_BULK_SCAN_PROGRESS') return;
    if (Array.isArray(msg.partialResults)) {
      scanResults = msg.partialResults;
      renderScanResults();
      if (autoLaunchMode) {
        for (const job of msg.partialResults) {
          const key = window.RTJobStore.jobKey(job);
          if (autoLaunchedJobKeys.has(key)) continue;
          autoLaunchedJobKeys.add(key);
          maybeAutoLaunch(job); // fire-and-forget — scan loop must not wait on doc generation
        }
      }
    }
    const parts = [];
    if (msg.page) parts.push(`Page ${msg.page}`);
    if (msg.jobIndex && msg.totalOnPage) parts.push(`job ${msg.jobIndex}/${msg.totalOnPage}`);
    if (typeof msg.totalScraped === 'number') parts.push(`${msg.totalScraped} scraped`);
    setScanStatus((msg.status ? msg.status + ' — ' : '') + parts.join(' · '));
  });

  // ─────────────────────────────────────────────────────────────
  // AUTO-PREP — per job: open it, resolve the real apply link if external, auto-generate +
  // download the tailored resume/cover letter from that job's JD directly (never touching the
  // shared Company/Title/JD fields above, so concurrent jobs can't clobber each other's state).
  // Each call is a fully independent async task — launching another while one is still running
  // is exactly the point; nothing here is awaited by the caller.
  // ─────────────────────────────────────────────────────────────
  let autoPrepTasks = []; // { id, job, statusText, awaitingLangChoice, resolveLangChoice }
  let autoPrepTaskSeq = 0;

  function detectLanguage(text) {
    const sample = (text || '').slice(0, 2000).toLowerCase();
    const deMarkers = [' der ', ' die ', ' das ', ' und ', ' für ', ' mit ', ' sie ', ' ich ', ' nicht ', ' werden', 'ä', 'ö', 'ü', 'ß'];
    const enMarkers = [' the ', ' and ', ' you ', ' with ', ' for ', ' our ', ' are ', ' will '];
    let deScore = 0, enScore = 0;
    deMarkers.forEach((m) => { if (sample.includes(m)) deScore++; });
    enMarkers.forEach((m) => { if (sample.includes(m)) enScore++; });
    if (enScore > deScore) return 'en';
    return 'de'; // German JD, or a tie — German is the default per spec
  }

  function renderAutoPrepTasks() {
    const card = document.getElementById('rt-tasks-card');
    const list = document.getElementById('rt-tasks-list');
    card.style.display = autoPrepTasks.length ? 'block' : 'none';
    list.innerHTML = autoPrepTasks.map((t) => `
      <div class="rt-task-row" data-task-id="${t.id}">
        <div class="rt-task-title">${escapeHtml(t.job.title || 'Untitled role')} — ${escapeHtml(t.job.company || '—')}</div>
        <div class="rt-task-status">${escapeHtml(t.statusText)}</div>
        ${t.destStatus ? `<div class="rt-task-status">${escapeHtml(t.destStatus)}</div>` : ''}
        ${(t.resumeUrl || t.clUrl) ? `
          <div class="rt-task-links">
            ${t.resumeUrl ? `<a href="${t.resumeUrl}" download="${escapeHtml(t.resumeFilename)}" class="rt-task-dl-link">📄 Resume</a>` : ''}
            ${t.clUrl ? `<a href="${t.clUrl}" download="${escapeHtml(t.clFilename)}" class="rt-task-dl-link">✉️ Cover Letter</a>` : ''}
          </div>` : ''}
        ${t.destTabId ? `
          <div class="rt-task-links">
            <button class="rt-task-dl-link" data-open-tab-id="${t.id}">🔗 Open that tab</button>
            ${t.awaitingManualAuth ? `<button class="rt-task-dl-link" data-resume-task-id="${t.id}">✅ I've signed in — Autofill now</button>` : ''}
          </div>` : ''}
        ${t.awaitingLangChoice ? `
          <div class="rt-task-lang-choice">
            <button class="rt-task-lang-btn" data-task-id="${t.id}" data-lang="en">Generate in English</button>
            <button class="rt-task-lang-btn" data-task-id="${t.id}" data-lang="de">Generate in German</button>
          </div>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('.rt-task-lang-btn').forEach((btn) => {
      btn.onclick = () => {
        const task = autoPrepTasks.find((t) => t.id === Number(btn.dataset.taskId));
        if (task && task.resolveLangChoice) task.resolveLangChoice(btn.dataset.lang);
      };
    });
    list.querySelectorAll('[data-open-tab-id]').forEach((btn) => {
      btn.onclick = () => {
        const task = autoPrepTasks.find((t) => t.id === Number(btn.dataset.openTabId));
        if (task && task.destTabId) focusTab(task.destTabId);
      };
    });
    list.querySelectorAll('[data-resume-task-id]').forEach((btn) => {
      btn.onclick = () => {
        const task = autoPrepTasks.find((t) => t.id === Number(btn.dataset.resumeTaskId));
        if (task && task.resolveManualAuth) task.resolveManualAuth();
      };
    });
    updateAttentionBadge();
  }

  function updateTask(task, statusText, awaitingLangChoice) {
    task.statusText = statusText;
    task.awaitingLangChoice = !!awaitingLangChoice;
    renderAutoPrepTasks();
  }

  function updateDestStatus(task, destStatus, awaitingManualAuth) {
    task.destStatus = destStatus;
    task.awaitingManualAuth = !!awaitingManualAuth;
    renderAutoPrepTasks();
  }

  // Toolbar badge: count of tasks genuinely waiting on a human right now (sign-in/signup wall,
  // a language choice, or "couldn't figure this one out") — the at-a-glance signal for "go check
  // the side panel" without needing it open.
  function updateAttentionBadge() {
    const count = autoPrepTasks.filter((t) =>
      t.awaitingLangChoice || t.awaitingManualAuth || (t.destStatus || '').startsWith('⚠️')
    ).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }

  function notifyUser(title, message) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon128.png'),
        title,
        message,
        priority: 2,
      });
    } catch (_) { /* best effort — never let a notification failure break the pipeline */ }
  }

  async function focusTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    } catch (_) { /* tab may have been closed by the user already */ }
  }

  // Triggers the auto-download AND returns the object URL so the caller can keep it alive for a
  // manual "Download" link in the task row — Chrome silently blocks auto-downloads past the first
  // couple from the same origin in one burst, so the link is the fallback when that happens.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    return url;
  }

  async function generateDocsForJob(task, lang) {
    const job = task.job;
    const { track, specialInstr } = task; // snapshotted at launch, not re-read here — a later
    // language-choice prompt must not pick up whatever the Track dropdown happens to say by the
    // time the user answers, especially with other jobs running concurrently.

    updateTask(task, `Generating ${lang.toUpperCase()} resume + cover letter…`);
    try {
      const payload = {
        jd: job.jd, track,
        custom_title: job.title || '',
        company: job.company || '',
        resume_lang: lang,
        special_instructions: specialInstr,
        cover_letter: true,
        cl_lang: lang,
        fit_score: 7, ats_keywords: [], projects: [],
      };
      const pdfBlob = await callBackend('/tailor', payload, 'blob');

      const companySlug = (job.company || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const roleSlug = ({ fulltime_dev: 'FT_Dev', werk_dev: 'Werk_Dev', werk_pm: 'Werk_PM', fulltime_pm: 'FT_PM' }[track]) || 'Resume';
      const filename = companySlug ? `Vishal_${companySlug}_${roleSlug}.pdf` : `Vishal_Resume_${roleSlug}.pdf`;
      task.resumeFilename = filename;
      task.resumeUrl = downloadBlob(pdfBlob, filename);

      if (pdfBlob._coverLetterPdf) {
        const clName = companySlug ? `Vishal_${companySlug}_${roleSlug}_CoverLetter.pdf` : `Vishal_CoverLetter_${roleSlug}.pdf`;
        setTimeout(() => {
          task.clFilename = clName;
          task.clUrl = downloadBlob(pdfBlob._coverLetterPdf, clName);
          renderAutoPrepTasks();
        }, 600);
      }
      updateTask(task, `✅ Docs downloaded (${lang.toUpperCase()}) — use the links above if either didn't land in Downloads.`);
    } catch (err) {
      updateTask(task, `❌ Doc generation failed: ${err.message}`);
    }
  }

  function isLinkedInUrl(url) {
    try { return new URL(url).hostname.includes('linkedin.com'); } catch (_) { return false; }
  }

  // Follows the SAME path the scanner used — stays on whichever LinkedIn search-results tab is
  // already open and reuses it, rather than navigating to a direct /jobs/view/<id>/ URL (which
  // doesn't have the search layout's lazy-column structure and breaks detail-panel detection).
  // Returns null if no LinkedIn tab is open anywhere — there's no sensible page to click a card
  // on in that case, so the caller reports that clearly instead of guessing a URL.
  async function getLinkedInTab() {
    const active = await getActiveTab();
    if (active && isLinkedInUrl(active.url || '')) return active;
    const [anyTab] = await chrome.tabs.query({ url: '*://*.linkedin.com/*' });
    if (anyTab) {
      await chrome.tabs.update(anyTab.id, { active: true });
      return anyTab;
    }
    return null;
  }

  async function handleApplyNavigation(task) {
    const job = task.job;

    if (job.apply_type === 'easy_apply') {
      if (job.site === 'linkedin') {
        const tab = await getLinkedInTab();
        if (!tab) {
          updateTask(task, task.statusText + ' · ⚡ Easy Apply — no LinkedIn tab open; open your search results and try again.');
          return;
        }
        const result = await sendBulkMessage(tab.id, { type: 'RT_SHOW_JOB', jobTitle: job.title, jobCompany: job.company });
        updateTask(task, task.statusText + (result?.found
          ? ' · ⚡ Easy Apply — brought that job into view, apply directly in that tab.'
          : ' · ⚡ Easy Apply — couldn\'t find its card in the current list; find it manually and apply there.'));
      } else {
        chrome.tabs.create({ url: job.url });
        updateTask(task, task.statusText + ' · ⚡ Easy Apply — opened in a new tab, apply there directly.');
      }
      return;
    }

    if (job.site === 'linkedin' && job.apply_type === 'external') {
      updateTask(task, task.statusText + ' · Locating that job\'s card in the list to click Apply…');
      try {
        const tab = await getLinkedInTab();
        if (!tab) {
          updateTask(task, task.statusText + ' · ❌ No LinkedIn tab open — open your search results and try again.');
          return;
        }
        const result = await sendBulkMessage(tab.id, {
          type: 'RT_RESOLVE_APPLY_URL',
          jobKey: job.job_key || window.RTJobStore.jobKey(job),
          jobTitle: job.title, jobCompany: job.company,
        });
        if (result?.apply_type === 'easy_apply') {
          updateTask(task, task.statusText + ' · ⚡ Actually Easy Apply — apply directly in that tab.');
        } else if (result?.ok) {
          updateTask(task, task.statusText + ' · 🔗 Clicked Apply — destination tab opening (watch for it).');
        } else {
          updateTask(task, task.statusText + ` · ❌ ${result?.error || 'Could not click Apply.'}`);
        }
      } catch (err) {
        updateTask(task, task.statusText + ` · ❌ ${err.message}`);
      }
      return;
    }

    // Non-LinkedIn external / unknown: apply_url is already the real destination (the JD page
    // itself, for most ATS sites) — just open it.
    if (job.apply_url || job.url) {
      chrome.tabs.create({ url: job.apply_url || job.url });
      updateTask(task, task.statusText + ' · Opened application page in a new tab.');
    }
  }

  // Called per-job the moment it streams in during a "Scan + Launch" run. Upserts it into the
  // offline store immediately (not batched until scan end) so a job already seen in a past
  // session is never re-launched — only genuinely new jobs get auto-generated.
  async function maybeAutoLaunch(job) {
    const { inserted } = await window.RTJobStore.upsertJob(job);
    job.already_seen = !inserted;
    renderScanResults();
    if (!inserted) return;
    autoGenerateForJob(job);
  }

  // Same doc-generation pipeline as launchAutoPrep, minus the apply-navigation step — during a
  // scan, content.js already clicked that job's real Apply link while still sitting on its card
  // (the resolveApplyLinks path), so re-locating the card here to click Apply again would race
  // against the scan loop still moving through the list on the same tab.
  async function autoGenerateForJob(job) {
    const task = {
      id: ++autoPrepTaskSeq,
      job,
      statusText: job.apply_type === 'external'
        ? 'Apply clicked during scan — resolving destination tab…'
        : job.apply_type === 'easy_apply'
          ? '⚡ Easy Apply — generating docs now, apply manually in LinkedIn.'
          : 'Generating docs…',
      awaitingLangChoice: false,
      resolveLangChoice: null,
      track: document.getElementById('rt-track').value,
      specialInstr: document.getElementById('rt-special').value.trim(),
    };
    autoPrepTasks.push(task);
    renderAutoPrepTasks();

    const lang = detectLanguage(job.jd);
    if (lang === 'en') {
      updateTask(task, 'JD looks like English — choose a CV language:', true);
      const chosen = await new Promise((resolve) => { task.resolveLangChoice = resolve; });
      task.awaitingLangChoice = false;
      await generateDocsForJob(task, chosen);
    } else {
      await generateDocsForJob(task, 'de');
    }
  }

  async function launchAutoPrep(job) {
    const task = {
      id: ++autoPrepTaskSeq,
      job,
      statusText: 'Starting…',
      awaitingLangChoice: false,
      resolveLangChoice: null,
      // Snapshotted NOW, at launch — never re-read from the DOM later, so this job's docs always
      // reflect what was selected when you clicked Auto-Prep, regardless of what you change the
      // Track dropdown to afterward (e.g. to launch a differently-tracked job concurrently) or
      // how long this job sits waiting on the language-choice prompt.
      track: document.getElementById('rt-track').value,
      specialInstr: document.getElementById('rt-special').value.trim(),
    };
    autoPrepTasks.push(task);
    renderAutoPrepTasks();

    // These two run concurrently with each other (and with any other job's whole pipeline) —
    // nothing here blocks the rest of the panel.
    const navPromise = handleApplyNavigation(task);

    const lang = detectLanguage(job.jd);
    if (lang === 'en') {
      updateTask(task, 'JD looks like English — choose a CV language:', true);
      const chosen = await new Promise((resolve) => { task.resolveLangChoice = resolve; });
      task.awaitingLangChoice = false;
      await generateDocsForJob(task, chosen);
    } else {
      await generateDocsForJob(task, 'de');
    }

    await navPromise;
  }

  // ─────────────────────────────────────────────────────────────
  // DESTINATION-PAGE PIPELINE — runs once the real ATS URL is resolved and that tab is left open
  // (see content.js's checkDestinationPage). It only ever: (1) clicks an entry-point "Apply"
  // button if the landing page is the job posting rather than the form, (2) runs the existing
  // AI Autofill on form fields, or (3) stops and notifies you. It NEVER fills a password field,
  // never attempts sign-in/sign-up, and never clicks submit — credentials and final submission
  // are always yours.
  // ─────────────────────────────────────────────────────────────
  async function handleDestinationReady(task, tabId) {
    task.destTabId = tabId;
    updateDestStatus(task, 'Checking application page…');

    let result;
    try {
      result = await sendBulkMessage(tabId, { type: 'RT_CHECK_DESTINATION_PAGE' });
    } catch (err) {
      updateDestStatus(task, `❌ Couldn't read that page: ${err.message}`);
      return;
    }

    const jobLabel = `${task.job.title || 'Job'} — ${task.job.company || ''}`.trim();

    if (result?.stage === 'auth_wall') {
      notifyUser('Sign-in needed', jobLabel);
      updateDestStatus(task, "🔔 Needs you — sign in or create an account in that tab, then click Autofill below.", true);
      await new Promise((resolve) => { task.resolveManualAuth = resolve; });
      task.awaitingManualAuth = false;
      await runAutofillOnTab(task, tabId, jobLabel);
      return;
    }

    if (result?.stage === 'form_ready') {
      await runAutofillOnTab(task, tabId, jobLabel);
      return;
    }

    notifyUser('Check needed', jobLabel);
    updateDestStatus(task, '⚠️ Could not find an application form or Apply button automatically — open that tab and check it yourself.');
  }

  async function runAutofillOnTab(task, tabId, jobLabel) {
    updateDestStatus(task, 'Autofilling application form…');
    try {
      const result = await sendBulkMessage(tabId, { type: 'RT_AUTOFILL' });
      if (!result || !result.ok) {
        updateDestStatus(task, '⚠️ ' + (result?.error || 'Autofill failed — fill the form manually.'));
        notifyUser('Check needed', jobLabel);
      } else {
        updateDestStatus(task, `✅ Autofilled ${result.filled}/${result.total} field(s)` +
          (result.failed ? ` · ${result.failed} need your review` : '') +
          ' — review and submit yourself.');
      }
    } catch (err) {
      updateDestStatus(task, '❌ Autofill error: ' + err.message);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'RT_APPLY_URL_RESOLVED') return;
    const task = autoPrepTasks.find((t) => {
      const key = t.job.job_key || window.RTJobStore.jobKey(t.job);
      return key === msg.jobKey;
    });
    if (!task) return;
    updateTask(task, task.statusText + ` · ✅ Resolved: ${msg.url.slice(0, 60)}…`);
    if (msg.tabId) handleDestinationReady(task, msg.tabId);
  });

  // ─────────────────────────────────────────────────────────────
  // ONLINE RESUME EDITOR — edit any line of the resume and get an updated PDF straight back,
  // no JD re-analysis, no Gemini call, no reloading the extension. Operates on whatever
  // TRACK + RESUME LANGUAGE is currently selected in Controls.
  // ─────────────────────────────────────────────────────────────
  let editorSections = null;

  async function openEditor() {
    const track = document.getElementById('rt-track').value;
    const resumeLang = document.getElementById('rt-resume-lang').value || 'en';

    const overlay = document.getElementById('rt-editor');
    overlay.style.display = 'flex';
    document.getElementById('rt-edit-subtitle').textContent =
      `${TRACK_LABELS[track] || track} · ${resumeLang === 'de' ? 'Deutsch' : 'English'}`;
    document.getElementById('rt-edit-body').innerHTML =
      '<div class="rt-status">Loading resume content…</div>';
    document.getElementById('rt-edit-status').textContent = '';

    try {
      const data = await callBackendGet(
        `/resume-sections?track=${encodeURIComponent(track)}&resume_lang=${encodeURIComponent(resumeLang)}`
      );
      editorSections = data.sections || [];

      const seededSummary = lastSummaryByKey[`${track}:${resumeLang}`];
      if (seededSummary) {
        for (const sec of editorSections) {
          if (sec.is_summary && sec.segments.length) sec.segments[0].text = seededSummary;
        }
      }

      renderEditor(editorSections, !!seededSummary);
    } catch (err) {
      document.getElementById('rt-edit-body').innerHTML =
        `<div class="rt-status" style="color:#ef4444;">❌ ${escapeHtml(err.message)}</div>`;
    }
  }

  function closeEditor() {
    document.getElementById('rt-editor').style.display = 'none';
  }

  function renderEditor(sections, seeded) {
    const body = document.getElementById('rt-edit-body');
    body.innerHTML = sections.map((sec) => {
      const cls = sec.is_summary ? 'rt-edit-para rt-edit-summary' : 'rt-edit-para';
      const badge = sec.is_summary
        ? `<div class="rt-edit-summary-badge">✨ AI Summary${seeded ? ' (from last generation — edit freely)' : ' (template default)'}</div>`
        : '';
      const fields = sec.segments.map((seg) => {
        const rows = Math.max(1, Math.min(6, Math.ceil(seg.text.length / 55)));
        const style = `${seg.bold ? 'font-weight:700;' : ''}${seg.italic ? 'font-style:italic;' : ''}`;
        return `<textarea class="rt-edit-seg" data-seg-id="${escapeHtml(seg.id)}" rows="${rows}" style="${style}">${escapeHtml(seg.text)}</textarea>`;
      }).join('');
      return `<div class="${cls}">${badge}${fields}</div>`;
    }).join('');
  }

  async function saveEditor() {
    const track = document.getElementById('rt-track').value;
    const resumeLang = document.getElementById('rt-resume-lang').value || 'en';
    const btn = document.getElementById('rt-edit-save');
    const statusEl = document.getElementById('rt-edit-status');

    const edits = {};
    document.querySelectorAll('#rt-edit-body .rt-edit-seg').forEach((ta) => {
      edits[ta.dataset.segId] = ta.value;
    });

    btn.disabled = true;
    btn.textContent = '⏳ Saving…';
    statusEl.textContent = '';
    statusEl.style.color = '#8b87a8';
    statusEl.textContent = 'Regenerating PDF from your edits…';

    try {
      const pdfBlob = await callBackend('/resume-save', { track, resume_lang: resumeLang, edits }, true);
      const filename = `Vishal_Resume_${track}_edited.pdf`;
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      statusEl.style.color = '#10b981';
      statusEl.textContent = `✅ ${filename} downloaded!`;
    } catch (err) {
      statusEl.style.color = '#ef4444';
      statusEl.textContent = '❌ ' + err.message;
    }

    btn.disabled = false;
    btn.textContent = '💾 Save & Download PDF';
  }

  // ─────────────────────────────────────────────────────────────
  // INIT — wire up controls, auto-extract on load, and re-extract when the user
  // switches tabs or navigates to a new job (panel state persists across both).
  // ─────────────────────────────────────────────────────────────
  function init() {
    document.getElementById('rt-extract').onclick = runExtract;
    document.getElementById('rt-analyze').onclick = runAnalyze;
    document.getElementById('rt-go').onclick      = runTailor;
    document.getElementById('rt-edit-open').onclick = openEditor;
    document.getElementById('rt-edit-back').onclick = closeEditor;
    document.getElementById('rt-edit-save').onclick = saveEditor;
    document.getElementById('rt-autofill-start').onclick = runAutofillOnPage;
    document.getElementById('rt-scan-start').onclick  = () => startBulkScan();
    document.getElementById('rt-scan-launch').onclick = () => startBulkScan({ autoLaunch: true });
    document.getElementById('rt-scan-stop').onclick   = stopBulkScan;
    document.getElementById('rt-scan-export').onclick = async () => {
      const n = await window.RTJobStore.exportAllAsJson();
      setScanStatus(`📦 Exported ${n} job(s) — feed the JSON to export_to_sqlite.py to build jobs.sqlite.`);
    };
    document.getElementById('rt-dashboard-open').onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    };

    const clCheck  = document.getElementById('rt-cl');
    const langWrap = document.getElementById('rt-lang-wrap');
    clCheck.onchange = () => { langWrap.style.display = clCheck.checked ? 'flex' : 'none'; };

    chrome.tabs.onActivated.addListener(() => { if (!scanInProgress) runExtract(); });
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (scanInProgress) return;
      if (changeInfo.status === 'complete' && tab.active && tab.url !== lastExtractedUrl) {
        runExtract();
      }
    });

    runExtract();
  }

  init();
})();
