#!/usr/bin/env python3
"""
Offline, dependency-free importer: takes a JSON export from the extension's
"Export Job Store" button and upserts it into a local jobs.sqlite file.

No server, no network — run this manually whenever you want the scraped jobs
materialized as a real SQLite file (e.g. for a future Playwright apply-bot to
read directly).

Usage:
    python3 export_to_sqlite.py resume_tailor_jobs_2026-06-29T12-00-00.json
    python3 export_to_sqlite.py resume_tailor_jobs_2026-06-29T12-00-00.json --db ./jobs.sqlite

Re-running with later exports is safe: jobs are upserted by job_key, and a
job's `status` (new / applied / skipped) is preserved across re-imports —
only descriptive fields (title, company, JD, apply info) get refreshed.
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_key      TEXT PRIMARY KEY,
    job_id       TEXT,
    site         TEXT,
    url          TEXT,
    title        TEXT,
    company      TEXT,
    location     TEXT,
    jd           TEXT,
    apply_type   TEXT,
    apply_url    TEXT,
    scraped_at   TEXT,
    last_seen_at TEXT,
    status       TEXT DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_site   ON jobs(site);
"""

UPSERT = """
INSERT INTO jobs (job_key, job_id, site, url, title, company, location, jd,
                   apply_type, apply_url, scraped_at, last_seen_at, status)
VALUES (:job_key, :job_id, :site, :url, :title, :company, :location, :jd,
        :apply_type, :apply_url, :scraped_at, :last_seen_at, 'new')
ON CONFLICT(job_key) DO UPDATE SET
    title        = excluded.title,
    company      = excluded.company,
    location     = excluded.location,
    jd           = excluded.jd,
    apply_type   = excluded.apply_type,
    apply_url    = excluded.apply_url,
    last_seen_at = excluded.last_seen_at;
    -- status is intentionally NOT overwritten — never reset 'applied'/'skipped' on re-import
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", help="JSON export from the extension's Export button")
    parser.add_argument("--db", default="jobs.sqlite", help="Path to the SQLite file (default: ./jobs.sqlite)")
    args = parser.parse_args()

    json_path = Path(args.json_file)
    if not json_path.exists():
        print(f"File not found: {json_path}", file=sys.stderr)
        sys.exit(1)

    jobs = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(jobs, list):
        print("Expected a JSON array of job records.", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(args.db)
    conn.executescript(SCHEMA)

    inserted_or_updated = 0
    for job in jobs:
        conn.execute(UPSERT, {
            "job_key":      job.get("job_key", ""),
            "job_id":       job.get("job_id", ""),
            "site":         job.get("site", ""),
            "url":          job.get("url", ""),
            "title":        job.get("title", ""),
            "company":      job.get("company", ""),
            "location":     job.get("location", ""),
            "jd":           job.get("jd", ""),
            "apply_type":   job.get("apply_type", "unknown"),
            "apply_url":    job.get("apply_url", ""),
            "scraped_at":   job.get("scraped_at", ""),
            "last_seen_at": job.get("last_seen_at", ""),
        })
        inserted_or_updated += 1

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    conn.close()

    print(f"Upserted {inserted_or_updated} job(s) from {json_path.name} into {args.db}")
    print(f"Total jobs in store: {total}")


if __name__ == "__main__":
    main()
