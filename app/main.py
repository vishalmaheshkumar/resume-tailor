"""
Resume Tailor Backend v5 — Strategic Multi-Track System

Two-stage Gemini pipeline:
  1. ANALYZE: fit score + ATS keywords + track suggestion + project picks
  2. TAILOR:  resume content using analysis + strict truth anchor

Truth anchor = full technical inventory of Vishal's ACTUAL work.
Gemini is explicitly forbidden from inventing anything outside it.
"""

import os
import re
import io
import json
import base64
import tempfile
import subprocess
import shutil
import signal
import zipfile
from pathlib import Path
from typing import Optional, List

import httpx
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    DictionaryObject, NameObject, ArrayObject, NumberObject,
    TextStringObject, FloatObject
)
from fastapi import FastAPI, HTTPException, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Resume Tailor API v5")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cover-Letter-Pdf", "Content-Disposition"],
)

GEMINI_KEY = os.environ.get("GEMINI_KEY", "")

# Strings users type as placeholders during testing — strip silently
PLACEHOLDER_VALUES = {
    "test", "test1", "test2", "test123", "test1234", "test12345",
    "xxx", "xxxxx", "tbd", "n/a", "na", "asdf", "qwerty",
    "abc", "123", "1234", "12345", "lorem", "ipsum",
    "placeholder", "company", "role", "title", "x", "xx",
    "company name", "job title", "role title",
}

def clean_placeholder(value: str) -> str:
    """Return empty string if value looks like a placeholder, else the trimmed value."""
    if not value:
        return ""
    v = value.strip()
    if not v:
        return ""
    if v.lower() in PLACEHOLDER_VALUES:
        return ""
    # Also catch repeated chars (xxx, aaa, ----)
    if len(set(v.lower())) <= 2 and len(v) <= 8:
        return ""
    return v
# Per-track resume templates. Only the PROFESSIONAL SUMMARY paragraph (identified by its stable
# w14:paraId) is rewritten by Gemini — skills, bullets, education, certs, and projects are final,
# hand-authored content and stay untouched. EN/DE docs share identical paraIds (DE was translated
# from the same source), so both slots use the same summary_para_id per track.
TRACK_TEMPLATES = {
    "fulltime_dev": {
        "en": {
            "path": Path(__file__).parent / "resume_fulltime_dev.docx",
            "summary_para_id": "509E3F0B",
        },
        "de": {
            "path": Path(__file__).parent / "resume_fulltime_dev_de.docx",
            "summary_para_id": "509E3F0B",
        },
    },
    "werk_dev": {
        "en": {
            "path": Path(__file__).parent / "resume_werk_dev.docx",
            "summary_para_id": "6D2F69FE",
        },
        "de": {
            "path": Path(__file__).parent / "resume_werk_dev_de.docx",
            "summary_para_id": "6D2F69FE",
        },
    },
    "fulltime_pm": {
        "en": {
            "path": Path(__file__).parent / "resume_fulltime_pm.docx",
            "summary_para_id": "1E81F3C6",
        },
        "de": {
            "path": Path(__file__).parent / "resume_fulltime_pm_de.docx",
            "summary_para_id": "1E81F3C6",
        },
    },
    "werk_pm": {
        "en": {
            "path": Path(__file__).parent / "resume_werk_pm.docx",
            "summary_para_id": "59618F30",
        },
        "de": {
            "path": Path(__file__).parent / "resume_werk_pm_de.docx",
            "summary_para_id": "59618F30",
        },
    },
}
CL_DOCX_PATH = Path(__file__).parent / "cover_letter_template.docx"

# Current Gemini models per https://ai.google.dev/gemini-api/docs/models (verified Jul 2026)
# Waterfall — tries each in order; uses next on rate limit / overload / unavailable.
# NOTE: "gemini-2.5-flash-lite" was retired ("no longer available to new users") — do not
# re-add the bare alias, it will always 400. gemini-2.5-pro kept last as a guaranteed-real
# safety net in case the newer aliases below get renamed again.
GEMINI_MODELS = [
    "gemini-2.5-flash",          # primary — stable, well-tested
    "gemini-3-flash-preview",    # current preview — Google's official example model
    "gemini-3.5-flash-lite",     # cheap fallback for high-load periods
    "gemini-2.5-pro",            # last-resort safety net — slower/pricier but long-lived
]

# Text → URL mapping for clickable link injection in PDFs.
# These exact strings appear in template_en.docx and template_de.docx.
PDF_LINK_MAP = {
    "LinkedIn Profile":       "https://www.linkedin.com/in/vishal-mahesh-kumar-a29049184/",
    "Website":                "https://vishalmaheshkumar.github.io/",
    "vishalm.rwth@gmail.com": "mailto:vishalm.rwth@gmail.com",
}

# Cover letter has different sidebar text — different link map
CL_PDF_LINK_MAP = {
    "Click LinkedIn":              "https://www.linkedin.com/in/vishal-mahesh-kumar-a29049184/",
    "vishalmaheshkumar.github.io": "https://vishalmaheshkumar.github.io/",
    "vishalm.rwth@gmail.com":      "mailto:vishalm.rwth@gmail.com",
}

# Sidebar label translations applied when cl_lang == "de"
CL_SIDEBAR_DE = [
    ("Aachen, Germany",        "Aachen, Deutschland"),
    ("RWTH AACHEN, Germany",   "RWTH AACHEN, Deutschland"),
    ("Ph: ",                   "Tel: "),
    ("Email: ",                "E-Mail: "),
    ("Website : ",             "Webseite: "),
    ("QR code for Website: ",  "QR-Code für Webseite: "),
    ("QR code for LinkedIn: ", "QR-Code für LinkedIn: "),
]

