// Content script — runs inside the job page's own document, ONLY to read text off the page
// (and, for the bulk scanner, to click through LinkedIn's own job cards/pagination). All
// rendering/UI lives in the side panel (sidepanel.html), a completely separate document the host
// page can never touch. This script never injects any visible DOM into the page.
(function () {
  'use strict';

  // content.js injects into every frame (all_frames: true) since some ATS sites render the
  // application form inside an iframe — this flag lets handlers tell whether they're running in
  // the page's own top-level document or a (possibly unrelated) subframe.
  const isTopFrame = window === window.top;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));

  // Hard safety rails on the bulk scanner regardless of what the side panel asks for — avoids
  // anything that could look like runaway/bot-like behavior on LinkedIn.
  const MAX_PAGES_HARD_CAP = 10;
  const MAX_JOBS_HARD_CAP  = 150;

  let bulkScanStopRequested = false;

  // LinkedIn's "are you human" / security-checkpoint interstitial lives under a dedicated URL
  // path. If we ever see it, stop immediately rather than continuing to click through a page
  // that's actively challenging the session — this is the actual anti-ban circuit breaker.
  function isLinkedInCheckpoint() {
    if (location.pathname.includes('/checkpoint/')) return true;
    const head = (document.body?.innerText || '').slice(0, 500).toLowerCase();
    return head.includes('quick security check') || head.includes('verify you') || head.includes('unusual activity');
  }

  function bestText(selectors, scope) {
    const root = scope || document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        const text = el && el.innerText ? el.innerText.trim() : '';
        if (text.length > 40) return text;
      } catch (_) { /* invalid selector on this page, skip */ }
    }
    return '';
  }

  // ─────────────────────────────────────────────────────────────
  // LinkedIn — stable selectors (data-testid / data-sdui-component / role / structural links).
  // LinkedIn's CSS classes are obfuscated and churn constantly — never keyed off those.
  // ─────────────────────────────────────────────────────────────

  // Browser tab title has followed one of a few stable patterns for years:
  // "<Job Title> hiring at <Company> | LinkedIn" (logged in) or
  // "<Job Title> - <Company> | LinkedIn" (logged out), optionally prefixed "(2) ".
  function parseLinkedInTabTitle() {
    const raw = document.title.replace(/^\(\d+\)\s*/, '').trim();
    let m = raw.match(/^(.+?)\s+hiring at\s+(.+?)\s*\|\s*LinkedIn$/i);
    if (!m) m = raw.match(/^(.+?)\s*[-–]\s*(.+?)\s*\|\s*LinkedIn$/i);
    if (!m) return { title: '', company: '' };
    return { title: m[1].trim(), company: m[2].trim() };
  }

  // The detail panel (title/company/JD for whichever job is currently open) is the LAST
  // [data-testid="lazy-column"] when LinkedIn's 3-column search-results layout is present.
  // On a direct single-job page (/jobs/view/123, no search list) that wrapper doesn't exist —
  // fall back to the whole document.
  function getDetailScope() {
    const columns = document.querySelectorAll('[data-testid="lazy-column"]');
    return columns.length >= 2 ? columns[columns.length - 1] : document;
  }

  // The JD lives in a clipped "...more" expandable box inside a specific SDUI component.
  // The "...more" button is always aria-hidden="true" (decorative per LinkedIn, not a state
  // signal) but still works when clicked. Multiple expandable-text-buttons exist on the page
  // (company insights, competitor info, about-the-company) — always scope to aboutTheJob.
  async function expandAndReadJobDescription() {
    const aboutJob = document.querySelector(
      '[data-sdui-component="com.linkedin.sdui.generated.jobseeker.dsl.impl.aboutTheJob"]'
    );
    if (!aboutJob) return '';
    const moreBtn = aboutJob.querySelector('[data-testid="expandable-text-button"]');
    if (moreBtn) {
      moreBtn.click();
      await sleep(300);
    }
    const box = aboutJob.querySelector('[data-testid="expandable-text-box"]');
    return box?.innerText?.trim() || '';
  }

  // Read-only — never clicks Apply/Easy Apply, just inspects what's already in the DOM.
  // LinkedIn renders "Easy Apply" as a <button> (opens an in-page modal flow); a plain external
  // application is rendered as a real <a href="..."> straight to the employer's ATS, since
  // clicking it just opens that URL in a new tab — the href is already sitting there to read.
  function detectApplyInfo(scope) {
    const buttons = [...scope.querySelectorAll('button')];
    const easyApplyBtn = buttons.find((b) =>
      /easy apply/i.test(b.innerText || b.getAttribute('aria-label') || '')
    );
    if (easyApplyBtn) return { apply_type: 'easy_apply', apply_url: location.href };

    const links = [...scope.querySelectorAll('a[href]')];
    const applyLink = links.find((a) =>
      /^apply(\s+on\s+company\s+site)?$/i.test((a.innerText || '').trim())
    );
    if (applyLink) return { apply_type: 'external', apply_url: applyLink.href };

    return { apply_type: 'unknown', apply_url: '' };
  }

  // Mirrors db.js's jobKey() algorithm exactly, without touching IndexedDB — content scripts run
  // in the page's own origin, so they can't reach the extension's storage directly; this just
  // needs to produce the SAME string so background.js can persist the resolved URL to the right
  // record once it gets there via window-context pages (sidepanel/dashboard/background).
  function computeJobKey({ site, jobId, url }) {
    if (jobId) return `${site}:${jobId}`;
    try {
      const u = new URL(url);
      return `${site}:${u.origin}${u.pathname}`;
    } catch (_) {
      return `${site}:${url || ''}`;
    }
  }

  // Fire-and-forget click-through, used while scanning (already sitting on the right card/detail
  // panel — no need to re-locate it later). Doesn't await resolution; background.js tracks it
  // asynchronously and the scan loop moves straight to the next card.
  function clickApplyLinkInScope(scope, jobKey, autoClose) {
    const links = [...scope.querySelectorAll('a[href]')];
    const applyLink = links.find((a) =>
      /^apply(\s+on\s+company\s+site)?$/i.test((a.innerText || '').trim())
    );
    if (!applyLink) return false;
    chrome.runtime.sendMessage({ type: 'RT_APPLY_CLICK_STARTING', jobKey, autoClose: !!autoClose })
      .then(() => applyLink.click())
      .catch(() => {});
    return true;
  }

  // Click-through to discover the REAL apply destination. LinkedIn's external "Apply" link goes
  // through its own redirect — the href is a linkedin.com URL, not the employer's ATS page. This
  // is the only reliable way to learn the true destination: actually follow it and see where it
  // lands. This clicks "Apply" to open the destination, nothing more — it never touches a form
  // on the far side and never submits anything; that stays entirely manual.
  async function resolveApplyUrl(jobKey, jobTitle, jobCompany) {
    // Follow the SAME path the scanner used: stay on the search-results list and click that
    // job's card (React state update, same as runBulkScan) — NOT a direct /jobs/view/<id>/ URL,
    // which doesn't have the lazy-column search layout and breaks getDetailScope()'s assumptions.
    const card = findCardMatchingJob(jobTitle, jobCompany);
    if (card) {
      card.click();
      await jitter(500, 900);
    }

    const scope = getDetailScope();
    const buttons = [...scope.querySelectorAll('button')];
    const easyApplyBtn = buttons.find((b) =>
      /easy apply/i.test(b.innerText || b.getAttribute('aria-label') || '')
    );
    if (easyApplyBtn) {
      return { ok: true, apply_type: 'easy_apply', message: 'This is an Easy Apply job — nothing to resolve, apply directly in LinkedIn.' };
    }

    const links = [...scope.querySelectorAll('a[href]')];
    const applyLink = links.find((a) =>
      /^apply(\s+on\s+company\s+site)?$/i.test((a.innerText || '').trim())
    );
    if (!applyLink) {
      return { ok: false, error: 'Could not find an Apply button/link on this page.' };
    }

    // Tell background.js a click-through is starting BEFORE clicking, so it's already watching
    // for the new tab / navigation by the time it happens.
    await chrome.runtime.sendMessage({ type: 'RT_APPLY_CLICK_STARTING', jobKey });
    applyLink.click();
    return { ok: true, apply_type: 'external', clicked: true };
  }

  async function extractFromLinkedIn() {
    const fromTitle = parseLinkedInTabTitle();
    const scope = getDetailScope();

    // Title: the detail panel's own title link is most reliable; tab-title parse next;
    // old class-name guesses last (kept only as a last-ditch fallback).
    const titleLink = scope.querySelector('a[href*="/jobs/view/"]');
    const title = (titleLink?.innerText?.trim()) || fromTitle.title || bestText([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      'h1',
    ], scope);

    // Company: the employer's own LinkedIn company-page link, scoped to the detail panel so it
    // can't accidentally match a job CARD's company link in the list column instead.
    const companyLink = scope.querySelector('a[href*="/company/"]');
    let company = companyLink?.innerText?.trim() || '';
    if (!company) {
      company = bestText([
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
      ], scope);
    }
    if (!company) company = fromTitle.company;

    const jdExpanded = await expandAndReadJobDescription();
    const jd = jdExpanded || bestText([
      '#job-details',
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
    ], scope);

    const { apply_type, apply_url } = detectApplyInfo(scope);

    return { title, company, jd, apply_type, apply_url };
  }

  // ─────────────────────────────────────────────────────────────
  // Bulk scanner — walks the search-results job list + pagination, opening each card and
  // pulling full detail via the same reliable selectors above.
  // ─────────────────────────────────────────────────────────────

  function getJobListColumn() {
    const columns = document.querySelectorAll('[data-testid="lazy-column"]');
    return columns.length ? columns[0] : null;
  }

  function getCurrentPageCards() {
    const listColumn = getJobListColumn();
    const root = listColumn || document;
    return [...root.querySelectorAll('[role="button"]')]
      .filter((el) => (el.innerText || '').trim().length > 80);
  }

  function parseCardListText(card) {
    const lines = card.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      title:    (lines[0] || '').replace(' (Verified job)', '').trim(),
      company:  lines[2] || '',
      location: lines[3] || '',
    };
  }

  // Finds this job's card in the CURRENT search-results list by title+company text match.
  // Cards don't carry a jobId until clicked, so this is the only way to re-locate one.
  function findCardMatchingJob(title, company) {
    const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const wantTitle = norm(title), wantCompany = norm(company);
    if (!wantTitle) return null;
    return getCurrentPageCards().find((card) => {
      const data = parseCardListText(card);
      return norm(data.title) === wantTitle && (!wantCompany || norm(data.company) === wantCompany);
    }) || null;
  }

  function getJobIdFromUrl() {
    return new URL(location.href).searchParams.get('currentJobId') || '';
  }

  async function goToNextPage() {
    const nextBtn = document.querySelector('[data-testid="pagination-controls-next-button-visible"]');
    if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') return false;
    nextBtn.click();
    await jitter(1200, 2000);
    return true;
  }

  function sendProgress(payload) {
    chrome.runtime.sendMessage({ type: 'RT_BULK_SCAN_PROGRESS', ...payload }).catch(() => {});
  }

  async function runBulkScan({ maxPages = 3, maxJobs = 50, resolveApplyLinks = false, autoLaunch = false } = {}) {
    bulkScanStopRequested = false;
    const cappedPages = Math.max(1, Math.min(maxPages, MAX_PAGES_HARD_CAP));
    const cappedJobs   = Math.max(1, Math.min(maxJobs, MAX_JOBS_HARD_CAP));

    const results = [];
    let page = 1;

    while (page <= cappedPages && results.length < cappedJobs) {
      const cards = getCurrentPageCards();
      if (!cards.length) break;

      for (let i = 0; i < cards.length; i++) {
        if (bulkScanStopRequested || results.length >= cappedJobs) break;

        if (isLinkedInCheckpoint()) {
          sendProgress({
            status: '⚠️ LinkedIn security checkpoint detected — scan stopped. Verify manually before retrying.',
            totalScraped: results.length, checkpoint: true,
          });
          bulkScanStopRequested = true;
          break;
        }

        const card = cards[i];
        const listData = parseCardListText(card);

        sendProgress({
          page, jobIndex: i + 1, totalOnPage: cards.length,
          totalScraped: results.length, status: `Opening: ${listData.title || 'job'}…`,
        });

        try {
          card.click();
          await jitter(500, 900);

          const detail = await extractFromLinkedIn();
          const jobId = getJobIdFromUrl();

          // Click-through right now, while we're already sitting on this exact card/detail
          // panel — avoids ever having to re-locate it later by title/company text match.
          // Fire-and-forget: doesn't block the scan loop. Plain "resolve apply links" closes the
          // destination tab once background.js captures the URL (nothing else happens there), but
          // Scan + Launch needs that tab kept OPEN — the sidepanel continues automation on it
          // (apply-button click-through, form/auth-wall detection, autofill) after it settles.
          if (resolveApplyLinks && detail.apply_type === 'external') {
            clickApplyLinkInScope(
              getDetailScope(),
              computeJobKey({ site: 'linkedin', jobId, url: location.href }),
              !autoLaunch
            );
          }

          results.push({
            jobId,
            site:       'linkedin',
            url:        location.href,
            title:      detail.title || listData.title,
            company:    detail.company || listData.company,
            location:   listData.location,
            jd:         detail.jd,
            apply_type: detail.apply_type,
            apply_url:  detail.apply_url,
          });
        } catch (err) {
          console.warn('[Resume Tailor] bulk scan: failed to open card', err);
        }

        // Most delays are short, but an occasional longer pause breaks up an otherwise
        // suspiciously regular click cadence.
        await (Math.random() < 0.2 ? jitter(2000, 4000) : jitter(300, 700));

        sendProgress({
          page, jobIndex: i + 1, totalOnPage: cards.length,
          totalScraped: results.length, status: null, partialResults: results,
        });
      }

      if (bulkScanStopRequested || results.length >= cappedJobs) break;

      sendProgress({ page, status: `Moving to page ${page + 1}…`, totalScraped: results.length });
      const advanced = await goToNextPage();
      if (!advanced) break;
      page++;
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // schema.org JobPosting structured data — many ATS platforms (Greenhouse, Lever, Workday,
  // company career pages) embed this for SEO. When present it's actual data, not scraped text.
  // ─────────────────────────────────────────────────────────────
  function extractFromJsonLd() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        let data;
        try { data = JSON.parse(s.textContent); } catch (_) { continue; }
        const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const item of candidates) {
          const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
          if (!types.includes('JobPosting')) continue;

          let jd = item.description || '';
          if (jd) {
            const tmp = document.createElement('div');
            tmp.innerHTML = jd;
            jd = (tmp.innerText || tmp.textContent || '').trim();
          }
          if (jd.length < 40) continue;

          return {
            title:   (item.title || '').trim(),
            company: (item.hiringOrganization?.name || '').trim(),
            jd,
          };
        }
      }
    } catch (_) { /* ignore — fall through to other strategies */ }
    return null;
  }

  function getSiteName() {
    const h = location.hostname;
    if (h.includes('linkedin.com'))    return 'linkedin';
    if (h.includes('greenhouse.io'))   return 'greenhouse';
    if (h.includes('lever.co'))        return 'lever';
    if (h.includes('myworkday') || h.includes('workday.com')) return 'workday';
    if (h.includes('indeed.'))         return 'indeed';
    if (h.includes('stepstone'))       return 'stepstone';
    return h;
  }

  // Generic fallback for non-LinkedIn ATS pages (Greenhouse, Lever, Workday, company career pages, etc.)
  // On these sites the JD page itself is typically also the apply entry point.
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
    return { title, company: '', jd, apply_type: 'external', apply_url: location.href };
  }

  async function extractJobInfo() {
    const site = getSiteName();
    const url  = location.href;

    let result = extractFromJsonLd();
    if (result) {
      result.apply_type = result.apply_type || 'external';
      result.apply_url  = result.apply_url || url;
    } else {
      const primary = site === 'linkedin' ? await extractFromLinkedIn() : extractGeneric();
      if (primary.jd) {
        result = primary;
      } else {
        const fallback = extractGeneric();
        result = {
          title:      primary.title || fallback.title,
          company:    primary.company || fallback.company,
          jd:         fallback.jd,
          apply_type: primary.apply_type || fallback.apply_type,
          apply_url:  primary.apply_url || fallback.apply_url,
        };
      }
    }

    return {
      site,
      url,
      jobId:      site === 'linkedin' ? getJobIdFromUrl() : '',
      title:      result.title || '',
      company:    result.company || '',
      jd:         result.jd || '',
      apply_type: result.apply_type || 'unknown',
      apply_url:  result.apply_url || url,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // DESTINATION PAGE CHECK — after the real ATS URL is resolved (see background.js), the landing
  // page is sometimes the job posting itself (one more "Apply" click needed to reach the actual
  // form) rather than the form. This finds that click-through and reports what it lands on.
  // It NEVER touches a password field and NEVER clicks anything that looks like a final submit —
  // only an entry-point "Apply" button/link, the same single click a human would make here.
  // Credentials and final submission stay entirely manual, by design.
  // ─────────────────────────────────────────────────────────────
  function hasAuthWall() {
    // A password field is the one unambiguous signal an ATS account login/signup is in the way —
    // job application forms themselves essentially never ask for a password.
    return !!document.querySelector('input[type="password"]');
  }

  function findApplyEntryButton() {
    const candidates = [...document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"]')];
    return candidates.find((el) => {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      return /^apply(\s+(now|for this (job|position|role)))?$/i.test(text);
    }) || null;
  }

  async function checkDestinationPage() {
    await sleep(800); // let the landing page finish rendering after the redirect settles

    if (hasAuthWall()) return { stage: 'auth_wall' };

    let fields = extractFormFields();
    if (fields.length >= 3) return { stage: 'form_ready', fieldCount: fields.length };

    // Clicking an entry-point "Apply" button only makes sense on the page's own top document —
    // never inside some unrelated subframe (an ad, a chat widget, etc.).
    if (isTopFrame) {
      const applyBtn = findApplyEntryButton();
      if (applyBtn) {
        applyBtn.click();
        await sleep(900);
        if (hasAuthWall()) return { stage: 'auth_wall' };
        fields = extractFormFields();
        if (fields.length >= 3) return { stage: 'form_ready', fieldCount: fields.length };
      }
      return { stage: 'unknown' };
    }

    // This subframe found nothing definitive — stay silent rather than racing an "unknown"
    // answer ahead of whichever frame (maybe the top one, maybe a sibling iframe with the real
    // Workday/Greenhouse form) actually has something to report.
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // APPLICATION FORM AUTOFILL — field/page extraction lives here; the Gemini call itself runs in
  // background.js (a service worker, not a document, so it's never subject to the host page's CSP
  // the way a content-script fetch would be).
  // ─────────────────────────────────────────────────────────────

  function extractPageContext() {
    let context = '';
    context += 'Page Title: ' + document.title + '\n';
    context += 'URL: ' + window.location.href + '\n';

    const headings = document.querySelectorAll('h1, h2, h3');
    const jobHeadings = [];
    headings.forEach((h) => {
      const txt = h.textContent.trim();
      if (txt.length > 5 && txt.length < 200) jobHeadings.push(txt);
    });
    if (jobHeadings.length > 0) {
      context += 'Page Headings: ' + jobHeadings.slice(0, 5).join(' | ') + '\n';
    }

    const descKeywords = [
      'job description', 'stellenbeschreibung', 'aufgaben', 'requirements',
      'anforderungen', 'responsibilities', 'qualifications', 'your profile', 'dein profil',
      'what we offer', 'was wir bieten', 'about the role', 'über die stelle',
    ];
    const allText = document.body.innerText.toLowerCase();
    for (const kw of descKeywords) {
      const idx = allText.indexOf(kw);
      if (idx > -1) {
        const snippet = document.body.innerText.slice(Math.max(0, idx - 50), idx + 500).trim();
        context += '\nJob content near "' + kw + '":\n' + snippet.slice(0, 600) + '\n';
        break;
      }
    }

    const metaCompany = document.querySelector('meta[property="og:site_name"]');
    if (metaCompany) context += 'Company: ' + metaCompany.content + '\n';

    return context.slice(0, 2000);
  }

  function extractFormFields() {
    const fields = [];
    let index = 0;

    document.querySelectorAll('input, select, textarea').forEach((f) => {
      if (f.type === 'hidden' || f.type === 'submit' || f.type === 'button' ||
          f.type === 'file' || f.disabled || f.offsetParent === null) return;

      const info = {
        index: index++,
        tag: f.tagName.toLowerCase(),
        type: f.type || '',
        isLongText: f.tagName === 'TEXTAREA' || (f.type === 'text' && f.maxLength > 200),
      };

      if (f.name) info.name = f.name;
      if (f.id) info.id = f.id;
      if (f.placeholder) info.ph = f.placeholder.slice(0, 100);
      const ariaLabel = f.getAttribute('aria-label');
      if (ariaLabel) info.aria = ariaLabel.slice(0, 100);
      if (f.maxLength > 0) info.maxLen = f.maxLength;

      let label = '';
      const fid = f.id || f.name;
      if (fid) {
        const lb = document.querySelector(`label[for="${fid}"]`);
        if (lb) label = lb.textContent.trim();
      }
      if (!label) {
        let el = f.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          const lb = el.querySelector(':scope > label');
          if (lb) { label = lb.textContent.trim(); break; }
          const legend = el.querySelector('legend');
          if (legend) { label = legend.textContent.trim(); break; }
          el = el.parentElement;
        }
      }
      if (!label && f.previousElementSibling) {
        label = f.previousElementSibling.textContent.trim().slice(0, 250);
      }
      if (label) info.label = label.slice(0, 250);

      if (!label || info.isLongText) {
        let el = f.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          const txt = el.textContent.trim();
          if (txt.length > 10 && txt.length < 500) {
            info.context = txt.slice(0, 400);
            break;
          }
          el = el.parentElement;
        }
      }

      if (f.tagName === 'SELECT') {
        const opts = [];
        f.querySelectorAll('option').forEach((opt) => {
          if (opt.value || opt.textContent.trim()) {
            opts.push({ v: opt.value, t: opt.textContent.trim() });
          }
        });
        if (opts.length > 20) {
          const relevant = opts.filter((o) => {
            const t = o.t.toLowerCase();
            return t.includes('german') || t.includes('deutsch') || t.includes('+49') ||
                   t.includes('india') || t.includes('eur') || t.includes('male') ||
                   t.includes('männ') || t.includes('yes') || t.includes('ja') ||
                   t.includes('no ') || t.includes('nein') || t.includes('mr') ||
                   t.includes('herr') || t === 'no' || t === 'yes' || t.includes('25%') ||
                   t.includes('a1') || t.includes('c1') || t.includes('beginner') ||
                   t.includes('anfänger') || t.includes('nicht') || t.includes('none') ||
                   t.includes('keine');
          });
          const sample = opts.slice(0, 5);
          const combined = [...sample, ...relevant]
            .filter((o, i, a) => a.findIndex((x) => x.v === o.v) === i)
            .slice(0, 25);
          info.options = combined;
          info.totalOpts = opts.length;
        } else {
          info.options = opts;
        }
      }

      if (f.type === 'checkbox' || f.type === 'radio') {
        info.checked = f.checked;
        info.radioValue = f.value;
      }

      info._el = f;
      fields.push(info);
    });

    return fields;
  }

  function setFieldValue(f, value) {
    if (value === undefined || value === null || value === '') return false;
    const v = String(value);

    if (f.type === 'checkbox') {
      const shouldCheck = ['yes', 'ja', 'true', '1'].includes(v.toLowerCase());
      if (f.checked !== shouldCheck) {
        f.click();
        f.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }

    if (f.type === 'radio') {
      if (f.value.toLowerCase() === v.toLowerCase() ||
          f.nextSibling?.textContent?.trim().toLowerCase() === v.toLowerCase()) {
        f.click();
        f.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }

    if (f.tagName === 'SELECT') {
      const opts = f.querySelectorAll('option');
      for (const opt of opts) {
        if (opt.value === v) {
          f.value = opt.value;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      for (const opt of opts) {
        if (opt.textContent.trim().toLowerCase() === v.toLowerCase()) {
          f.value = opt.value;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      for (const opt of opts) {
        if (opt.textContent.trim().toLowerCase().startsWith(v.toLowerCase())) {
          f.value = opt.value;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (v.length > 3) {
        for (const opt of opts) {
          if (opt.textContent.trim().toLowerCase().includes(v.toLowerCase())) {
            f.value = opt.value;
            f.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
      for (const opt of opts) {
        const ot = opt.textContent.trim().toLowerCase();
        if (ot.length > 2 && v.toLowerCase().includes(ot)) {
          f.value = opt.value;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }

    const proto = f.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter?.set) setter.set.call(f, v);
    else f.value = v;
    f.dispatchEvent(new Event('focus', { bubbles: true }));
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    f.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  async function runAutofill() {
    let fields = extractFormFields();

    if (fields.length === 0) {
      // Subframes (an ad, a chat widget, etc.) just stay silent — only the top frame is allowed
      // to report final failure, and only after giving a slow-rendering form one more chance.
      if (!isTopFrame) return null;
      await sleep(700);
      fields = extractFormFields();
      if (fields.length === 0) return { ok: false, error: 'No form fields found on this page.' };
    }

    const pageContext = extractPageContext();

    const cleanFields = fields.map((f) => {
      const c = { ...f };
      delete c._el;
      return c;
    });

    let mappings;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'RT_AUTOFILL_BACKEND_CALL', pageContext, fields: cleanFields,
      });
      if (!response || response.error) {
        return { ok: false, error: response?.error || 'Network error contacting Gemini.' };
      }
      mappings = response.data;
    } catch (err) {
      return { ok: false, error: 'Network error: ' + err.message };
    }

    if (!Array.isArray(mappings)) {
      return { ok: false, error: 'Unexpected response shape from Gemini.' };
    }

    let filled = 0, failed = 0;
    for (const m of mappings) {
      const field = fields.find((f) => f.index === m.index);
      if (!field || m.value === undefined || m.value === '') continue;
      if (setFieldValue(field._el, m.value)) filled++; else failed++;
    }

    return { ok: true, filled, failed, total: fields.length };
  }

  // content.js now injects into every frame (all_frames: true in the manifest) — needed so
  // autofill/destination-page detection can reach forms ATS sites render inside an iframe
  // (Workday in particular). chrome.tabs.sendMessage with no frameId broadcasts to ALL frames,
  // so every handler below must decide whether it's the right frame to act/respond in, or a
  // stray ad/tracking iframe could race a meaningless answer ahead of the real one.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    // These only ever make sense on the page's own top-level document (job postings and
    // LinkedIn's search UI are never split across frames) — subframes stay silent so their
    // response can never race ahead of the real one.
    const topFrameOnly = ['RT_EXTRACT', 'RT_BULK_SCAN_START', 'RT_BULK_SCAN_STOP', 'RT_RESOLVE_APPLY_URL', 'RT_SHOW_JOB'];
    if (topFrameOnly.includes(msg.type) && !isTopFrame) return false;

    if (msg.type === 'RT_EXTRACT') {
      extractJobInfo().then(sendResponse);
      return true; // keep the message channel open for the async response
    }

    if (msg.type === 'RT_BULK_SCAN_START') {
      runBulkScan(msg.options).then((results) => {
        sendResponse({ done: true, results });
      });
      return true;
    }

    if (msg.type === 'RT_BULK_SCAN_STOP') {
      bulkScanStopRequested = true;
      sendResponse({ stopped: true });
      return false;
    }

    // RT_AUTOFILL and RT_CHECK_DESTINATION_PAGE DO need to run in every frame — the actual form
    // can be inside an iframe. Each only calls sendResponse when it has something definitive to
    // report; a frame with nothing useful (e.g. an ad iframe) stays silent rather than racing a
    // "not found" answer ahead of whichever frame actually has the form.
    if (msg.type === 'RT_AUTOFILL') {
      runAutofill().then((result) => { if (result) sendResponse(result); });
      return true;
    }

    if (msg.type === 'RT_RESOLVE_APPLY_URL') {
      resolveApplyUrl(msg.jobKey, msg.jobTitle, msg.jobCompany).then(sendResponse);
      return true;
    }

    if (msg.type === 'RT_CHECK_DESTINATION_PAGE') {
      checkDestinationPage().then((result) => { if (result) sendResponse(result); });
      return true;
    }

    if (msg.type === 'RT_SHOW_JOB') {
      const card = findCardMatchingJob(msg.jobTitle, msg.jobCompany);
      if (card) card.click();
      sendResponse({ found: !!card });
      return false;
    }
  });
})();
