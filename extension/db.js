// Offline job store — IndexedDB, fully local to the browser profile, no server involved.
// Purpose 1 (dedupe): each job gets a stable job_key; re-scanning the same job is a no-op.
// Purpose 2 (future apply-bot feed): exportAllAsJson() lets you hand the data to
// export_to_sqlite.py, which writes it into a real local jobs.sqlite file.
(function () {
  'use strict';

  const DB_NAME    = 'resume_tailor_jobs';
  const DB_VERSION = 1;
  const STORE      = 'jobs';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'job_key' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('site', 'site', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`; // drop query/hash — same job, different tracking params
    } catch (_) {
      return url || '';
    }
  }

  function jobKey({ site, jobId, url }) {
    if (jobId) return `${site}:${jobId}`;
    return `${site}:${normalizeUrl(url)}`;
  }

  // Returns { inserted: true } for a genuinely new job, { inserted: false } if already seen
  // (job content fields are refreshed in place either way — only `status` is preserved so a
  // re-scan never resets a job you've already marked applied/skipped).
  async function upsertJob(job) {
    const db = await openDB();
    const key = jobKey(job);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(key);

      getReq.onsuccess = () => {
        const existing = getReq.result;
        const record = {
          job_key:    key,
          job_id:     job.jobId || '',
          site:       job.site || '',
          url:        job.url || '',
          title:      job.title || '',
          company:    job.company || '',
          location:   job.location || '',
          jd:         job.jd || '',
          apply_type: job.apply_type || 'unknown',
          apply_url:  job.apply_url || '',
          scraped_at: existing ? existing.scraped_at : new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          status:     existing ? existing.status : 'new',
        };
        store.put(record);
        tx.oncomplete = () => resolve({ inserted: !existing, record });
        tx.onerror    = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function getAllJobs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  // Manual status changes (new / ready / applied / skipped) — the actual "mark this job done"
  // mechanism. Never touched by upsertJob/re-scans, so this is the only thing that sets it.
  async function setStatus(jobKeyValue, status) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(jobKeyValue);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) { resolve(false); return; }
        existing.status = status;
        existing.status_updated_at = new Date().toISOString();
        store.put(existing);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // LinkedIn wraps external "Apply" links through its own redirect — the href we scrape is a
  // linkedin.com URL, not the real ATS destination. This is set later, once background.js has
  // actually tracked a click-through to where it really lands (see RT_RESOLVE_APPLY_URL).
  async function setApplyUrl(jobKeyValue, url) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(jobKeyValue);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) { resolve(false); return; }
        existing.apply_url = url;
        existing.apply_url_resolved_at = new Date().toISOString();
        store.put(existing);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function exportAllAsJson() {
    const jobs = await getAllJobs();
    const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `resume_tailor_jobs_${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return jobs.length;
  }

  // `self` (not `window`) so this loads identically in normal pages (sidepanel/dashboard, where
  // self === window) and in the background service worker (which has no `window` at all).
  self.RTJobStore = { upsertJob, getAllJobs, setStatus, setApplyUrl, exportAllAsJson, jobKey };
})();