# ═══════════════════════════════════════════════════════════════════
# TRUTH ANCHOR — Vishal's actual verified experience
# This is the ONLY source of truth Gemini may use.
# ═══════════════════════════════════════════════════════════════════
TRUTH_ANCHOR = """
===== VISHAL'S VERIFIED EXPERIENCE — SINGLE SOURCE OF TRUTH =====

IDENTITY:
- Vishal Mahesh Kumar, Aachen, Germany
- M.Sc. Management & Engineering in Technology, Innovation, Marketing & Entrepreneurship
  (MME-TIME) at RWTH Aachen University Business School, Oct 2025 – Mar 2027
- RWTH modules: Data Analysis, Strategic Management, Innovation Management,
  Marketing Management, Leadership, Qualitative Research Methods
- B.E. Electronics & Telecommunication, RV College of Engineering Bangalore, Aug 2018 – Aug 2022

CERTIFICATIONS (all real, all completed):
- ServiceNow Certified System Administrator (CSA) – Professional Exam
- ServiceNow Certified Application Developer (CAD) – Professional Exam
- Google Foundations of Project Management (Coursera)
- Go: The Complete Developer's Guide (Udemy)
- Vector Database Fundamentals – A.I (Udemy)
- Introduction to Embedded System Design (NPTEL)

LANGUAGES:
- English: Professional
- German: Starting (A1)
- Hindi: Intermediate
- Kannada: Professional

===== PROFESSIONAL EXPERIENCE — FLEXERA SOFTWARE (Sep 2022 – Sep 2025) =====
US-based enterprise SaaS product company.
Promoted after 7 months: Associate SE → Software Development Engineer (R&D).

1. SCOPED APPLICATIONS
   - Worked extensively on FlexeraOne and Flexera Integration ServiceNow scoped apps
   - Integrations with Flexera FNMS (FlexNet Manager Suit), DataPlatform, IT Visibility (ITV)
   - Hardware and software inventory scoped app: data modeling, fields, business logic

2. TABLES & DATA MODELING
   - Computer table, Network Gear table
   - Designed mapping logic based on Hardware Category
   - Added fields: Hardware Category, Hardware Subcategory, OS Category, OS Subcategory, OS Name
   - Removed fields: Platform Label, Platform Type

3. SERVER-SIDE SCRIPTING
   - Modified/maintained Script Includes for business logic, data transformation, validation
   - Classification logic: Computer vs Network Gear
   - Pre-processing: RAM and Disk Space calculation before API execution

4. SERVICENOW REST APIs
   - Consumed with sysparm_limit, sysparm_offset (pagination)
   - Designed SMART REST APIs with:
     * Record validation rules
     * Mandatory field enforcement (OpCode, SoftwareID, HardwareID)
     * Conditional date-pair validation
     * Filtering invalid records before persistence
     * Response structuring with total count and pagination headers

5. ROBUST TRANSFORM ENGINE (RTE)
   - Designed and enhanced RTE pipelines for inventory ingestion
   - Mandatory field and lifecycle date-pair validation within RTE
   - Filter invalid records prior to CMDB insertion

6. CMDB / ASSET MANAGEMENT
   - Hardware Inventory: field restructuring, CI classification
   - Software Inventory: linking installations to devices
   - Rule-based classification: Computer/Display → Computer; Network → Network Gear
   - Data Normalization

7. NETWORK ADAPTER PROCESSING
   - Real-time network adapter event processing
   - Mapping network interface data → Network Gear table
   - Software installations linked to network devices

8. DATA ARCHITECTURE
   - API schemas with mandatory/optional fields
   - Structured Technopedia-style metadata
   - Versioning: Version, VersionGroup, Edition, Release
   - Product hierarchy: Category, Subcategory

9. BUSINESS RULES
   - Synchronous and asynchronous Business Rules for data consistency

10. ARCHITECTURAL MIGRATION (HEADLINE ACHIEVEMENT)
    - 70% product architecture redesign
    - Migrated ETL functionalities from ServiceNow → AWS
    - Developed SMART APIs reducing customer load — ~60% performance improvement

11. PROTOTYPES & INNOVATION
    - GraphQL prototypes for ServiceNow data querying
    - MCP (Model Context Protocol) prototypes using OpenAI APIs for AI-assisted workflows
    - Proof-of-Concepts for product merging initiatives

12. AUTOMATED TESTING
    - Built ATF (Automated Testing Framework) for ServiceNow
    - Built internal Golang tools to automate cross-component testing

13. CUSTOMER & CROSS-FUNCTIONAL
    - Trained technical support team on technology aspects
    - Direct customer interactions across NAM, Europe, APAC (Australia) regions
    - Service provider and vendor management (Bristlecone, HCL)
    - Debugging complex technical challenges, ensuring customer success

14. ASSOCIATE SE PHASE (Sep 2022 – Apr 2023)
    - Flexera SaaS Manager platform — API research and integration
    - SaaS apps: MongoDB, PostgreSQL, AWS S3, CloudWatch
    - Dynamic device mapping into Computer/Network Gear tables via transformer logic
    - Reusable Script Includes for validation, CMDB mapping, API response formatting
    - Recognized with Professionalism Badge for research and cross-team collaboration
    - Supported debugging critical production issues

===== INTERNSHIP =====
Software Engineer Intern — Deevia Software India Pvt Ltd (Mar 2022 – Aug 2022)
- Image processing software for oil rigs using Python, C++, OpenCV

===== PROJECT PORTFOLIO (pick by JD relevance) =====

P1. Ashwa Racing — Formula Student Hybrid Vehicle Project (2018–2022, 4 years)
    - Designed Vehicle Control Unit (VCU) and Data Acquisition System (DAQ)
    - Texas Instruments CC1390 wireless MCU for real-time telemetry
    - Managed Electrical & Testing subsystem, recruited and trained juniors
    - Won 1st Place — Formula Hybrid 2021 (USA) under IEEE & Formula Student
    - Participated Formula Bharat (India), Combustion Category
    TAGS: leadership, cross-functional, embedded, automotive, hardware, international win, mentorship

P2. WIRIN — Indian Institute of Science (IISc) Project Intern
    - Developed Distronic System for Driver Assistance (driverless car research)
    - Research role at IISc Bangalore (India's top research institution)
    TAGS: research, automotive, ADAS, autonomous driving, AI/ML

P3. IoT Research Project
    - Sensor data collection + cloud analysis system
    - ATmega328p, ESP8266 Wi-Fi, ThingSpeak Cloud
    TAGS: IoT, embedded, cloud, sensors

P4. AI Resume Tailoring Tool (PERSONAL SIDE PROJECT, recent)
    - Small personal web tool built with LLM APIs (Anthropic/Gemini)
    - Word-level diff, JD-driven tailoring for own job hunt
    TAGS: AI, LLM integration, personal project, self-initiated
    NOTE: Personal project — DO NOT claim as professional React experience

P5. Job Scanner Application (PERSONAL SIDE PROJECT, recent)
    - Personal tool with live search across LinkedIn, Indeed, StepStone
    TAGS: API integration, automation, personal project, self-initiated
    NOTE: Personal project — DO NOT claim as professional web dev experience

P6. BlastMap AI (CONCEPT based on CMDB work)
    - CMDB blast radius analyzer — downstream impact of CI changes
    TAGS: CMDB, enterprise IT, impact analysis, AI, visualization

P7. MCP Prototype (during Flexera)
    - Natural-language ServiceNow ops via OpenAI Model Context Protocol
    TAGS: AI, MCP, emerging tech, enterprise AI, ServiceNow

P8. Wolflayer — AI Collaboration Platform (PERSONAL PROJECT, recent; LIVE at wolflayer.app)
    - Solo-built and deployed; live and publicly accessible via Google sign-in
    - Full-stack real-time platform: Next.js 16, React 19, TypeScript, Supabase (Postgres/Auth/Realtime)
    - Role-based access control across multiple real-time channel types
    - AI workspace on Google Gemini: branching conversation graph with lineage-scoped context
    - Visual workflow-execution engine (node graph, topological scheduling)
    - OAuth integrations (GitHub, Google); AES-256-GCM encryption for stored credentials
    - Owned end-to-end: problem definition, scope, architecture, roadmap
    - Currently in user testing / active build stage under Collective Incubator (Aachen, Germany)
    TAGS: full-stack, AI, LLM, Next.js, React, Supabase, real-time, workflow automation, OAuth, product ownership, solo founder, self-initiated, live product
    NOTE: Personal solo project — built by one person, NOT a company, NOT a team, no paying users.
    Real and live (verifiable at wolflayer.app), so full-stack/Next.js/React/Supabase ARE
    genuine here (unlike P4/P5). On dev tracks emphasize the engineering; on PM tracks emphasize
    end-to-end product ownership. NEVER claim a team, revenue, user counts, or scale. Only the
    verified capabilities above — do not invent features.

P9. TÜV SÜD — Capability-to-Account Mapping Assistant (RWTH Service Innovation Lab, consulting project)
    - Led a 5-person student team advising TÜV SÜD's Key Account Management (KAM) organization
      (~150 KAMs, ~20% of TÜV SÜD's customer base)
    - Scoped 5 AI use cases across the account-management lifecycle
    - Designed a 4-pillar enterprise architecture model (Data, Tech, Org, Governance) in draw.io
    - Pitched a 9-month pilot roadmap to TÜV SÜD KAM leadership
    TAGS: enterprise architecture, AI strategy, consulting, stakeholder management, team leadership,
    account management, governance

===== EXTRACURRICULAR =====
- Innovation Team Member, Enactus Aachen e.V. (current)
- 400+ hours community service supporting education in remote regions

===== KEY ACHIEVEMENTS =====
- Formula Hybrid 2021 USA: 1st Place, Hybrid Category
- Promoted at Flexera (Associate → SDE) after 7 months
- Flexera Professionalism Badge
"""


