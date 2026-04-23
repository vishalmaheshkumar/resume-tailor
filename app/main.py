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
import zipfile
from pathlib import Path
from typing import Optional, List

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Resume Tailor API v5")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_KEY = os.environ.get("GEMINI_KEY", "")
DOCX_PATH  = Path(__file__).parent / "template.docx"

GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite-preview",
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

P4. AI Resume Tailoring Tool (PERSONAL, recent)
    - React app using LLM APIs (Anthropic/Gemini)
    - Word-level diff, JD-driven tailoring
    TAGS: AI, LLM integration, React, product-building, problem solving

P5. Job Scanner Application (PERSONAL, recent)
    - React app with live search across LinkedIn, Indeed, StepStone
    TAGS: React, API integration, automation, web scraping, job market

P6. BlastMap AI (CONCEPT based on CMDB work)
    - CMDB blast radius analyzer — downstream impact of CI changes
    TAGS: CMDB, enterprise IT, impact analysis, AI, visualization

P7. MCP Prototype (during Flexera)
    - Natural-language ServiceNow ops via OpenAI Model Context Protocol
    TAGS: AI, MCP, emerging tech, enterprise AI, ServiceNow

===== EXTRACURRICULAR =====
- Innovation Team Member, Enactus Aachen e.V. (current)
- 400+ hours community service supporting education in remote regions

