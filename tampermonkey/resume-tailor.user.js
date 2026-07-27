// ==UserScript==
// @name         Resume Startegic Auto
// @namespace    resume.tailor.vishal.v5
// @version      6.0
// @description  Docked right-side AI sidebar for strategic multi-track resume tailoring — JD auto-extraction, fit scoring, ATS keyword gaps, and one-click tailored PDF generation
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      railway.app
// @connect      up.railway.app
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // CONFIG — replace BACKEND_URL with your Railway URL
  // ─────────────────────────────────────────────────────────────
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

  // Outer scope — accessible across functions
  let panel, backdrop, isOpen = false, analysisData = null;

  function setStatus(msg, color) {
    const el = panel?.querySelector('#rt-status');
    if (el) {
      el.innerHTML = msg;
      el.style.color = color || '#8b87a8';
    }
  }

  function detectSiteLabel() {
    const h = location.hostname;
    if (h.includes('linkedin.com'))    return 'LinkedIn';
    if (h.includes('greenhouse.io'))   return 'Greenhouse';
    if (h.includes('lever.co'))        return 'Lever';
    if (h.includes('myworkday') || h.includes('workday.com')) return 'Workday';
    if (h.includes('indeed.'))         return 'Indeed';
    if (h.includes('stepstone'))       return 'StepStone';
    return 'Job Page';
  }

  // ─────────────────────────────────────────────────────────────
  // JD AUTO-EXTRACTION — reads the job posting straight off the page
  // ─────────────────────────────────────────────────────────────
  function bestText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        const text = el && el.innerText ? el.innerText.trim() : '';
        if (text.length > 40) return text;
      } catch (_) { /* invalid selector on this page, skip */ }
    }
    return '';
  }

  function extractFromLinkedIn() {
    const title = bestText([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title-link',
      '.top-card-layout__title',
      'h1.t-24',
      '.jobs-details-top-card__job-title',
    ]);
    let company = bestText([
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__subtitle-primary-grouping a',
      '.topcard__org-name-link',
      '.jobs-details-top-card__company-url',
    ]);
    if (!company) {
      // LinkedIn job tabs are usually titled "<Job Title> hiring at <Company> | LinkedIn"
      const m = document.title.match(/hiring at\s+(.+?)\s*\|\s*LinkedIn/i)
             || document.title.match(/^(.+?)\s+at\s+(.+?)\s*\|\s*LinkedIn/i);
      if (m) company = (m[2] || m[1] || '').trim();
    }
    const jd = bestText([
      '#job-details',
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
      '.jobs-box__html-content',
      '.description__text',
    ]);
    return { title, company, jd };
  }

  // Generic fallback for non-LinkedIn ATS pages (Greenhouse, Lever, Workday, company career pages, etc.)
  // LinkedIn class names change often too, so this also acts as LinkedIn's own fallback.
  function extractGeneric() {
    const jd = bestText([
      '[class*="job-description" i]',
      '[id*="job-description" i]',
      '[class*="jobDescription" i]',
      '[id*="jobDescription" i]',
      '.posting-requirements',
      '#content',
      'article',
      'main',
    ]) || document.body.innerText.trim();
    const title = bestText(['h1']);
    return { title, company: '', jd };
  }

  function extractJobInfo() {
    const isLinkedIn = location.hostname.includes('linkedin.com');
    const primary = isLinkedIn ? extractFromLinkedIn() : extractGeneric();
    if (primary.jd) return primary;
    // Specific selectors found nothing (site UI changed) — fall back to generic page scrape
    const fallback = extractGeneric();
    return {
      title:   primary.title || fallback.title,
      company: primary.company || fallback.company,
      jd:      fallback.jd,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UI — docked right-side sidebar, fully Shadow-DOM isolated
  // ─────────────────────────────────────────────────────────────
  function initUI() {
    // ROOT-CAUSE-IMMUNE MOUNTING (see prior investigation):
    // `position: fixed` does NOT always anchor to the true viewport — if any ancestor has
    // transform/filter/perspective/will-change/contain set, that ancestor hijacks the containing
    // block for every fixed descendant. SPA shells (LinkedIn etc.) commonly set one of these on
    // <body>. Fix: mount on <html> (skipping <body> as an ancestor) and give our own host an
    // explicit fixed full-viewport box; everything inside is position:absolute relative to that
    // box, which is immune to whatever the host page does below <html>.
    const host = document.createElement('div');
    host.id = 'rt-shadow-host';
    host.style.cssText = `
      all: initial;
      position: fixed !important;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      margin: 0; padding: 0; border: 0;
      pointer-events: none;
      z-index: 2147483647;
    `;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        font-size: 13px;
        font-weight: 400;
        line-height: 1.45;
        letter-spacing: normal;
        white-space: normal;
        word-break: normal;
        overflow-wrap: anywhere;
        text-transform: none;
        -webkit-font-smoothing: auto;
      }

      .rt-fab {
        position: absolute; bottom: 24px; right: 24px; width: 56px; height: 56px;
        border-radius: 50%; border: none; cursor: pointer;
        background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font-size: 22px;
        box-shadow: 0 6px 24px rgba(79,70,229,.5);
        display: flex; align-items: center; justify-content: center;
        pointer-events: auto; transition: transform .2s; white-space: nowrap;
      }
      .rt-fab:hover { transform: scale(1.08); }

      .rt-backdrop {
        position: absolute; inset: 0; background: rgba(8,7,15,.5);
        opacity: 0; pointer-events: none; transition: opacity .25s ease;
      }
      .rt-backdrop.open { opacity: 1; pointer-events: auto; }

      .rt-sidebar {
        position: absolute; top: 0; right: 0; height: 100%;
        width: clamp(420px, 32vw, 480px);
        background: #100f1a; border-left: 1px solid #2d2b3e;
        box-shadow: -12px 0 40px rgba(0,0,0,.5);
        display: flex; flex-direction: column;
        transform: translateX(105%);
        transition: transform .32s cubic-bezier(.22,1,.36,1);
        pointer-events: none; color: #c9c7e0;
      }
      .rt-sidebar.open { transform: translateX(0); pointer-events: auto; }

      .rt-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 20px; border-bottom: 1px solid #232032; flex-shrink: 0;
      }
      .rt-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .rt-logo { font-size: 20px; flex-shrink: 0; }
      .rt-title { font-size: 14px; font-weight: 700; color: #c4b5fd; white-space: nowrap; }
      .rt-site { font-size: 11px; color: #6e6a8a; white-space: nowrap; }
      .rt-icon-btn {
        background: none; border: none; color: #8b87a8; font-size: 18px; cursor: pointer;
        padding: 4px 8px; border-radius: 6px; flex-shrink: 0; white-space: nowrap;
      }
      .rt-icon-btn:hover { background: #1e1c2b; color: #fff; }

      .rt-body { flex: 1; overflow-y: auto; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 16px; }

      .rt-section-label {
        font-size: 11px; font-weight: 700; color: #8b87a8; letter-spacing: .8px;
        margin-bottom: 8px; text-transform: uppercase; white-space: nowrap;
      }
      .rt-card { background: #1a1825; border: 1px solid #2d2b3e; border-radius: 12px; padding: 14px; }

      .rt-field { display: flex; flex-direction: column; gap: 5px; }
      .rt-field label {
        font-size: 11px; font-weight: 700; color: #8b87a8; letter-spacing: .6px; white-space: nowrap;
      }
      .rt-input, .rt-select, .rt-textarea {
        width: 100%; padding: 9px 11px; border-radius: 8px; background: #1e1c2b;
        border: 1px solid #3a3750; color: #e5e3f5; font-size: 12.5px; outline: none;
      }
      .rt-textarea { resize: vertical; line-height: 1.5; font-family: inherit; }

      .rt-badge { display: inline-block; padding: 3px 8px; border-radius: 5px; font-size: 10.5px; margin: 2px 4px 2px 0; white-space: nowrap; }
      .rt-badge-ok { background: #1f2d2a; color: #5eead4; border: 1px solid #2d4a44; }
      .rt-badge-missing { background: #2d1f24; color: #fca5a5; border: 1px solid #4a2d34; }
      .rt-badge-project { background: #241f3a; color: #d8b4fe; border: 1px solid #3a2d56; }

      .rt-toggle-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: nowrap; gap: 10px; }
      .rt-switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; display: inline-block; }
      .rt-switch input { opacity: 0; width: 0; height: 0; }
      .rt-switch-track {
        position: absolute; inset: 0; background: #3a3750; border-radius: 22px; cursor: pointer; transition: background .2s;
      }
      .rt-switch-track::after {
        content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
        background: #c9c7e0; border-radius: 50%; transition: transform .2s;
      }
      .rt-switch input:checked + .rt-switch-track { background: #7c3aed; }
      .rt-switch input:checked + .rt-switch-track::after { transform: translateX(16px); background: #fff; }

      .rt-btn-primary {
        width: 100%; padding: 13px; border: none; border-radius: 10px;
        background: linear-gradient(135deg,#10b981,#059669); color: #fff;
        font-weight: 700; font-size: 13px; cursor: pointer; letter-spacing: .3px; white-space: nowrap;
      }
      .rt-btn-secondary {
        width: 100%; padding: 11px; border: 1px dashed #4f46e5; border-radius: 10px;
        background: #1a1830; color: #c4b5fd; font-weight: 700; font-size: 12.5px; cursor: pointer; white-space: nowrap;
      }
      .rt-btn-ghost {
        width: 100%; padding: 11px; border: none; border-radius: 10px;
        background: linear-gradient(135deg,#8b5cf6,#6366f1); color: #fff;
        font-weight: 700; font-size: 12.5px; cursor: pointer; white-space: nowrap;
      }

      .rt-future-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; background: #15131f; border: 1px solid #232032; border-radius: 8px;
        font-size: 12px; color: #8b87a8; white-space: nowrap;
      }
      .rt-soon { font-size: 9.5px; background: #2d2b3e; color: #6e6a8a; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }

      .rt-status { font-size: 11.5px; color: #8b87a8; text-align: center; line-height: 1.6; }
      .rt-status strong { color: #e5e3f5; }

      .rt-body::-webkit-scrollbar { width: 8px; }
      .rt-body::-webkit-scrollbar-thumb { background: #2d2b3e; border-radius: 4px; }
    `;
    shadow.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'rt-fab';
    fab.title = 'Resume Tailor';
    fab.textContent = '🎯';
    shadow.appendChild(fab);

    backdrop = document.createElement('div');
    backdrop.className = 'rt-backdrop';
    shadow.appendChild(backdrop);

    panel = document.createElement('div');
    panel.id = 'rt-panel';
    panel.className = 'rt-sidebar';

    panel.innerHTML = `
      <div class="rt-header">
        <div class="rt-header-left">
          <span class="rt-logo">🎯</span>
          <div>
            <div class="rt-title">Resume Tailor</div>
            <div class="rt-site" id="rt-site-label">Job Page</div>
          </div>
        </div>
        <button id="rt-close" class="rt-icon-btn">✕</button>
      </div>

      <div class="rt-body">

        <button id="rt-extract" class="rt-btn-secondary">🔎 Re-extract from page</button>

        <div id="rt-analysis" class="rt-card" style="display:none;"></div>

        <div class="rt-card">
          <div class="rt-section-label">Job Details</div>
          <div class="rt-field" style="margin-bottom:10px;">
            <label>COMPANY NAME</label>
            <input id="rt-company" class="rt-input" type="text" placeholder="e.g. Siemens, SAP, Deutsche Bank…">
          </div>
          <div class="rt-field" style="margin-bottom:10px;">
            <label>JOB TITLE <span style="font-weight:400;">(optional)</span></label>
            <input id="rt-title" class="rt-input" type="text" placeholder="e.g. Technical Product Manager…">
          </div>
          <div class="rt-field">
            <label>JOB DESCRIPTION</label>
            <textarea id="rt-jd" class="rt-textarea rt-input" rows="6" placeholder="Paste the JD here, or use Re-extract above…"></textarea>
          </div>
        </div>

        <button id="rt-analyze" class="rt-btn-ghost">🔍 Analyze JD</button>

        <div class="rt-card">
          <div class="rt-section-label">Controls</div>
          <div class="rt-field" style="margin-bottom:10px;">
            <label>TRACK</label>
            <select id="rt-track" class="rt-select">
              <option value="fulltime_dev">Full-Time — Developer / Engineer</option>
              <option value="werk_dev">Werkstudent / Intern — Developer / IT</option>
              <option value="werk_pm" selected>Werkstudent / Intern — PM / Strategy / EA</option>
              <option value="fulltime_pm">Full-Time — Product Manager</option>
            </select>
          </div>
          <div class="rt-field" style="margin-bottom:10px;">
            <label>RESUME LANGUAGE</label>
            <select id="rt-resume-lang" class="rt-select">
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
          <div class="rt-field" style="margin-bottom:12px;">
            <label>SPECIAL INSTRUCTIONS <span style="font-weight:400;">(optional)</span></label>
            <textarea id="rt-special" class="rt-textarea rt-input" rows="3" placeholder="e.g. emphasize AI work, avoid mentioning Formula Student…"></textarea>
          </div>
          <div class="rt-toggle-row" style="margin-bottom:10px;">
            <span style="font-size:12px;">📝 Cover letter</span>
            <label class="rt-switch">
              <input type="checkbox" id="rt-cl">
              <span class="rt-switch-track"></span>
            </label>
          </div>
          <div id="rt-lang-wrap" class="rt-field" style="display:none;">
            <label>CL LANGUAGE</label>
            <select id="rt-lang" class="rt-select">
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
        </div>

        <button id="rt-go" class="rt-btn-primary">✨ Generate Tailored Resume</button>
        <div id="rt-status" class="rt-status"></div>

        <div class="rt-card">
          <div class="rt-section-label">Coming Soon</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div class="rt-future-item">📄 Resume Preview <span class="rt-soon">Soon</span></div>
            <div class="rt-future-item">✉️ Cover Letter Preview <span class="rt-soon">Soon</span></div>
            <div class="rt-future-item">💬 Recruiter Message <span class="rt-soon">Soon</span></div>
            <div class="rt-future-item">🏢 Company Insights <span class="rt-soon">Soon</span></div>
            <div class="rt-future-item">🎤 Interview Prep <span class="rt-soon">Soon</span></div>
          </div>
        </div>

      </div>
    `;
    shadow.appendChild(panel);

    panel.querySelector('#rt-site-label').textContent = detectSiteLabel();

    fab.onclick = openSidebar;
    panel.querySelector('#rt-close').onclick = closeSidebar;
    backdrop.onclick = closeSidebar;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) closeSidebar();
    });

    // Browser-bar access: open/close from Tampermonkey's own toolbar icon menu, independent of
    // the page's DOM — same sidebar, same functionality, just a second entry point.
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('🎯 Open/Close Resume Tailor', () => (isOpen ? closeSidebar() : openSidebar()));
    }

    const clCheck  = panel.querySelector('#rt-cl');
    const langWrap = panel.querySelector('#rt-lang-wrap');
    clCheck.onchange = () => { langWrap.style.display = clCheck.checked ? 'flex' : 'none'; };

    panel.querySelector('#rt-extract').onclick = runExtract;
    panel.querySelector('#rt-analyze').onclick = runAnalyze;
    panel.querySelector('#rt-go').onclick      = runTailor;
  }

  // ─────────────────────────────────────────────────────────────
  // OPEN / CLOSE — slide-in sidebar, auto-extract + analyze on open
  // ─────────────────────────────────────────────────────────────
  function openSidebar() {
    isOpen = true;
    panel.classList.add('open');
    backdrop.classList.add('open');
    runExtract();
  }

  function closeSidebar() {
    isOpen = false;
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO-EXTRACT — fill fields from the current page, then analyze
  // ─────────────────────────────────────────────────────────────
  function runExtract() {
    const { title, company, jd } = extractJobInfo();

    if (!jd || jd.length < 40) {
      setStatus('⚠️ Could not find job text on this page — paste the JD manually.', '#f59e0b');
      return;
    }

    panel.querySelector('#rt-jd').value = jd.slice(0, 10000);
    if (company) panel.querySelector('#rt-company').value = company;
    if (title)   panel.querySelector('#rt-title').value = title;

    // Make it obvious exactly what was (and wasn't) pulled off the page.
    const found = [`JD ✓`, company ? `Company ✓ (${company})` : `Company ✗`, title ? `Title ✓` : `Title ✗`];
    const allFound = company && title;
    setStatus(`✅ Extracted — ${found.join(', ')}. Analyzing…`, allFound ? '#10b981' : '#f59e0b');
    runAnalyze();
  }

  // ─────────────────────────────────────────────────────────────
  // BACKEND CALLS
  // ─────────────────────────────────────────────────────────────
  function callBackend(path, payload, responseType) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:       'POST',
        url:          BACKEND_URL + path,
        headers:      { 'Content-Type': 'application/json' },
        data:         JSON.stringify(payload),
        responseType: responseType || '',
        timeout:      120000,
        onload(res) {
          if (res.status !== 200) {
            try {
              const txt = typeof res.response === 'string' ? res.response : res.responseText;
              const e = JSON.parse(txt || '{}');
              return reject(new Error(e.detail || `Server ${res.status}`));
            } catch(_) {
              return reject(new Error(`Server ${res.status}`));
            }
          }
          if (responseType === 'blob') {
            const blob = new Blob([res.response], { type: 'application/pdf' });
            const hdrs = res.responseHeaders || '';
            const m = hdrs.match(/x-cover-letter-pdf:\s*([^\r\n]+)/i);
            if (m) {
              try {
                // Decode base64 → Uint8Array → Blob for PDF
                const bin = atob(m[1].trim());
                const buf = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                blob._coverLetterPdf = new Blob([buf], { type: 'application/pdf' });
              } catch(err) { console.warn('CL PDF decode failed:', err); }
            }
            resolve(blob);
          } else {
            try { resolve(JSON.parse(res.responseText)); }
            catch(e) { reject(new Error('Invalid JSON response')); }
          }
        },
        onerror:   () => reject(new Error('Cannot reach server. Is Railway running?')),
        ontimeout: () => reject(new Error('Server timeout — try again'))
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ANALYZE — Stage 1
  // ─────────────────────────────────────────────────────────────
  async function runAnalyze() {
    const jd      = panel.querySelector('#rt-jd').value.trim();
    const company = panel.querySelector('#rt-company').value.trim();

    if (!jd) { setStatus('⚠️ Paste a job description first.', '#f59e0b'); return; }

    const btn = panel.querySelector('#rt-analyze');
    btn.disabled = true;
    btn.textContent = '⏳ Analyzing JD…';
    setStatus('Analyzing fit, keywords, and track…');

    try {
      analysisData = await callBackend('/analyze', { jd, company });
      renderAnalysis(analysisData);

      // Auto-select suggested track
      if (analysisData.track_suggestion) {
        panel.querySelector('#rt-track').value = analysisData.track_suggestion;
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
    const box = panel.querySelector('#rt-analysis');
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
    const jd           = panel.querySelector('#rt-jd').value.trim();
    const track        = panel.querySelector('#rt-track').value;
    const customTitle  = panel.querySelector('#rt-title').value.trim();
    const company      = panel.querySelector('#rt-company').value.trim();
    const resumeLang   = panel.querySelector('#rt-resume-lang').value || 'en';
    const specialInstr = panel.querySelector('#rt-special').value.trim();
    const wantCL       = panel.querySelector('#rt-cl').checked;
    const lang         = panel.querySelector('#rt-lang').value || 'en';

    if (!jd) { setStatus('⚠️ Paste a job description first.', '#f59e0b'); return; }

    const btn = panel.querySelector('#rt-go');
    btn.disabled = true;
    btn.textContent = '⏳ Generating…';

    // Warn (but don't block) on low fit
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

      const pdfBlob = await callBackend('/tailor', payload, 'blob');

      // Derive filename from track + company
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

      // Download
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      setStatus(`✅ <strong>${filename}</strong> downloaded!`, '#10b981');

      // Download cover letter PDF if generated
      if (wantCL && pdfBlob._coverLetterPdf) {
        const clName = companySlug
          ? `Vishal_${companySlug}_${roleSlug}_CoverLetter.pdf`
          : `Vishal_CoverLetter_${roleSlug}.pdf`;
        const clUrl = URL.createObjectURL(pdfBlob._coverLetterPdf);
        const b = document.createElement('a');
        b.href = clUrl; b.download = clName;
        // slight delay so both downloads succeed cleanly
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
  // INIT
  // ─────────────────────────────────────────────────────────────
  if (document.body) {
    initUI();
  } else {
    document.addEventListener('DOMContentLoaded', initUI);
  }

})();