# ═══════════════════════════════════════════════════════════════════
# AUTOFILL PROFILE — personal/legal/contact details for application FORM FIELDS.
# Separate from TRUTH_ANCHOR (which is the curated professional narrative used for resume
# tailoring) since forms ask for things a resume never does: address, DOB, work-permit status,
# salary expectations, etc. Deliberately contains NO credentials — password fields are always
# skipped client-side; never put a real password in source code.
# ═══════════════════════════════════════════════════════════════════
AUTOFILL_PROFILE = """
=== PERSONAL INFORMATION ===
Full Name: Vishal Mahesh Kumar
Salutation: Mr. / Herr
First Name: Vishal
Last Name: Mahesh Kumar
Date of Birth: 14 Feb 2000
Preferred Name: Vishal
Email: vishalm.rwth@gmail.com
Phone: +49 152 07480366
  Country code: +49 (Germany)
  Area code (without leading 0): 152
  Number: 07480366
Address: Franzstraße 107, 52064 Aachen, Nordrhein-Westfalen, Germany
LinkedIn: https://www.linkedin.com/in/vishal-mahesh-kumar-a29049184/
Website/Portfolio: https://vishalmaheshkumar.github.io/
Nationality: Indian
Gender: Male / Männlich
Date of Birth Country: India

=== LEGAL & WORK STATUS ===
EU/EEA/Swiss/UK Citizen: No (I am an Indian citizen)
German Work Permit: Yes — I hold a German student visa (Aufenthaltstitel) that permits Werkstudent employment up to 20 hours/week during semester, full-time during semester breaks
Disability: No
Available from: 01 July 2026 (format as needed: 01/07/2026 or 2026-07-01)
Salary Expectation: Leave blank if asked for a number. If forced, ~15-18 EUR/hour for Werkstudent
Currency: EUR
Willingness to Travel: Yes / Up to 25%
Former Employee at company being applied to: No (unless applying to Flexera)
Employee Referral: No — unless I specifically mention one

=== EDUCATION ===
Current: M.Sc. Management & Engineering in Technology, Innovation, Marketing & Entrepreneurship (MME-TIME)
University: RWTH Aachen University — Business School, Germany
Duration: October 2025 – March 2027 (expected graduation)
Status: Full-time student, can switch to part-time if offered full-time employment
Relevant Modules: Data Analysis, Strategic Management, Innovation Management, Marketing Management, Leadership, Qualitative Research Methods

Previous: B.E. Electronics and Telecommunication Engineering
University: RV College of Engineering, Bangalore, India
Duration: August 2018 – August 2022

=== LANGUAGES ===
English: C1 / Professional / Verhandlungssicher
German: A1 / Beginner / Anfänger (actively learning)
Hindi: Intermediate
Kannada: Professional Level

=== CERTIFICATIONS ===
- ServiceNow Certified System Administrator (CSA) — Professional Exam
- ServiceNow Certified Application Developer (CAD) — Professional Exam
- Google Foundations of Project Management (Coursera)
- Go: The Complete Developer's Guide (Udemy)
- Vector Database Fundamentals — AI (Udemy)
- Introduction to Embedded System Design (NPTEL)

=== PROFESSIONAL EXPERIENCE (3+ years) ===

Software Development Engineer (R&D) — Flexera Software (US-based enterprise SaaS company)
Promoted | April 2023 – September 2025
- Worked on "FlexeraOne" and "Flexera Integration" ServiceNow scoped applications
- Redesigned product architecture (70% transformation), migrating ETL from ServiceNow to AWS
- Developed SMART REST APIs reducing customer load, improving performance by 60%
- Built prototypes with GraphQL, Model Context Protocol (MCP) using OpenAI API
- Experience with ServiceNow CMDB, Data Normalization, Robust Transform Engine, Transform Maps
- Trained technical support team, interacted with customers and service providers
- Managed vendor relationships with Bristlecone and HCL
- Built automated testing frameworks (ATF) for ServiceNow
- Worked in global team with colleagues from US, Europe, and Australia

Associate Software Engineer — Flexera Software
September 2022 – April 2023
- Worked on Flexera SaaS Manager — API research and integration
- Developed with MongoDB, PostgreSQL, AWS S3, CloudWatch
- Recognized with Professionalism Badge for research and collaboration
- Supported cross-functional teams debugging critical issues

Software Engineer Intern — Deevia Software India Pvt Ltd
March 2022 – August 2022
- Developed image processing software for oil rigs using Python, C++, OpenCV

=== TECHNICAL SKILLS ===
ServiceNow: Scoped Applications, CMDB, Robust Transform Engine (RTE), Transform Maps, Business Rules, Script Includes, Data Normalization, ITAM, HAM, SAM
Backend & Integration: REST API Design, GraphQL, Server-Side JavaScript, Golang
AI & Protocols: OpenAI MCP (Model Context Protocol)
Cloud & Databases: AWS, MongoDB, PostgreSQL, S3, CloudWatch
Tools: JIRA, Confluence, Git, Agile Scrum, Microsoft Office
Product Management: Stakeholder Coordination, Customer Interactions, Agile Scrum

=== KEY PROJECTS ===
1. Wolflayer (wolflayer.app) — live solo-built AI collaboration platform on Next.js, React, Supabase
2. AI Resume Tailoring Tool — personal tool with LLM APIs and word-level diffs
3. Job Scanner Application — personal tool with live search across LinkedIn, Indeed, StepStone
4. BlastMap AI — CMDB blast radius analyzer concept
5. MCP Prototype — natural-language ServiceNow operations using OpenAI API
6. TÜV SÜD Capability-to-Account Mapping Assistant — RWTH Service Innovation Lab consulting project

=== ACHIEVEMENTS ===
- Formula Hybrid 2021 (USA) — 1st Place in Hybrid Category (under IEEE & Formula Student)
- Designed Vehicle Control Unit (VCU) and Data Acquisition System (DAQ) for hybrid race vehicles
- Managed Electrical & Testing subsystem, recruited and trained junior team members
- WIRIN Project at Indian Institute of Science (IISc) — Developed Distronic System for driverless car
- Innovation Team Member, Enactus Aachen e.V.
- 400+ hours of community service supporting education initiatives

=== CAREER GOALS ===
Seeking: Werkstudent or Internship roles in Product Management, Product Owner, or Technical PM
Also open to: Full-time PM/engineering roles (can switch to part-time studies)
Target profile: Technical Product Manager bridging engineering and business
Strengths: Unique combination of 3 years enterprise SaaS development + management master's degree
Differentiators: ServiceNow AI/MCP experience, dual certifications, Formula Student leadership, international team experience

=== PERSONALITY & WORK STYLE ===
- Collaborative team player with experience in cross-functional global teams
- Strong problem-solver with both technical depth and business understanding
- Proactive communicator who bridges technical and non-technical stakeholders
- Passionate about technology-driven innovation and product thinking
- Quick learner who adapts to new technologies and environments
"""


# ═══════════════════════════════════════════════════════════════════
# REQUEST SCHEMAS
# ═══════════════════════════════════════════════════════════════════
class AnalyzeRequest(BaseModel):
    jd:      str
    company: str = ""


class TailorRequest(BaseModel):
    jd:                   str
    track:                str
    custom_title:         str = ""
    company:              str = ""
    resume_lang:          str = "en"   # en | de
    cover_letter:         bool = False
    cl_lang:              str = "en"
    special_instructions: str = ""
    fit_score:            int = 7
    ats_keywords:         List[str] = []
    projects:             List[str] = []


class AutofillRequest(BaseModel):
    page_context: str = ""
    # Field shape varies a lot (selects have options, checkboxes have checked, etc.) — kept as
    # loose dicts rather than a strict schema; this is passthrough data for the prompt, not used
    # for any business logic here.
    fields: List[dict] = []


# ═══════════════════════════════════════════════════════════════════
# XML HELPERS
# ═══════════════════════════════════════════════════════════════════
def xml_enc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def xml_replace(xml: str, old_plain: str, new_plain: str) -> str:
    return xml.replace(xml_enc(old_plain), xml_enc(new_plain))


def find_paragraph(xml: str, para_id: str):
    """Return the re.Match for the <w:p> identified by w14:paraId, or None."""
    pattern = re.compile(
        r'<w:p\b[^>]*w14:paraId="' + re.escape(para_id) + r'"[^>]*>.*?</w:p>', re.S
    )
    return pattern.search(xml)


def replace_paragraph_text(xml: str, para_id: str, new_text: str) -> str:
    """Replace the visible text of the <w:p> identified by w14:paraId, preserving its
    paragraph properties (<w:pPr>, e.g. spacing/justification) but collapsing all runs
    (which real Word docs often split around <w:proofErr> spell-check markers) into one."""
    pattern = re.compile(
        r'(<w:p\b[^>]*w14:paraId="' + re.escape(para_id) + r'"[^>]*>)(.*?)(</w:p>)', re.S
    )
    m = pattern.search(xml)
    if not m:
        return xml
    opening, body, closing = m.groups()
    ppr_match = re.search(r"<w:pPr>.*?</w:pPr>", body, re.S)
    ppr = ppr_match.group(0) if ppr_match else ""
    new_run = f'<w:r><w:t xml:space="preserve">{xml_enc(new_text)}</w:t></w:r>'
    return xml[:m.start()] + opening + ppr + new_run + closing + xml[m.end():]


def assert_only_paragraph_changed(old_xml: str, new_xml: str, para_id: str) -> None:
    """Defense-in-depth for the AI resume tailoring path: the AI is only ever supposed to
    rewrite the PROFESSIONAL SUMMARY paragraph. Verify the patched document.xml differs from
    the original ONLY inside that paragraph's span — everything else (skills, bullets,
    education, certs, projects) must be byte-for-byte identical. Fails loudly instead of
    silently shipping a resume where something else got touched."""
    old_m, new_m = find_paragraph(old_xml, para_id), find_paragraph(new_xml, para_id)
    if not old_m or not new_m:
        raise HTTPException(500, "Resume patch integrity check failed: summary paragraph not found.")
    if old_xml[:old_m.start()] != new_xml[:new_m.start()] or old_xml[old_m.end():] != new_xml[new_m.end():]:
        raise HTTPException(
            500, "Resume patch integrity check failed: content outside the summary paragraph changed."
        )


