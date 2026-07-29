# Resume Consistency Audit — July 2026

Ground truth used: `Vishal_Mahesh_Kumar_RESUME_2026.pdf` and `SN_Vishal_Mahesh_Kumar_ServiceNow_Resume.pdf`.
Scope: all 8 generated variants (fulltime/werk × dev/pm × EN/DE).

Rule applied: **no generated resume may claim more than the source PDFs support.** Every claim below is now defensible in an interview.

---

## 1. Overclaims found and corrected

### 1.1 "Led" the ETL migration — the biggest risk
| | |
|---|---|
| Source PDF said | "Redesigned product architecture (70% transformation) ... by Migrating ETL functionalities from ServiceNow to AWS" — no leadership claim |
| Generated said | EN: "**Led** migration of ETL functionality" · "**Drove** ETL platform migration ... **coordinated rollout across multiple engineering pods**" · DE: "**Leitete** die Migration" / "**Trieb** ... **voran**" |
| Why it was a problem | You were ~12 months into your first job. "Led" plus "coordinated across multiple engineering pods" invites: *how many pods, who reported to you, what did you decide?* The "engineering pods" detail appeared in no source document at all. |
| Now reads | "Core contributor to migrating ETL functionality from ServiceNow to AWS as part of a platform re-architecture..." / DE: "Kernentwickler bei der Migration..." |

### 1.2 The MongoDB / PostgreSQL / AWS claim — the one you spotted
| | |
|---|---|
| Source PDF said | "**Assisted in** developing and maintaining SAAS application \| MongoDB, PostgreSQL, AWS S3 bucket, CloudWatch" |
| Generated said | EN: "**Built** API integration and software inventory ingestion features" · DE: "**Entwicklung von** API-Integrations- und Software-Inventory-Ingestion-Features" |
| Why it was a problem | This covers Sep 2022 – Apr 2023, your first 7 months. "Built ... ingestion features on MongoDB, PostgreSQL, AWS" reads as owning the data layer, and a German interviewer will ask you to justify the schema and the MongoDB-vs-Postgres choice. |
| Now reads | "Assisted in developing and maintaining the Flexera SaaS Manager SaaS application (MongoDB, PostgreSQL, AWS S3, CloudWatch); conducted API research and integration work." / DE: "Mitarbeit an Entwicklung und Wartung..." |

Also softened in the same block: "**Designed** reusable Script Includes" → "**Developed** reusable Script Includes" (DE: "Konzeption" → "Entwicklung").

### 1.3 "Fortune 500 customers" — fabricated
Appeared in `fulltime_pm` (EN + DE). Not in either source PDF. **Removed** → "global enterprise customers."

### 1.4 "Customers across NAM, EU and APAC" — category error
Appeared in `werk_pm` (EN + DE). Your source says you worked in an **international team** with colleagues in the US, Europe and Australia. That is about your *team*, not your *customer regions* — and APAC ≠ Australia in most companies' terminology. **Corrected** to "working in an international team spanning the US, Europe and Australia."

### 1.5 The ~60% metric was attached to the wrong cause
Source attributes the 60% gain to the **SMART API reducing customer load**. The generated versions attached it to the AWS migration alone. Now phrased as "...reducing customer-side processing load and improving end-customer performance by ~60%", which matches the causal chain you can actually explain.

*(The "70% transformation" figure from the old PDF was already dropped everywhere — correct call, it was unmeasurable.)*

---

## 2. Claims verified as OK — keep them

- **Custom data-transmission protocol stack (Ashwa Racing)** — you confirmed you wrote it. Kept, and now also added to `fulltime_dev` / `fulltime_dev_de`, which previously had the weaker "implemented CC1390 for telemetry" version. Be ready to describe packet framing, error handling and data rate.
- **TÜV SÜD project figures** (~150 KAMs, ~20% of customer base, 2–5 days → <1 day, 9-month roadmap) — internally consistent across all 8 files, and correctly hedged as *projected*.
- **ServiceNow specifics** (RTE pipelines, date-pair validation, Hardware/OS classification, sync/async Business Rules, network adapter events → CMDB) — all traceable to your ServiceNow PDF.
- **Werkstudent hours** (~20 h/week in semester, up to 40 h in the break) — legally correct framing.

---

## 3. Cross-file inconsistencies fixed

