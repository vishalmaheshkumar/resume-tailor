import os
import re
import json
import base64
import tempfile
import subprocess
import shutil
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI(title="Resume Tailor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Config ──────────────────────────────────────────────────────
GEMINI_KEY   = os.environ.get("GEMINI_KEY", "")
GEMINI_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
GEMINI_URL_FB= f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_KEY}"

# DOCX template — embedded as base64 in env var OR loaded from file
DOCX_PATH    = Path(__file__).parent / "template.docx"

# ── Request model ────────────────────────────────────────────────
class TailorRequest(BaseModel):
    jd:           str
    job_type:     str   # fulltime_pm | fulltime_dev | werkstudent_pm | werkstudent_dev
    custom_title: str = ""
    cover_letter: bool = False
    cl_lang:      str = "en"

# ── Original text anchors ────────────────────────────────────────
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

# ── XML helpers ──────────────────────────────────────────────────
def xml_enc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def xml_replace(xml: str, old_plain: str, new_plain: str) -> str:
    return xml.replace(xml_enc(old_plain), xml_enc(new_plain))

def replace_summary(xml: str, new_text: str) -> str:
    anchor    = ORIG["SUMMARY_PARA_ID"]
    idx       = xml.find(anchor)
    if idx == -1:
        return xml
    p_start   = xml.rfind("<w:p ", 0, idx)
    p_end     = xml.find("</w:p>", idx) + 6
    new_para  = (
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

# ── Gemini call with fallback ────────────────────────────────────
async def call_gemini(prompt: str) -> dict:
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.35, "maxOutputTokens": 8192},
    }
    async with httpx.AsyncClient(timeout=90) as client:
        for url in [GEMINI_URL, GEMINI_URL_FB]:
            try:
                r = await client.post(url, json=payload)
                data = r.json()
                if r.status_code != 200:
                    msg = data.get("error", {}).get("message", "")
                    if any(x in msg.lower() for x in ["high demand", "overload", "resource_exhausted"]):
                        continue
                    raise HTTPException(status_code=502, detail=msg)
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                text = re.sub(r"^```(?:json)?\s*", "", text).rstrip("` \n")
                s, e = text.find("{"), text.rfind("}")
                if s >= 0 and e > s:
                    text = text[s:e+1]
                return json.loads(text)
            except (httpx.TimeoutException, httpx.NetworkError):
                continue
    raise HTTPException(status_code=503, detail="Gemini is overloaded. Try again in a moment.")

# ── Build prompt ─────────────────────────────────────────────────
def build_prompt(req: TailorRequest) -> str:
    is_werk = req.job_type.startswith("werkstudent")
    is_pm   = req.job_type.endswith("_pm")
    role    = req.custom_title or ("Product Manager" if is_pm else "Software Developer")
    avail   = (
        "Currently pursuing M.Sc. MME-TIME at RWTH Aachen (Oct 2025–Mar 2027); available 20h/week during semester, full-time during breaks."
        if is_werk else
        "Currently pursuing M.Sc. MME-TIME at RWTH Aachen; eligible to transition to part-time studies upon full-time employment."
    )
    skill_inst = (
        'SKILLS — PM focus. Change ALL 6 category labels to PM-relevant ones AND provide matching values.'
        if is_pm else
        'SKILLS — Dev focus. Keep original 6 category labels unchanged. Only reorder/adjust values. Return skill_labels as null.'
    )
    focus = (
        "Product thinking, stakeholder alignment, customer empathy, roadmap ownership, bridging tech and business."
        if is_pm else
        "Technical depth, engineering quality, system architecture, APIs, enterprise SaaS development."
    )
    return f"""You are an expert resume writer tailoring a resume for a specific job application.

=== ROLE & CONTEXT ===
Job Title: {role}
Application type: {"Werkstudent / Internship" if is_werk else "Full-Time"}
FOCUS: {focus}

=== CANDIDATE FACTS (never invent) ===
- 3+ years at Flexera Software (US enterprise SaaS) as Software Development Engineer → promoted
- ServiceNow CSA + CAD certified. Expertise: CMDB, ITAM, RTE, Transform Maps, Business Rules, Script Includes
- Built GraphQL APIs, OpenAI MCP prototype, SMART REST APIs, migrated ETL to AWS (60% perf improvement)
- Trained support team, managed customers/vendors, coordinated US/EU/AU cross-functional teams
- 70% product architecture redesign at Flexera
- M.Sc. MME-TIME at RWTH Aachen (Oct 2025–Mar 2027): Data Analysis, Strategic Mgmt, Marketing, Innovation, Leadership
- {avail}

=== JOB DESCRIPTION ===
{req.jd[:4000]}

=== {skill_inst} ===

=== RULES ===
- NEVER invent facts. Rephrase and reorder only.
- Summary: 4-5 sentences. End with availability. No generic filler.
- Bullets: most JD-relevant first. {"Frame in product/business impact terms." if is_pm else "Keep technical specificity."}
- Return exactly 8 SDE bullets and 7 ASE bullets.
- Return exactly 6 skill_values.
- {"Return 6 skill_labels (new PM-focused names with trailing colon+space)" if is_pm else "Return null for skill_labels"}

=== OUTPUT — valid JSON only, no markdown ===
{{
  "summary": "...",
  "skill_labels": {"null" if not is_pm else '["Label1: ", "Label2: ", "Label3: ", "Label4: ", "Label5: ", "Label6: "]'},
  "skill_values": ["val1","val2","val3","val4","val5","val6"],
  "sde_bullets": ["b1","b2","b3","b4","b5","b6","b7","b8"],
  "ase_bullets": ["b1","b2","b3","b4","b5","b6","b7"]
}}"""