# ═══════════════════════════════════════════════════════════════════
# GEMINI call with model waterfall
# ═══════════════════════════════════════════════════════════════════
async def call_gemini(prompt: str, temp: float = 0.35, max_tokens: int = 6000) -> dict:
    if not GEMINI_KEY:
        raise HTTPException(500, "GEMINI_KEY not set.")

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temp, "maxOutputTokens": max_tokens},
    }

    last_error = "Unknown"
    async with httpx.AsyncClient(timeout=90) as client:
        for model in GEMINI_MODELS:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
            try:
                r = await client.post(url, json=payload)
                data = r.json()

                if r.status_code != 200:
                    msg = data.get("error", {}).get("message", f"HTTP {r.status_code}")
                    last_error = f"{model}: {msg}"
                    msg_lower = msg.lower()

                    # Overload / rate limit → try next model
                    if r.status_code in (429, 503) or any(
                        s in msg_lower for s in [
                            "high demand", "overload", "resource_exhausted",
                            "rate limit", "quota exceeded"
                        ]
                    ):
                        continue

                    # Model dead / unavailable / deprecated → try next model
                    if r.status_code in (400, 404) or any(
                        s in msg_lower for s in [
                            "no longer available", "not found", "is not supported",
                            "deprecated", "has been shut down", "is not available"
                        ]
                    ):
                        print(f"[gemini] {model} is unavailable, trying next…")
                        continue

                    raise HTTPException(502, f"Gemini error: {msg}")

                if "error" in data:
                    last_error = f"{model}: {data['error'].get('message','')}"
                    continue

                text = data["candidates"][0]["content"]["parts"][0]["text"]
                text = re.sub(r"^```(?:json)?\s*", "", text).strip().rstrip("` \n")
                # Most prompts ask for a top-level object; /autofill asks for a top-level array —
                # slice out whichever bracket pair appears first (object vs array), not just "{...}".
                brace, bracket = text.find("{"), text.find("[")
                if brace == -1 and bracket == -1:
                    pass
                elif brace == -1 or (bracket != -1 and bracket < brace):
                    text = text[bracket:text.rfind("]") + 1]
                else:
                    text = text[brace:text.rfind("}") + 1]
                return json.loads(text)

            except HTTPException:
                raise
            except (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError) as ex:
                last_error = f"{model}: {ex}"
                continue
            except json.JSONDecodeError as ex:
                last_error = f"{model}: JSON — {ex}"
                continue

    raise HTTPException(503, f"All Gemini models failed. Last: {last_error}")


# ═══════════════════════════════════════════════════════════════════
# STAGE 1 — ANALYZE prompt
# ═══════════════════════════════════════════════════════════════════
def build_analyze_prompt(jd: str, company: str) -> str:
    return f"""You are an ATS-aware career strategist analyzing a job description for Vishal Mahesh Kumar.

{TRUTH_ANCHOR}

===== JOB DESCRIPTION =====
Company: {company or "(not specified)"}
{jd[:5000]}

===== YOUR TASK =====

1. **track_suggestion** — choose ONE:
   - "fulltime_dev"  — Full-Time ServiceNow/Platform/Integration Developer (Vollzeit/unbefristet/Festanstellung/permanent)
   - "werk_dev"      — Werkstudent/Praktikum Software/IT/Developer (part-time, student role)
   - "werk_pm"       — Werkstudent/Praktikum Product Manager/Enterprise Architect/IT Strategy/Governance
   - "fulltime_pm"   — Full-Time Product Manager/Product Owner

   Logic:
   - Full-time flags: Vollzeit, unbefristet, Festanstellung, permanent, full-time → fulltime_*
   - PM flags: Product Manager, Product Owner, Roadmap, Stakeholder, Digitalisierung, Enterprise Architecture, IT Strategy, Governance, Application Portfolio, LeanIX → *_pm
   - Otherwise → *_dev

2. **fit_score** (integer 1-10):
   10 = Perfect fit (ServiceNow/CMDB/ITAM dev OR PM role using enterprise IT platform experience)
   7-9 = Strong (adjacent tech, skills clearly apply)
   5-6 = Moderate (some gaps, needs spin)
   3-4 = Weak (significant gaps, stretching required)
   1-2 = Poor (unrelated field, too senior, wrong domain)

3. **ats_keywords** (8-12 keywords, max 3 words each):
   CRITICAL: Only include keywords Vishal GENUINELY has experience with per the TRUTH ANCHOR.

   Vishal has NEVER used at work (DO NOT INCLUDE as professional experience): Shopify, HubSpot,
   Salesforce, SAP, LeanIX, Kubernetes, Docker production, Terraform, Azure, GCP, Google Cloud,
   Jenkins, Snowflake, Databricks, Tableau, PowerBI, Figma, Adobe, any CRM, any marketing tool,
   any e-commerce/D2C platform, Next.js, Vue, Angular, Node.js backend, TypeScript production,
   React Native, Flutter, mobile development, Terraform, Ansible, Spring Boot, .NET, Ruby, PHP.

   React: ONLY mention in personal projects context (AI Resume Tool, Job Scanner) — NEVER claim
   "3 years React experience" or put it in main skills. Do not list React in skill categories
   unless the JD specifically asks for React AND you're framing it as a personal project skill.

   Vishal DOES have (professional enterprise experience):
   ServiceNow (CSA+CAD), CMDB, ITAM, REST APIs, GraphQL, Python, Golang, C++, JavaScript (server-side),
   AWS, MongoDB, PostgreSQL, JIRA, Confluence, Git, Agile Scrum, Stakeholder Management,
   Customer Interactions (NAM/EU/APAC), OpenAI API / MCP prototypes, Automated Testing (ATF).

   Return keywords in the JD's original language (English or German), NEVER wrap in backticks or quotes.
   Prefer specific (ServiceNow CMDB) over generic (software).

4. **projects** (array of 1-2 project IDs to emphasize):
   P1=Formula Student (leadership/automotive/embedded)
   P2=WIRIN IISc (research/ADAS/autonomous)
   P3=IoT (sensors/cloud/embedded)
   P4=AI Resume Tool (AI/LLM/React)
   P5=Job Scanner (React/automation)
   P6=BlastMap AI (CMDB/AI/impact analysis)
   P7=MCP Prototype (AI/emerging tech/ServiceNow AI)
   P8=Wolflayer (live full-stack AI product / Next.js+React+Supabase / workflow automation / product ownership — pick for dev OR PM roles, esp. AI/full-stack/product)
   P9=TÜV SÜD Capability-to-Account Mapping (enterprise architecture/AI strategy/consulting/team leadership — pick for PM/EA-leaning roles)

5. **missing_keywords** (0-6 keywords, max 3 words each):
   Tools/skills the JD explicitly asks for that Vishal genuinely does NOT have per the TRUTH ANCHOR
   (e.g. the JD wants Kubernetes, SAP, Salesforce, etc. and Vishal has never used them). This is an
   honest gap list for the candidate's own awareness — NOT used in the resume. Empty array if no
   meaningful gaps. Do not list a keyword here if it's also in ats_keywords.

6. **fit_rationale** (1-2 sentences, honest).

OUTPUT VALID JSON ONLY, NO MARKDOWN:
{{
  "track_suggestion": "werk_pm",
  "fit_score": 8,
  "ats_keywords": ["keyword1", "keyword2", "..."],
  "missing_keywords": ["keyword3", "..."],
  "projects": ["P6", "P7"],
  "fit_rationale": "Strong fit because..."
}}"""