| Issue | Before | After |
|---|---|---|
| **Missing languages line** | `fulltime_dev` and `fulltime_dev_de` had no language row at all — a notable omission on a German-market CV | Added to both, matching the other six |
| **German level phrasing** | "Deutsch (A1, im Lernen)" — grammatically awkward | "Deutsch (A1, im Aufbau)" |
| **Availability statement** | Only on `fulltime_dev`, and with broken grammar ("with option to switch program to my course part-time") | Normalised across both full-time variants: "available from September 2026, and eligible to switch the M.Sc. to a part-time format upon securing full-time employment" |
| **Duplicate award** | Formula Hybrid 1st place listed twice (Projects *and* Extracurricular) in 4 files | Now listed once per resume |
| **Ashwa role title** | Header said "Hardware Electronics Engineer" while the bullet said "Led Electrical & Testing Subsystem" — self-contradictory | Header standardised to "Electrical & Testing Subsystem Lead" / "Leitung Elektrik- & Test-Subsystem", with the years added |
| **Date formatting** | "MARCH 2026 – Present" / "MÄRZ 2026 – heute" in all caps | "Mar 2026 – Present" / "März 2026 – heute" |
| **German grammar** | "Eigenständig Entwickler von AI-nativen Produkten" | "Eigenständiger Entwickler eines AI-nativen Produkts" |
| **Literal translation** | "Bildverarbeitungssoftware für Ölbohrinsel-Operationen" | "...für den Betrieb von Ölbohrinseln" |
| **Website link** | Displayed as the word "Website" · **two files pointed at a different site**: `resume_fulltime_pm` and `resume_fulltime_pm_de` linked to `vishalmaheshkumar.github.io`, the other six to `vishalmaheshkumar.com` | All 8 now display the literal `vishalmaheshkumar.com` and link to `https://vishalmaheshkumar.com/`. Survives printing and PDF-to-text parsing, where a bare "Website" hyperlink loses its destination |
| **TÜV SÜD entry** | Titled by deliverable — "TÜV SÜD: Capability-to-Account Mapping Assistant (RWTH Service Innovation Lab)" — with two dense bullets | Retitled by role: "Consultant – Applied AI (Artificial Intelligence) for Key Account Management \|\| TÜV SÜD (via RWTH Service Innovation Lab)" / DE equivalent. Bullets condensed; "via RWTH Service Innovation Lab" retained so it reads honestly as a university consulting engagement, not a TÜV SÜD payroll role |
| **Relocation** | Not stated anywhere | Added twice per file: header line — "Aachen, Germany (open to relocation within Germany)" / "Aachen, Deutschland (bundesweit umzugsbereit)" — and at the end of the profile summary |
| **Wolflayer stage** | "Currently in user testing and building stage under Collective Incubator" — vague | "Running structured user-testing cycles with early users and iterating on the product; currently part of Collective Incubator, Aachen" — added to the dev variants too, which previously omitted it |

Per your instruction, Wolflayer remains an **employment entry** on the two PM resumes and a **project entry** on the two dev resumes.

---

## 4. Skim optimisation and voice (second pass)

### What is bold, and why
A recruiter's first pass is ~6–10 seconds. Bold is now used sparingly so that the eye lands on the four things that actually decide the shortlist:

1. **Hard numbers** — `~60%`, `~150 KAMs`, `5 AI use cases`, `2–5 days to under 1 day`, `1st Place`
2. **The defining technology of each bullet** — `ServiceNow to AWS`, `Robust Transform Engine (RTE)`, `OpenAI Model Context Protocol`, `Next.js, React, TypeScript, Supabase`, `Google Gemini`, `CMDB`
3. **The leading verb** — Designed, Built, Implemented, Led, Created, Processed
4. **In the summary only:** years of experience, availability date, and relocation/hours

Each bullet carries at most three bold spans, and no single term is bolded more than twice per document — otherwise everything is bold and nothing is.

**Deliberately not bolded:** "Assisted in developing and maintaining" / "Mitarbeit" / "Umfangreiche Arbeit". These are honest but weak phrasings; bolding them would draw the eye straight to your least impressive line.

### AI-sounding phrasing removed
| Was | Now |
|---|---|
| "Technical product builder bridging enterprise software engineering and AI-native product strategy" | "Engineer moving into product." |
| "roles where engineering depth and stakeholder fluency both matter" | "Looking for AI solutions or technical product manager roles." |
| "Defined product **wedge** in the AI-tools space" | "Positioned the product in the AI tools market" |
| "working at the **seam between** enterprise data and emerging LLM workflows" | *deleted* |
| "inventory ingestion **at scale**" | "inventory ingestion" |
| "Subcategories **driving structured** CMDB mapping" | "Subcategories used for CMDB mapping" |
| "user-testing cycles ... **and iterating on the product**" | "user-testing rounds with early users" |
| "**A/B reasoning**" (not a real thing) | "A/B testing" |
| "**roadmap thinking**" | "roadmap planning" |
| "OAuth; **can talk credibly with engineering teams**" | *deleted — defensive, and the experience section already proves it* |
| DE: "Definition des **Produkt-USP**" · "**im Unternehmenskontext**" | "Positionierung des Produkts" · *deleted* |

All 8 profile summaries were rewritten in plainer language. No facts changed.

### Formatting bug fixed
The Languages/Sprachen line added in the first pass was rendering **entirely bold** in `resume_fulltime_dev.docx` and `resume_fulltime_dev_de.docx` (it inherited formatting from the row above). Only the label is bold now. Leftover empty runs from the editing passes were also stripped.

---

## 5. Open items — your call

1. **Wolflayer technical claims** (AES-256-GCM credential encryption, RBAC, OAuth with GitHub + Google, the `collabo_tree` → `collabo_space` bridge) could not be verified against any source document. They are your own project so presumably accurate — just confirm the encryption claim specifically, since "AES-256-GCM" is the kind of detail a security-minded interviewer will probe (key derivation? where is the key stored?).
2. **Sep 2025 – Oct 2025 gap** on the dev resumes: Flexera ended Sep 2025, the M.Sc. starts Oct 2025. One month, not worth explaining, but expect the question on the PM versions where Wolflayer only starts Mar 2026.
3. **`fulltime_pm` omits the Go certification** while the other three list it. Intentional PM targeting — left as-is, but flagging in case you want all four consistent.
4. **B.E. vs B.Eng.** — the German files render your degree as "B.Eng. Elektronik & Telekommunikation". An Indian B.E. is a 4-year Bachelor of Engineering, so this is a fair equivalence, but if a German employer asks for the exact title, say "Bachelor of Engineering (B.E.)".

---

## 6. Files changed

`resume_fulltime_dev.docx` · `resume_fulltime_dev_de.docx` · `resume_fulltime_pm.docx` · `resume_fulltime_pm_de.docx` · `resume_werk_dev.docx` · `resume_werk_dev_de.docx` · `resume_werk_pm.docx` · `resume_werk_pm_de.docx`

All edits were made in place; formatting, styles and layout are unchanged. Originals are recoverable via `git checkout -- <file>`.