===== KEY ACHIEVEMENTS =====
- Formula Hybrid 2021 USA: 1st Place, Hybrid Category
- Promoted at Flexera (Associate → SDE) after 7 months
- Flexera Professionalism Badge
"""


# ═══════════════════════════════════════════════════════════════════
# DOCX ANCHORS (text-level replacement targets)
# ═══════════════════════════════════════════════════════════════════
ORIG = {
    "SUMMARY_PARA_ID": 'w14:paraId="00000004"',
    "SK_LABELS": [
        "ServiceNow: ",
        "ITAM / Enterprise Platforms: ",
        "Backend &amp; Integration: ",
        "AI &amp; Protocols: ",
        "Cloud &amp; Databases: ",
        "Tools: ",
    ],
    "SK_VALUES": [
        "Scoped Applications, CMDB, Robust Transform Engine (RTE), Transform Maps, Business Rules (Sync/Async), Script Includes, Data Normalization",
        "HAM, SAM, SaaS Manager, FlexeraOne, FNMS, IT Visibility",
        "REST API Design, GraphQL, ServiceNow Server-Side JavaScript, Golang",
        "OpenAI MCP (Model Context Protocol) Integration",
        "AWS, MongoDB, PostgreSQL, S3, CloudWatch",
        "JIRA, Confluence, Git, Agile Scrum",
    ],
    "SDE": [
        "Migrated ETL functionalities from ServiceNow to AWS, redesigning platform architecture and improving customer-end performance by ~60%.",
        "Designed and enhanced Robust Transform Engine (RTE) pipelines for enterprise hardware and software inventory ingestion.",
        "Implemented mandatory field and lifecycle date-pair validation logic within RTE to filter invalid records prior to CMDB insertion.",
        "Developed rule-based classification logic for Hardware Category, OS Category, and Subcategories for structured CMDB mapping.",
        "Designed and implemented SMART REST APIs with pagination and structured response headers for large enterprise datasets.",
        "Processed real-time network adapter events and mapped network interface data into CMDB.",
        "Worked with GraphQL APIs for optimized data querying and reduced over-fetching compared to REST endpoints.",
        "Built MCP-compatible backend services using OpenAI Model Context Protocol for AI-assisted enterprise workflows.",
    ],
    "ASE": [
        "Worked on Flexera SaaS Manager platform for API integration and enterprise software inventory ingestion.",
        "Assisted in development and maintenance of SaaS applications using MongoDB, PostgreSQL, and AWS.",
        "Implemented dynamic mapping of devices into Computer and Network Gear tables using transformer logic.",
        "Designed reusable Script Includes for validation, CMDB mapping, and API response formatting.",
        "Created synchronous and asynchronous Business Rules to enforce data consistency during record insert/update.",
        "Supported cross-functional teams in debugging critical production issues.",
        "Received Professionalism Badge for collaboration and technical research contributions.",
    ],
}


# ═══════════════════════════════════════════════════════════════════
# REQUEST SCHEMAS
# ═══════════════════════════════════════════════════════════════════
class AnalyzeRequest(BaseModel):
    jd:      str
    company: str = ""


class TailorRequest(BaseModel):
    jd:            str
    track:         str   # fulltime_dev | werk_dev | werk_pm | fulltime_pm
    custom_title:  str = ""
    company:       str = ""
    cover_letter:  bool = False
    cl_lang:       str = "en"
    fit_score:     int = 7
    ats_keywords:  List[str] = []
    projects:      List[str] = []


# ═══════════════════════════════════════════════════════════════════
# XML HELPERS
# ═══════════════════════════════════════════════════════════════════
def xml_enc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def xml_replace(xml: str, old_plain: str, new_plain: str) -> str:
    return xml.replace(xml_enc(old_plain), xml_enc(new_plain))


def replace_summary(xml: str, new_text: str) -> str:
    anchor = ORIG["SUMMARY_PARA_ID"]
    idx    = xml.find(anchor)
    if idx == -1:
        return xml
    p_start = xml.rfind("<w:p ", 0, idx)
    p_end   = xml.find("</w:p>", idx) + 6
    new_para = (
        '<w:p w:rsidR="00000000" w:rsidDel="00000000" w:rsidP="00000000" '
        'w:rsidRDefault="00000000" w:rsidRPr="00000000" w14:paraId="00000004">'
        '<w:pPr><w:spacing w:after="80" w:before="80" w:lineRule="auto"/>'
        '<w:jc w:val="both"/><w:rPr/></w:pPr>'
        '<w:r><w:rPr>'
        '<w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>'
        '<w:color w:val="555555"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:rtl w:val="0"/>'
        f'</w:rPr><w:t xml:space="preserve">{xml_enc(new_text)}</w:t></w:r></w:p>'
    )
    return xml[:p_start] + new_para + xml[p_end:]


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
                    if any(s in msg.lower() for s in ["high demand", "overload", "resource_exhausted"]) or r.status_code in (429, 503):
                        continue
                    raise HTTPException(502, f"Gemini error: {msg}")

                if "error" in data:
                    last_error = f"{model}: {data['error'].get('message','')}"
                    continue

                text = data["candidates"][0]["content"]["parts"][0]["text"]
                text = re.sub(r"^```(?:json)?\s*", "", text).strip().rstrip("` \n")
                s, e = text.find("{"), text.rfind("}")
                if s >= 0 and e > s:
                    text = text[s:e+1]
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

3. **ats_keywords** (12-15 exact short phrases from JD, max 4 words each):
   - Must appear VERBATIM in the JD
   - Only include keywords Vishal TRUTHFULLY has (skip things like Kubernetes if he hasn't used them)
   - Include: job title, tools, methodologies, domain terms
   - Prefer specific over generic (e.g. "ServiceNow CMDB" over "software")

4. **projects** (array of 1-2 project IDs to emphasize):
   P1=Formula Student (leadership/automotive/embedded)
   P2=WIRIN IISc (research/ADAS/autonomous)
   P3=IoT (sensors/cloud/embedded)
   P4=AI Resume Tool (AI/LLM/React)
   P5=Job Scanner (React/automation)
   P6=BlastMap AI (CMDB/AI/impact analysis)
   P7=MCP Prototype (AI/emerging tech/ServiceNow AI)

5. **fit_rationale** (1-2 sentences, honest).

OUTPUT VALID JSON ONLY, NO MARKDOWN:
{{
  "track_suggestion": "werk_pm",
  "fit_score": 8,
  "ats_keywords": ["keyword1", "keyword2", "..."],
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
            "skill_labels": [
                "ServiceNow: ",
                "ITAM / Enterprise Platforms: ",
                "Backend & Integration: ",
                "AI & Protocols: ",
                "Cloud & Databases: ",
                "Tools & Certifications: ",
            ],
            "availability": "Eligible to transition M.Sc. studies to part-time upon full-time hire.",
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
                "Do NOT mention: GraphQL, Golang, FlexeraOne/FNMS product names, "
                "MCP/OpenAI Protocol, deep AWS internals, '70% architecture redesign' "
                "(too senior-sounding for Werkstudent)."
            ),
            "skill_labels": [
                "ServiceNow & CMDB: ",
                "APIs & Development: ",
                "Cloud & Databases: ",
                "Tools & Collaboration: ",
                "Academic Focus: ",
                "Certifications: ",
            ],
            "availability": "Available 20h/week during semester, full-time during semester breaks.",
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
                "Do NOT mention: Robust Transform Engine/RTE, Transform Maps, Script Includes "
                "(too technical), Golang, GraphQL, AWS internals. "
                "FlexeraOne/FNMS — mention sparingly as product context only."
            ),
            "skill_labels": [
                "Product & Strategy: ",
                "Stakeholder & Delivery: ",
                "Enterprise IT Platforms: ",
                "Data & Analysis: ",
                "Tools: ",
                "Certifications: ",
            ],
            "availability": "Available 20h/week during semester, full-time during semester breaks.",
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
            "skill_labels": [
                "Product Management: ",
                "Stakeholder & Customer: ",
                "Technical Foundation: ",
                "Platforms & Tools: ",
                "Certifications: ",
                "Domain Expertise: ",
            ],
            "availability": "Eligible to transition M.Sc. studies to part-time upon full-time hire.",
        },
    }
    return configs.get(track, configs["fulltime_dev"])


# ═══════════════════════════════════════════════════════════════════
# STAGE 2 — TAILOR prompt
# ═══════════════════════════════════════════════════════════════════
def build_tailor_prompt(req: TailorRequest) -> str:
    cfg  = track_config(req.track)
    role = req.custom_title or ({
        "fulltime_dev": "ServiceNow Developer",
        "werk_dev":     "Working Student — IT / Software",
        "werk_pm":      "Working Student — Product / Strategy",
        "fulltime_pm":  "Technical Product Manager",
    }.get(req.track, "Software Engineer"))

    kw_section = ""
    if req.ats_keywords:
        kw_section = (
            "\n===== ATS KEYWORDS (weave in where TRUTHFUL) =====\n"
            "Integrate these exact phrases naturally where Vishal GENUINELY has the experience.\n"
            "Do NOT stuff. Do NOT add keywords Vishal doesn't have.\n"
            f"Keywords: {', '.join(req.ats_keywords)}\n"
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
        }
        proj_section = (
            "\n===== PROJECTS TO EMPHASIZE =====\n"
            + "\n".join(f"  {p}: {proj_map.get(p,'')}" for p in req.projects) + "\n"
        )

    company_line = f"Company: {req.company}\n" if req.company else ""

    return f"""You are an expert resume writer tailoring Vishal's resume.