def build_cl_prompt(req: TailorRequest) -> str:
    is_pm   = req.job_type.endswith("_pm")
    is_werk = req.job_type.startswith("werkstudent")
    role    = req.custom_title or ("Product Manager" if is_pm else "Software Developer")
    lang_inst = "in GERMAN (formal Sie form)" if req.cl_lang == "de" else "in ENGLISH"
    return f"""Write a professional cover letter {lang_inst} for Vishal Mahesh Kumar applying for: {role}.

CANDIDATE:
- 3+ years SDE at Flexera Software (US SaaS), ServiceNow CSA+CAD certified
- M.Sc. MME-TIME at RWTH Aachen (Oct 2025–Mar 2027)
- {"Available 20h/week during semester, full-time during breaks" if is_werk else "Can switch studies to part-time for full-time role"}
- 70% architecture redesign, 60% performance improvement at Flexera
- 1st place Formula Hybrid 2021 USA

JOB DESCRIPTION:
{req.jd[:2500]}

REQUIREMENTS:
- 4-5 paragraphs. Strong opening referencing company/role.
- Connect Vishal's experience to JD requirements.
- Mention RWTH master's degree.
- Close with availability and enthusiasm.
- Sign off: Vishal Mahesh Kumar
- {"Use Sehr geehrte/r... and Mit freundlichen Grüßen" if req.cl_lang == "de" else "Use Dear Hiring Team / Kind regards"}
- No address block or date.

Return JSON only: {{"letter": "full letter text with \\n for paragraph breaks"}}"""

# ── DOCX patching ────────────────────────────────────────────────
def patch_docx(ai: dict) -> bytes:
    import zipfile, io

    template_bytes = DOCX_PATH.read_bytes()

    with zipfile.ZipFile(io.BytesIO(template_bytes), "r") as zin:
        names    = zin.namelist()
        file_map = {name: zin.read(name) for name in names}

    xml = file_map["word/document.xml"].decode("utf-8")

    # 1. Summary
    if ai.get("summary"):
        xml = replace_summary(xml, ai["summary"])

    # 2. Skill labels (PM only)
    if ai.get("skill_labels"):
        for i, new_label in enumerate(ai["skill_labels"]):
            if new_label and i < len(ORIG["SK_LABELS"]):
                xml = xml.replace(xml_enc(ORIG["SK_LABELS"][i]), xml_enc(new_label))

    # 3. Skill values
    if ai.get("skill_values"):
        for i, new_val in enumerate(ai["skill_values"]):
            if new_val and i < len(ORIG["SK_VALUES"]):
                xml = xml_replace(xml, ORIG["SK_VALUES"][i], new_val)

    # 4. SDE bullets
    if ai.get("sde_bullets"):
        for i, bullet in enumerate(ai["sde_bullets"]):
            if bullet and i < len(ORIG["SDE"]):
                xml = xml_replace(xml, ORIG["SDE"][i], bullet)

    # 5. ASE bullets
    if ai.get("ase_bullets"):
        for i, bullet in enumerate(ai["ase_bullets"]):
            if bullet and i < len(ORIG["ASE"]):
                xml = xml_replace(xml, ORIG["ASE"][i], bullet)

    file_map["word/document.xml"] = xml.encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for name in names:
            zout.writestr(name, file_map[name])

    return out.getvalue()

# ── LibreOffice conversion ───────────────────────────────────────
def docx_to_pdf(docx_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = Path(tmpdir) / "resume.docx"
        pdf_path  = Path(tmpdir) / "resume.pdf"
        docx_path.write_bytes(docx_bytes)

        # Try soffice (LibreOffice)
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            raise HTTPException(status_code=500, detail="LibreOffice not found on server.")

        result = subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", tmpdir, str(docx_path)],
            capture_output=True, timeout=60
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"LibreOffice error: {result.stderr.decode()}")

        # LibreOffice names it resume.pdf in the outdir
        generated = Path(tmpdir) / "resume.pdf"
        if not generated.exists():
            raise HTTPException(status_code=500, detail="PDF not generated.")

        return generated.read_bytes()

# ── Routes ───────────────────────────────────────────────────────
@app.get("/health")
def health():
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    return {"status": "ok", "libreoffice": bool(soffice), "gemini_key": bool(GEMINI_KEY)}

@app.post("/tailor")
async def tailor(req: TailorRequest):
    if not GEMINI_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_KEY env var not set.")
    if not DOCX_PATH.exists():
        raise HTTPException(status_code=500, detail="template.docx not found.")

    # 1. Tailor content via Gemini
    prompt = build_prompt(req)
    ai     = await call_gemini(prompt)

    # 2. Cover letter (optional)
    cover_letter = ""
    if req.cover_letter:
        cl_prompt    = build_cl_prompt(req)
        cl_result    = await call_gemini(cl_prompt)
        cover_letter = cl_result.get("letter", "")

    # 3. Patch DOCX
    docx_bytes = patch_docx(ai)

    # 4. Convert to PDF
    pdf_bytes = docx_to_pdf(docx_bytes)

    # 5. Return PDF + cover letter text in header
    role     = req.custom_title or ("PM" if req.job_type.endswith("_pm") else "Dev")
    filename = f"Vishal_Resume_{role.replace(' ','_')}.pdf"

    headers = {"X-Cover-Letter": base64.b64encode(cover_letter.encode()).decode() if cover_letter else ""}
    return Response(
        content     = pdf_bytes,
        media_type  = "application/pdf",
        headers     = {**headers, "Content-Disposition": f'attachment; filename="{filename}"'}
    )