# ═══════════════════════════════════════════════════════════════════
# TRACK-SPECIFIC CONFIG
# ═══════════════════════════════════════════════════════════════════
def track_config(track: str) -> dict:
    configs = {
        "fulltime_dev": {
            "persona": "ServiceNow engineer with 3yr enterprise production experience",
            "tone":    "Technical authority — 'Built', 'Designed', 'Implemented', 'Architected'",
            "emphasis": (
                "Lead with ServiceNow CSA+CAD certifications in summary, CMDB architecture depth, "
                "production scale. Own the work fully — never 'assisted in' or 'supported'. "
                "Platform engineer persona."
            ),
            "kill_list": (
                "Do NOT mention: Formula Student details, individual RWTH module names, "
                "MCP/OpenAI Protocol prominently (fine in skills), marketing."
            ),
            "availability": (
                "available for full-time engineering roles from September 2026, with option to "
                "switch program to my course part-time."
            ),
            "availability_de": (
                "verfügbar für Festanstellungen im Engineering ab September 2026 – bei Bedarf "
                "Wechsel auf Teilzeitstudium möglich."
            ),
        },
        "werk_dev": {
            "persona": "Master's student with real enterprise IT background, contributing alongside studies",
            "tone":    "Collaborative — 'Contributed to', 'Built alongside', 'Supported', 'Maintained'",
            "emphasis": (
                "Frame as strong contributor within Scrum teams, not solo lead engineer. "
                "Add availability prominently. Keep ServiceNow certs visible. "
                "Soften senior signals to avoid overqualification rejection."
            ),
            "kill_list": (
                "Do NOT mention: Golang, FlexeraOne/FNMS product names, "
                "MCP/OpenAI Protocol, deep AWS internals, '70% architecture redesign' "
                "(too senior-sounding for Werkstudent)."
            ),
            "availability": (
                "Seeking Werkstudent / intern engineering roles (~20 hrs/week during semester, "
                "up to 40 hrs in semester break)."
            ),
            "availability_de": (
                "Suche nach Werkstudenten- bzw. Praktikumsstellen im Engineering (ca. 20 "
                "Std./Woche im Semester, bis zu 40 Std. in der vorlesungsfreien Zeit)."
            ),
        },
        "werk_pm": {
            "persona": "Technical PM/EA candidate bridging platform delivery and strategic product thinking",
            "tone":    "Strategic + grounded — 'Identified', 'Drove', 'Led', 'Owned', 'Coordinated'",
            "emphasis": (
                "Every bullet reframed: problem → solution → outcome. "
                "CMDB work = 'enterprise data governance' not 'database coding'. "
                "API work = 'product interface design' not 'backend engineering'. "
                "Surface stakeholder coordination, cross-functional decisions, business impact. "
                "Summary leads with RWTH MME-TIME + strategic intent + Flexera grounding."
            ),
            "kill_list": (
                "ABSOLUTELY DO NOT mention anywhere (not in summary, bullets, skills, or cover letter): "
                "Robust Transform Engine, RTE, Transform Maps, Script Includes, Business Rules, "
                "Golang, AWS internals, sysparm_limit, sysparm_offset, MCP code-level details. "
                "These signal 'developer' and undermine the PM/EA candidacy. "
                "FlexeraOne/FNMS — mention sparingly as product context only, never as code."
            ),
            "availability": (
                "Seeking PM Werkstudent / intern roles (~20 hrs/week during semester, up to 40 "
                "hrs in semester break)."
            ),
            "availability_de": (
                "Suche nach PM-Werkstudenten-/Praktikumsstellen (ca. 20 Std./Woche im Semester, "
                "bis zu 40 Std. in der vorlesungsfreien Zeit)."
            ),
        },
        "fulltime_pm": {
            "persona": "Technical Product Manager with 3yr enterprise SaaS experience + management master's",
            "tone":    "Confident PM voice — 'Led', 'Owned', 'Drove', 'Defined', 'Prioritized'",
            "emphasis": (
                "Frame experience as product ownership. Highlight customer interactions across NAM/EU/APAC, "
                "cross-functional global coordination, architecture decisions, RWTH management studies. "
                "Bridge technical depth and business outcomes."
            ),
            "kill_list": (
                "Do NOT mention: deep code internals, RTE script-level work, "
                "low-level Script Includes implementation details."
            ),
            "availability": (
                "Target: AI Solutions / Technical Product Manager roles where engineering depth "
                "and stakeholder fluency both matter."
            ),
            "availability_de": (
                "Ziel: AI-Solutions- / Technical-Product-Manager-Rollen, in denen technische "
                "Tiefe und Stakeholder-Kommunikation gleichermaßen zählen."
            ),
        },
    }
    return configs.get(track, configs["fulltime_dev"])


# ═══════════════════════════════════════════════════════════════════
# STAGE 2 — TAILOR prompt
# ═══════════════════════════════════════════════════════════════════
def build_tailor_prompt(req: TailorRequest) -> str:
    cfg = track_config(req.track)
    closing_sentence = (
        cfg.get("availability_de", cfg["availability"])
        if req.resume_lang == "de" else cfg["availability"]
    )
    role = req.custom_title or ({
        "fulltime_dev": "ServiceNow Developer",
        "werk_dev":     "Working Student — IT / Software",
        "werk_pm":      "Working Student — Product / Strategy",
        "fulltime_pm":  "Technical Product Manager",
    }.get(req.track, "Software Engineer"))

    kw_section = ""
    if req.ats_keywords:
        kw_section = (
            "\n===== ATS KEYWORDS =====\n"
            "Integrate these phrases naturally in plain English (or plain German if that's the JD language).\n"
            "NEVER wrap them in backticks, quotes, or any special characters.\n"
            "ONLY use a keyword if Vishal has genuine experience with it per the TRUTH ANCHOR.\n"
            "If a keyword maps to something Vishal hasn't used, SKIP IT silently.\n"
            f"Keywords to try: {', '.join(req.ats_keywords)}\n"
        )

    proj_section = ""
    if req.projects:
        proj_map = {
            "P1": "Formula Student Hybrid (1st Place USA 2021) — leadership, embedded, automotive",
            "P2": "WIRIN @ IISc — Distronic System for driverless car, research role",
            "P3": "IoT Sensor Project — ATmega328p, ESP8266, ThingSpeak",
            "P4": "AI Resume Tailoring Tool — React + LLM APIs",
            "P5": "Job Scanner — React, multi-portal",
            "P6": "BlastMap AI — CMDB blast radius analyzer concept",
            "P7": "MCP Prototype — natural-language ServiceNow via OpenAI MCP",
            "P8": "Wolflayer (wolflayer.app) — live solo-built AI collaboration platform; Next.js 16/React 19/TypeScript/Supabase, branching AI workspace on Gemini, visual workflow engine, OAuth + AES-256-GCM; owned end-to-end",
            "P9": "TÜV SÜD Capability-to-Account Mapping Assistant (RWTH Service Innovation Lab) — led 5-person team, 4-pillar enterprise architecture, 9-month pilot roadmap",
        }
        proj_section = (
            "\n===== PROJECTS TO EMPHASIZE (mention at most 1 briefly in the summary) =====\n"
            + "\n".join(f"  {p}: {proj_map.get(p,'')}" for p in req.projects) + "\n"
        )

    company_line = f"Company: {req.company}\n" if req.company else ""

    lang_directive = ""
    if req.resume_lang == "de":
        lang_directive = (
            "\n===== RESUME LANGUAGE: GERMAN =====\n"
            "Write the summary in fluent professional German.\n"
            "Keep proper nouns in English (ServiceNow, Flexera, AWS, GraphQL, REST API, etc.).\n"
            "Use natural German technical vocabulary (Datenbank, Schnittstelle, Architektur, Skalierbar, Effizient).\n"
            "Do NOT translate certification names, tool names, or company names.\n"
            "NEVER wrap any word in backticks or quotes — write fluent prose.\n"
        )
    else:
        lang_directive = (
            "\n===== RESUME LANGUAGE: ENGLISH =====\n"
            "Write in clean professional English. NEVER mix German words into English text. "
            "NEVER wrap any word in backticks or quotes.\n"
        )

    special_block = ""
    if req.special_instructions and req.special_instructions.strip():
        special_block = (
            "\n===== ADDITIONAL USER INSTRUCTIONS (HIGH PRIORITY) =====\n"
            f"{req.special_instructions.strip()[:1500]}\n"
            "Follow these unless they conflict with TRUTH ANCHOR or absolute rules.\n"
        )

    return f"""You are an expert resume writer. You are rewriting ONLY the PROFESSIONAL SUMMARY
paragraph of Vishal's resume — every other section (skills, bullets, education, certifications,
projects) is final, hand-authored content and is NOT being touched. Do not reference or assume
you're rewriting anything else.

{TRUTH_ANCHOR}

===== TARGET =====
Track: {req.track}
Role Title: {role}
{company_line}Persona: {cfg['persona']}
Voice: {cfg['tone']}

===== JOB DESCRIPTION =====
{req.jd[:3500]}
{lang_directive}{special_block}
===== STRATEGY =====
EMPHASIS: {cfg['emphasis']}

KILL LIST (never mention these in the summary): {cfg['kill_list']}

CLOSING SENTENCE (must end the summary with this, verbatim, no paraphrasing): {closing_sentence}
{kw_section}{proj_section}
===== ABSOLUTE HARD RULES — VIOLATIONS = AUTO-REJECT =====

RULE 1 — ZERO HALLUCINATION:
- Only use facts/tools/technologies that appear EXPLICITLY in the TRUTH ANCHOR
- Vishal has NEVER used PROFESSIONALLY: Shopify, HubSpot, Salesforce, SAP, LeanIX, Kubernetes,
  Docker production, Terraform, Azure, GCP, Google Cloud, Jenkins, Snowflake, Databricks, Tableau,
  PowerBI, Figma, Adobe, any CRM, any marketing tool, any e-commerce/D2C platform, Vue,
  Angular, Node.js backend, React Native, Flutter, mobile dev, Ansible,
  Spring Boot, .NET, Ruby, PHP, Java production.
- Next.js, React, TypeScript, Supabase: REAL but ONLY via the Wolflayer personal project (P8,
  live at wolflayer.app) — never imply they were used professionally at Flexera.
- If the JD mentions a tool Vishal has never used: DO NOT include it anywhere.
- Missing 1 keyword is ALWAYS better than fabricating 1 keyword. Interviews catch lies.

RULE 2 — NO BACKTICKS, NO GERMAN QUOTED WORDS:
- NEVER wrap any word in backticks (`word`) or single-quotes in the output
- Write English naturally; write German naturally — NEVER mix them with quotes/backticks
- If the JD is in German but Vishal's resume is English, KEEP RESUME FULLY ENGLISH

RULE 3 — STRUCTURE + LENGTH (ONE-PAGE TARGET):
- Summary: 4-5 sentences, ~70-110 words total, ending with the CLOSING SENTENCE above
- Prefer punchy concrete language over verbose explanations. Cut filler words: "in order to" → "to", "demonstrating my ability to" → drop entirely.

RULE 4 — CONTENT QUALITY:
- Most JD-relevant fact first
- No filler phrases ("leveraging", "results-driven", "passionate about")
- Respect KILL LIST — those terms must not appear anywhere

RULE 5 — VOICE / GRAMMATICAL PERSON:
- Resume summary is in IMPLICIT FIRST PERSON — no "I", no "Vishal", no "he/she", no name
- WRONG: "Vishal is an M.Sc. candidate..." or "He has driven..."
- WRONG: "I am an M.Sc. candidate..."
- RIGHT: "M.Sc. candidate in Management & Engineering with 3+ years of enterprise SaaS experience..."
- RIGHT: "Combines technical foundation with strategic product thinking..."

===== OUTPUT — VALID JSON ONLY, NO MARKDOWN =====
{{
  "summary": "4-5 sentences tailored to this role, ending with the CLOSING SENTENCE verbatim."
}}"""