{TRUTH_ANCHOR}

===== TARGET =====
Track: {req.track}
Role Title: {role}
{company_line}Persona: {cfg['persona']}
Voice: {cfg['tone']}

===== JOB DESCRIPTION =====
{req.jd[:3500]}

===== STRATEGY =====
EMPHASIS: {cfg['emphasis']}

KILL LIST: {cfg['kill_list']}

AVAILABILITY: {cfg['availability']}
{kw_section}{proj_section}
===== ABSOLUTE RULES =====
1. NEVER invent facts, tools, or achievements not in TRUTH ANCHOR above.
   If in doubt, omit. Fabrication destroys Vishal's interviews.
2. Rephrase and reorder ONLY — do not add technologies Vishal hasn't used.
3. Summary: 4-5 sentences. Specific, not generic. End with availability statement.
4. Skill categories: use EXACTLY the 6 labels in skill_labels below.
   Fill with tools/skills from TRUTH ANCHOR only.
5. Return EXACTLY 6 skill_values, 8 sde_bullets, 7 ase_bullets.
6. Bullets: most JD-relevant first. Use the voice specified above.
7. Respect the KILL LIST — those terms must not appear.

===== OUTPUT — VALID JSON ONLY, NO MARKDOWN =====
{{
  "summary": "4-5 sentences tailored to this role.",
  "skill_labels": {json.dumps(cfg['skill_labels'])},
  "skill_values": ["v1","v2","v3","v4","v5","v6"],
  "sde_bullets": ["b1","b2","b3","b4","b5","b6","b7","b8"],
  "ase_bullets": ["b1","b2","b3","b4","b5","b6","b7"]
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
        "Write in GERMAN (formal Sie form, no du). Opening: 'Sehr geehrtes Recruiting-Team,'. "
        "Closing: 'Mit freundlichen Grüßen,'."
        if is_de else
        "Write in ENGLISH. Opening: 'Dear Hiring Team,'. Closing: 'Kind regards,'."
    )

    return f"""Write a professional cover letter for Vishal Mahesh Kumar.

{TRUTH_ANCHOR}

===== TARGET =====
Role: {role}
Company: {req.company or "the hiring company"}
Track: {req.track}
Availability: {cfg['availability']}

===== JOB DESCRIPTION =====
{req.jd[:2500]}

===== OPENING HOOK (adapt naturally to the JD specifics) =====
{hook}

===== REQUIREMENTS =====
- {lang_inst}
- Length: {length}
- Structure:
  Para 1: Strong opening, name the company, ONE specific JD detail, why Vishal fits
  Para 2: Connect Vishal's Flexera experience to JD requirements concretely
  Para 3: Mention RWTH MME-TIME with relevant modules
  Para 4 (if longer version): Availability + closing interest
- NEVER write:
    * "I am a highly motivated..."
    * "I am writing to apply for..."
    * "Please find my application attached"
    * Generic filler
- Sign off: Vishal Mahesh Kumar
- No address block, no date, no subject line — just letter body
- Use ONLY facts from TRUTH ANCHOR — no invented achievements

===== OUTPUT — VALID JSON ONLY =====
{{"letter": "para1\\n\\npara2\\n\\npara3\\n\\n(optional para4)\\n\\nSign-off line\\nVishal Mahesh Kumar"}}"""


# ═══════════════════════════════════════════════════════════════════
# DOCX PATCHING
# ═══════════════════════════════════════════════════════════════════
def patch_docx(ai: dict) -> bytes:
    with zipfile.ZipFile(io.BytesIO(DOCX_PATH.read_bytes()), "r") as zin:
        names    = zin.namelist()
        file_map = {n: zin.read(n) for n in names}

    xml = file_map["word/document.xml"].decode("utf-8")

    if ai.get("summary"):
        xml = replace_summary(xml, ai["summary"])

    if ai.get("skill_labels"):
        for i, new_label in enumerate(ai["skill_labels"]):
            if new_label and i < len(ORIG["SK_LABELS"]):
                xml = xml.replace(xml_enc(ORIG["SK_LABELS"][i]), xml_enc(new_label))

    if ai.get("skill_values"):
        for i, new_val in enumerate(ai["skill_values"]):
            if new_val and i < len(ORIG["SK_VALUES"]):
                xml = xml_replace(xml, ORIG["SK_VALUES"][i], new_val)

    if ai.get("sde_bullets"):
        for i, bullet in enumerate(ai["sde_bullets"]):
            if bullet and i < len(ORIG["SDE"]):
                xml = xml_replace(xml, ORIG["SDE"][i], bullet)

    if ai.get("ase_bullets"):
        for i, bullet in enumerate(ai["ase_bullets"]):
            if bullet and i < len(ORIG["ASE"]):
                xml = xml_replace(xml, ORIG["ASE"][i], bullet)

    file_map["word/document.xml"] = xml.encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, file_map[n])
    return out.getvalue()


def docx_to_pdf(docx_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = Path(tmpdir) / "resume.docx"
        docx_path.write_bytes(docx_bytes)

        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            raise HTTPException(500, "LibreOffice not installed.")

        result = subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", tmpdir, str(docx_path)],
            capture_output=True, timeout=60
        )
        if result.returncode != 0:
            raise HTTPException(500, f"LibreOffice failed: {result.stderr.decode()}")

        pdf_path = Path(tmpdir) / "resume.pdf"
        if not pdf_path.exists():
            raise HTTPException(500, "PDF not created.")
        return pdf_path.read_bytes()


# ═══════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════
@app.get("/health")
def health():
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    return {
        "status":      "ok",
        "libreoffice": bool(soffice),
        "gemini_key":  bool(GEMINI_KEY),
        "template":    DOCX_PATH.exists(),
        "version":     "v5-strategic",
    }


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """Stage 1: Analyze JD — returns track suggestion, fit score, ATS keywords, project picks"""
    result = await call_gemini(build_analyze_prompt(req.jd, req.company), temp=0.2, max_tokens=1500)
    return JSONResponse(content=result)


@app.post("/tailor")
async def tailor(req: TailorRequest):
    """Stage 2: Generate tailored PDF + optional cover letter"""
    if not GEMINI_KEY:
        raise HTTPException(500, "GEMINI_KEY not set.")
    if not DOCX_PATH.exists():
        raise HTTPException(500, "template.docx missing.")

    ai = await call_gemini(build_tailor_prompt(req), temp=0.35)

    cover_letter = ""
    if req.cover_letter:
        cl_result    = await call_gemini(build_cl_prompt(req), temp=0.4)
        cover_letter = cl_result.get("letter", "")

    docx_bytes = patch_docx(ai)
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
    if cover_letter:
        headers["X-Cover-Letter"] = base64.b64encode(cover_letter.encode()).decode()

    return Response(content=pdf_bytes, media_type="application/pdf", headers=headers)