# ═══════════════════════════════════════════════════════════════════
# COVER LETTER prompt
# ═══════════════════════════════════════════════════════════════════
def build_cl_prompt(req: TailorRequest) -> str:
    cfg     = track_config(req.track)
    is_de   = req.cl_lang == "de"
    is_werk = req.track.startswith("werk")

    role = req.custom_title or ({
        "fulltime_dev": "ServiceNow Developer",
        "werk_dev":     "Working Student in IT / Software",
        "werk_pm":      "Working Student in Product / Strategy",
        "fulltime_pm":  "Technical Product Manager",
    }.get(req.track))

    hooks = {
        "fulltime_dev": (
            "Having spent ~3 years building ServiceNow CMDB integrations and RTE pipelines for "
            "enterprise clients at Flexera — including scoped applications, transform maps, and "
            "large-scale hardware/software inventory ingestion — I bring production-grade platform "
            "experience that maps directly to {company}'s {role} role."
        ),
        "werk_dev": (
            "Alongside my Master's at RWTH Aachen, I'm looking to contribute my background in "
            "ServiceNow, CMDB, and IT integrations to a practical Werkstudent role — {company}'s "
            "work aligns well with what I've been building since my time at Flexera."
        ),
        "werk_pm": (
            "{company}'s focus on (specific challenge from JD) aligns closely with the work I did at "
            "Flexera — designing and maintaining enterprise CMDB integrations that gave global clients "
            "a structured, accurate view of their IT assets. I'm looking to bring that combination of "
            "technical grounding and strategic thinking to the {role} role."
        ),
        "fulltime_pm": (
            "With ~3 years building enterprise ServiceNow products at Flexera — coordinating across "
            "customers, service providers, and global teams — and now pursuing an M.Sc. in Management & "
            "Engineering at RWTH Aachen, I bring a rare mix of technical depth and product thinking to "
            "the {role} role at {company}."
        ),
    }

    hook = hooks.get(req.track, hooks["werk_dev"]).format(
        company = req.company or "your company",
        role    = role,
    )

    length = (
        "3 focused paragraphs, ~200-250 words (Werkstudent recruiters skim)"
        if is_werk else
        "4-5 paragraphs, ~300-350 words"
    )

    lang_inst = (
        "Write 100% in GERMAN (formal Sie form, no 'du')."
        if is_de else
        "Write 100% in ENGLISH."
    )
    lang_note = (
        "GERMAN ONLY — every single sentence in fluent professional German. "
        "Keep proper nouns in English (ServiceNow, Flexera, AWS, RWTH Aachen, etc.) "
        "but write ALL connective text, verbs, adjectives, and sentences in German. "
        "Forbidden: starting a paragraph with 'Having spent...', 'At Flexera...', 'My M.Sc...'. "
        "Instead use: 'Mit fast drei Jahren...', 'Bei Flexera...', 'Mein Masterstudium...'. "
        "NEVER use backticks or quote-wrap words."
        if is_de else
        "ENGLISH ONLY — every sentence in fluent English. NEVER include German words or phrases (no 'Sehr geehrte', no 'Mit freundlichen Grüßen'). NEVER wrap any word in backticks or quotes."
    )

    return f"""Write a professional cover letter for Vishal Mahesh Kumar.

{TRUTH_ANCHOR}

===== TARGET =====
Role: {role}
Company: {req.company or "the hiring company"}
Track: {req.track}
Availability: {cfg['availability']}
Kill List (NEVER mention these): {cfg['kill_list']}

===== JOB DESCRIPTION =====
{req.jd[:2500]}
{(chr(10) + "===== ADDITIONAL USER INSTRUCTIONS =====" + chr(10) + req.special_instructions.strip()[:1000] + chr(10)) if req.special_instructions and req.special_instructions.strip() else ""}
===== OPENING HOOK (adapt naturally to the JD specifics) =====
{hook}

===== REQUIREMENTS =====
- {lang_inst}
- Length: {length}
- Structure: EXACTLY 5 body paragraphs, separated by \n\n (double newline)
- LENGTH IS CRITICAL — TOTAL must fit on ONE PAGE (sidebar template leaves ~9cm width):
  * Total word count: 200-240 words MAXIMUM (counting all 5 paragraphs combined)
  * Each paragraph: 35-55 words ONLY — short and punchy
  * If you exceed 240 words total, the cover letter overflows to page 2 — AUTO-REJECT
- Paragraph purposes (each 2-3 sentences MAX):
  Para 1 (hook): Company name + specific JD detail + why Vishal fits (2 sentences)
  Para 2 (experience): One concrete Flexera achievement mapped to JD requirements (2-3 sentences)
  Para 3 (studies): RWTH MME-TIME + 2-3 relevant modules (2 sentences)
  Para 4 (working style): Cross-functional / customer / leadership angle (2 sentences)
  Para 5 (closing): Availability + interest in conversation (1-2 sentences)

- NO greeting line (template already has "Sehr geehrtes Recruiting-Team,")
- NO sign-off (template already has "Mit freundlichen Grüßen / Vishal Mahesh Kumar")
- NO "Über eine Einladung..." line — template already has it
- Output ONLY the 5 body paragraphs separated by \n\n
- NEVER: "I am a highly motivated", "I am writing to apply", "Please find attached", generic filler
- NEVER wrap any word in backticks or quotes
- ONLY use facts from TRUTH ANCHOR — no Shopify/HubSpot/SAP/React-as-skill
- RESPECT the kill list for the track (e.g. for werk_pm: NO Golang, NO RTE/Transform Maps)
- Language: {lang_note}

===== OUTPUT — VALID JSON ONLY =====
{{"letter": "para1\\n\\npara2\\n\\npara3\\n\\npara4"}}"""


# ═══════════════════════════════════════════════════════════════════
# AUTOFILL prompt — application form field mapping
# ═══════════════════════════════════════════════════════════════════
def build_autofill_prompt(fields: list, page_context: str) -> str:
    return f"""You are an expert job application assistant helping Vishal fill out a job application form.

{AUTOFILL_PROFILE}

===== JOB PAGE CONTEXT =====
{page_context[:2000]}

===== FORM FIELDS FOUND =====
{json.dumps(fields)}

===== YOUR TASK =====
Fill every field with the best possible value. Follow these rules:

STANDARD FIELDS:
- For SELECT dropdowns: return the EXACT "v" (value attribute) from the options. Match carefully.
- For phone country code: pick GERMANY (+49). Do NOT pick Dominican Republic or any country that
  just contains "49" in a longer code string. Look for "Germany" in the option text.
- For date type="date": use YYYY-MM-DD format.
- For date with placeholder dd/mm/yyyy: use that format.
- "Former employee" = "No" (Vishal never worked at this company unless it's Flexera).
- "Employee referral" = "No".
- "EU/EEA citizen" = "No" (Indian citizen).
- Disability = "No" or "I do not wish to answer".
- NEVER fill a password-type field — always skip it, regardless of what else is on the page.

OPEN-ENDED / DESCRIPTION FIELDS (textareas, motivation, cover letter, "about you", "why interested"):
- Write compelling, professional, personalized responses.
- Reference the SPECIFIC job title and company from the page context.
- Highlight relevant experience from Vishal's profile that matches the job.
- Keep it concise but impactful — 3-5 sentences for short fields, 1-2 paragraphs for longer ones.
- Write in the SAME LANGUAGE as the form (German form = German answers, English form = English answers).
- For "about yourself" / "profile summary": emphasize the unique combination of 3 years enterprise
  software experience at a US SaaS company + RWTH management master's.
- For "why this company/role": connect Vishal's experience to what the company does.
- For "strengths" or "what do you bring": highlight technical depth + business understanding +
  international team experience.
- Do NOT be generic. Be specific about Vishal's actual projects and achievements.
- ONLY use facts present in the profile above — never invent skills, tools, or experience not
  listed there.

SKIP: file upload fields, password fields, fields you truly cannot determine.

RESPOND WITH ONLY A JSON ARRAY. No markdown, no backticks, no explanation.
Format: [{{"index":0,"value":"the value to fill"}}]
Include every field you can fill."""


# ═══════════════════════════════════════════════════════════════════
# DOCX PATCHING
# ═══════════════════════════════════════════════════════════════════

def patch_docx(track: str, resume_lang: str, ai: dict) -> bytes:
    """Replace ONLY the PROFESSIONAL SUMMARY paragraph in the track's static template.
    Skills, bullets, education, certs, and projects are final hand-authored content and
    are never touched here."""
    template = TRACK_TEMPLATES.get(track, {}).get(resume_lang)
    if not template:
        raise HTTPException(
            400, f"No '{resume_lang}' resume template available yet for track '{track}'."
        )
    docx_path = template["path"]
    if not docx_path.exists():
        raise HTTPException(500, f"Template missing: {docx_path.name}")

    with zipfile.ZipFile(io.BytesIO(docx_path.read_bytes()), "r") as zin:
        names    = zin.namelist()
        file_map = {n: zin.read(n) for n in names}

    xml = file_map["word/document.xml"].decode("utf-8")

    if ai.get("summary"):
        new_xml = replace_paragraph_text(xml, template["summary_para_id"], ai["summary"])
        assert_only_paragraph_changed(xml, new_xml, template["summary_para_id"])
        xml = new_xml

    file_map["word/document.xml"] = xml.encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, file_map[n])
    return out.getvalue()


# ═══════════════════════════════════════════════════════════════════
# COVER LETTER DOCX ANCHORS — body paragraphs
# ═══════════════════════════════════════════════════════════════════
CL_ORIG_PARAS = [
    # Para 1 — intro / hook
    "hiermit bewerbe ich mich um eine Werkstudentenposition im IT- bzw. Technologiebereich. Derzeit studiere ich Management &amp; Engineering (Technology, Innovation, Marketing &amp; Entrepreneurship) im Masterstudiengang an der RWTH Aachen University und bringe mehr als drei Jahre praktische Erfahrung im Software- und Enterprise-IT-Umfeld mit.",
    # Para 2 — experience detail
    "In meiner bisherigen beruflichen Tätigkeit war ich an der Entwicklung, Betreuung und Optimierung von IT-Systemen beteiligt. Dabei arbeitete ich unter anderem mit ServiceNow, CMDB, IT Asset Management, REST- und GraphQL-APIs, sowie mit Programmiersprachen wie JavaScript, Golang, Python und C++. Zusätzlich habe ich Erfahrung im Umgang mit Cloud-Umgebungen (AWS), Datenbanken und strukturierten Datenverarbeitungsprozessen. Mein Fokus lag dabei stets auf stabilen, wartbaren und skalierbaren IT-Lösungen.",
    # Para 3 — studies
    "Aktuell vertiefe ich im Studium insbesondere meine Kenntnisse in den Bereichen Data Analysis, Strategic Management, Innovation Management, Marketing Management, Leadership sowie Qualitative Research Methods. Diese Inhalte ermöglichen es mir, technische Fragestellungen nicht nur aus Entwickler-, sondern auch aus prozessualer und betriebswirtschaftlicher Perspektive zu betrachten.",
    # Para 4 — cross-functional
    "Neben der technischen Umsetzung habe ich regelmäßig mit unterschiedlichen Fachbereichen zusammengearbeitet, technische Sachverhalte verständlich aufbereitet und operative Abläufe unterstützt. Dadurch konnte ich ein gutes Verständnis für IT-Prozesse, Systemzuverlässigkeit und praxisorientierte Problemlösung entwickeln.",
    # Para 5 — closing pitch
    "Ich arbeite strukturiert, verantwortungsbewusst und eigenständig und bringe eine hohe Lernbereitschaft sowie ein ausgeprägtes Qualitätsbewusstsein mit. Gerne möchte ich mein Wissen aus dem Studium mit praktischer Erfahrung verbinden und aktiv zum Erfolg Ihres Unternehmens beitragen.",
]

def patch_cover_letter_docx(letter_text: str, cl_lang: str = "de") -> bytes:
    """Replace first 4 body paragraphs with Gemini content; clear the 5th to keep single-page.
    Translate sidebar labels to German when cl_lang == "de"."""
    paras = [p.strip() for p in letter_text.split("\n\n") if p.strip()]
    # Drop greeting / sign-off lines if Gemini included them anyway
    paras = [p for p in paras if not p.lower().startswith(
        ("sehr geehrt", "dear ", "mit freundlich", "kind regards", "vishal mahesh", "sincerely", "best regards")
    )]

    # Pad to exactly 5 slots — last slot will be cleared to prevent overflow
    while len(paras) < 4:
        paras.append("")
    paras = paras[:4] + [""]  # 5th slot intentionally empty

    with zipfile.ZipFile(io.BytesIO(CL_DOCX_PATH.read_bytes()), "r") as zin:
        names    = zin.namelist()
        file_map = {n: zin.read(n) for n in names}

    xml = file_map["word/document.xml"].decode("utf-8")
    for i, new_para in enumerate(paras):
        if i < len(CL_ORIG_PARAS):
            # For the 5th (emptied) slot, replace with a single space so LibreOffice doesn't break
            replacement = xml_enc(new_para) if new_para else ""
            xml = xml.replace(CL_ORIG_PARAS[i], replacement)

    # Translate sidebar labels for German cover letter
    if cl_lang == "de":
        for en_text, de_text in CL_SIDEBAR_DE:
            xml = xml_replace(xml, en_text, de_text)

    file_map["word/document.xml"] = xml.encode("utf-8")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, file_map[n])
    return out.getvalue()


def add_clickable_links(pdf_bytes: bytes, link_map: dict = None) -> bytes:
    """
    Post-process a PDF to inject clickable /Link annotations on text matches.
    Necessary because some LibreOffice builds (incl. Railway's) don't export
    hyperlinks as clickable annotations even with FilterData JSON.
    Idempotent — strips existing /Link annotations first.
    """
    if link_map is None:
        link_map = PDF_LINK_MAP
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter(clone_from=reader)

        for page in writer.pages:
            # Strip existing /Link annotations to avoid duplicates
            if "/Annots" in page:
                kept = ArrayObject()
                for ref in page["/Annots"]:
                    try:
                        obj = ref.get_object() if hasattr(ref, "get_object") else ref
                        if str(obj.get("/Subtype")) != "/Link":
                            kept.append(ref)
                    except Exception:
                        kept.append(ref)
                page[NameObject("/Annots")] = kept

            # Inject fresh /Link annotations for each text→URL pair
            for text, url in link_map.items():
                matches = []
                def visitor(t, cm, tm, fontDict, fontSize, _text=text):
                    if _text and _text in t:
                        x, y = tm[4], tm[5]
                        w = len(_text) * fontSize * 0.55
                        h = fontSize * 1.1
                        matches.append((x, y - 2, x + w, y + h))
                page.extract_text(visitor_text=visitor)

                for (x1, y1, x2, y2) in matches:
                    annot = DictionaryObject({
                        NameObject("/Type"):    NameObject("/Annot"),
                        NameObject("/Subtype"): NameObject("/Link"),
                        NameObject("/Rect"): ArrayObject([
                            FloatObject(x1), FloatObject(y1),
                            FloatObject(x2), FloatObject(y2),
                        ]),
                        NameObject("/Border"): ArrayObject([NumberObject(0)] * 3),
                        NameObject("/A"): DictionaryObject({
                            NameObject("/Type"): NameObject("/Action"),
                            NameObject("/S"):    NameObject("/URI"),
                            NameObject("/URI"):  TextStringObject(url),
                        }),
                    })
                    if "/Annots" in page:
                        page["/Annots"].append(annot)
                    else:
                        page[NameObject("/Annots")] = ArrayObject([annot])

        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()
    except Exception as e:
        # If anything goes wrong, return original PDF (don't break the response)
        print(f"[add_clickable_links] error: {e}")
        return pdf_bytes


def docx_to_pdf(docx_bytes: bytes, link_map: dict = None) -> bytes:
    """Convert DOCX to PDF and inject clickable links (resume by default, or custom map for CL)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = Path(tmpdir) / "resume.docx"
        docx_path.write_bytes(docx_bytes)

        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            raise HTTPException(500, "LibreOffice not installed.")

        # Best-effort: reap any soffice.bin left behind by a prior request that timed out or
        # crashed. Without this, orphaned processes pile up across requests, and LibreOffice
        # (which shares the single /root/.config profile by default) eventually fails to spawn
        # threads for new conversions ("osl::Thread::create failed") once the container's
        # process/thread budget is exhausted — even though the binary is still present and
        # /health still reports it as installed. Fine for this single-user backend's low
        # concurrency; a busier deployment would want a proper process pool instead.
        subprocess.run(["pkill", "-9", "-f", "soffice.bin"], capture_output=True)

        # Explicit FilterData ensures hyperlinks are exported as clickable Annotations
        # in the PDF (not all LibreOffice builds default this to true)
        pdf_filter = (
            'pdf:writer_pdf_Export:'
            '{"ExportLinks":{"type":"boolean","value":"true"},'
            '"ExportBookmarks":{"type":"boolean","value":"true"},'
            '"ExportNotes":{"type":"boolean","value":"false"},'
            '"UseTaggedPDF":{"type":"boolean","value":"true"},'
            '"SelectPdfVersion":{"type":"long","value":"15"}}'
        )
        # Isolated, throwaway profile per conversion (deleted along with tmpdir) instead of the
        # shared /root/.config default — avoids profile-lock contention with any other soffice
        # instance still shutting down, which is what causes the stalls/orphans above.
        profile_dir = Path(tmpdir) / "loprofile"
        cmd = [
            soffice, "--headless", "--norestore",
            f"-env:UserInstallation=file://{profile_dir}",
            "--convert-to", pdf_filter, "--outdir", tmpdir, str(docx_path),
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        try:
            stdout, stderr = proc.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            # Kill the whole process group, not just the direct child — soffice forks soffice.bin,
            # and killing only the wrapper is exactly how orphans accumulate in the first place.
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait()
            raise HTTPException(500, "LibreOffice timed out during PDF conversion.")

        if proc.returncode != 0:
            raise HTTPException(500, f"LibreOffice failed: {stderr.decode(errors='replace')}")

        pdf_path = Path(tmpdir) / "resume.pdf"
        if not pdf_path.exists():
            raise HTTPException(500, "PDF not created.")
        # Post-process to inject clickable link annotations
        return add_clickable_links(pdf_path.read_bytes(), link_map=link_map)


# ═══════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════
@app.get("/health")
def health():
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    return {
        "status":       "ok",
        "libreoffice":  bool(soffice),
        "gemini_key":   bool(GEMINI_KEY),
        "resume_templates": {
            track: {lang: bool(slot and slot["path"].exists()) for lang, slot in langs.items()}
            for track, langs in TRACK_TEMPLATES.items()
        },
        "cl_template":  CL_DOCX_PATH.exists(),
        "version":      "v7-per-track-summary-only",
    }


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """Stage 1: Analyze JD — returns track suggestion, fit score, ATS keywords, project picks"""
    result = await call_gemini(build_analyze_prompt(req.jd, req.company), temp=0.2, max_tokens=1500)
    return JSONResponse(content=result)


@app.post("/autofill")
async def autofill(req: AutofillRequest):
    """Map application form fields to values from AUTOFILL_PROFILE. Returns a JSON array of
    {index, value} — the API key never ships to any client; this is the only place it's used."""
    if not req.fields:
        raise HTTPException(400, "No fields provided.")
    result = await call_gemini(
        build_autofill_prompt(req.fields, req.page_context), temp=0.3, max_tokens=8192
    )
    if not isinstance(result, list):
        raise HTTPException(502, "Unexpected response shape from Gemini (expected a JSON array).")
    return JSONResponse(content=result)


@app.post("/tailor")
async def tailor(req: TailorRequest):
    """Stage 2: Generate tailored PDF + optional cover letter"""
    if not GEMINI_KEY:
        raise HTTPException(500, "GEMINI_KEY not set.")

    # Strip placeholder values silently
    req.company      = clean_placeholder(req.company)
    req.custom_title = clean_placeholder(req.custom_title)
    template = TRACK_TEMPLATES.get(req.track, {}).get(req.resume_lang)
    if not template:
        raise HTTPException(
            400, f"No '{req.resume_lang}' resume template available yet for track '{req.track}'."
        )
    if not template["path"].exists():
        raise HTTPException(500, f"Template missing: {template['path'].name}")

    ai = await call_gemini(build_tailor_prompt(req), temp=0.15)

    cover_letter_pdf_b64 = ""
    if req.cover_letter:
        cl_result = await call_gemini(build_cl_prompt(req), temp=0.25)
        letter_text = cl_result.get("letter", "")
        if letter_text:
            # Patch the cover letter DOCX template and convert to PDF
            cl_docx = patch_cover_letter_docx(letter_text, cl_lang=req.cl_lang)
            cl_pdf  = docx_to_pdf(cl_docx, link_map=CL_PDF_LINK_MAP)
            cover_letter_pdf_b64 = base64.b64encode(cl_pdf).decode()

    docx_bytes = patch_docx(req.track, req.resume_lang, ai)
    pdf_bytes  = docx_to_pdf(docx_bytes)

    company_slug = re.sub(r"[^a-zA-Z0-9]", "_", req.company)[:30] if req.company else ""
    role_slug    = {
        "fulltime_dev": "FT_Dev",
        "werk_dev":     "Werk_Dev",
        "werk_pm":      "Werk_PM",
        "fulltime_pm":  "FT_PM",
    }.get(req.track, "Resume")

    filename = (
        f"Vishal_{company_slug}_{role_slug}.pdf"
        if company_slug else
        f"Vishal_Resume_{role_slug}.pdf"
    )

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if cover_letter_pdf_b64:
        headers["X-Cover-Letter-Pdf"] = cover_letter_pdf_b64

    return Response(content=pdf_bytes, media_type="application/pdf", headers=headers)


# ═══════════════════════════════════════════════════════════════════
# ONLINE RESUME EDITOR — download the actual .docx, edit it in Word / Google Docs / Pages (full
# formatting freedom, not constrained to any parsed representation), upload it back. The upload
# becomes the new baseline template for that track+language — used by this endpoint's own PDF
# conversion immediately, and by every future /tailor call for that track+language too.
#
# NOTE ON PERSISTENCE: this overwrites the template file on the running container's disk. On
# Railway (see Dockerfile — templates are COPY'd into the image at build time) that survives
# restarts but NOT a redeploy, since a redeploy rebuilds the container from the image and the
# edit is gone unless a persistent volume is mounted. Fine for "no need to relaunch the app while
# I'm working," not a durable long-term store.
# ═══════════════════════════════════════════════════════════════════
@app.get("/resume-docx")
def resume_docx(track: str, resume_lang: str = "en"):
    """Download the raw .docx template for a track+language, for editing in a real word processor."""
    template = TRACK_TEMPLATES.get(track, {}).get(resume_lang)
    if not template:
        raise HTTPException(400, f"No '{resume_lang}' resume template available yet for track '{track}'.")
    if not template["path"].exists():
        raise HTTPException(500, f"Template missing: {template['path'].name}")

    filename = f"Vishal_Resume_{track}_{resume_lang}.docx"
    return Response(
        content=template["path"].read_bytes(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/resume-docx")
async def resume_docx_save(
    track:       str = Form(...),
    resume_lang: str = Form("en"),
    file:        UploadFile = File(...),
):
    """Upload an edited .docx: persist it as the new template for this track+language, and
    return it converted to PDF."""
    template = TRACK_TEMPLATES.get(track, {}).get(resume_lang)
    if not template:
        raise HTTPException(400, f"No '{resume_lang}' resume template available yet for track '{track}'.")

    docx_bytes = await file.read()
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
            if "word/document.xml" not in zf.namelist():
                raise HTTPException(400, "That file doesn't look like a Word .docx (no word/document.xml).")
    except zipfile.BadZipFile:
        raise HTTPException(400, "That file isn't a valid .docx.")

    template["path"].write_bytes(docx_bytes)

    pdf_bytes = docx_to_pdf(docx_bytes)
    filename  = f"Vishal_Resume_{track}_{resume_lang}.pdf"
    headers   = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=pdf_bytes, media_type="application/pdf", headers=headers)
