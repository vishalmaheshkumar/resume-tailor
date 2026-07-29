// Clicking the extension's toolbar icon opens the side panel directly — same gesture as
// Claude's browser extension. No injected DOM, no page-CSS interference possible: the panel
// renders in its own browser-chrome surface, entirely outside the webpage's document.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[Resume Tailor] setPanelBehavior failed:', err));

// db.js exports onto `self` (not `window` — service workers have no window), so it loads
// identically here as it does in sidepanel.html/dashboard.html.
importScripts('db.js');

// ─────────────────────────────────────────────────────────────
// AUTOFILL — calls Gemini directly (no backend round-trip), with a model-fallback chain. Runs
// here rather than in content.js because a content script's fetch is still subject to the HOST
// PAGE's Content-Security-Policy — many ATS sites set a connect-src that silently blocks any
// request to a domain not on their own allowlist, which is why this was failing silently before.
// The service worker isn't a document and has no CSP of its own, only this extension's
// host_permissions — so it's the only place this call reliably works on every site.
//
// The key itself lives in chrome.storage.local (set via the Settings card in the side panel),
// not in source — read fresh on every call instead of a hardcoded constant.
// ─────────────────────────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
const geminiUrl = (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

async function getGeminiKey() {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  return (geminiApiKey || '').trim();
}

const MY_PROFILE = `
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
Available from: 01 july 2026 (format as needed: 01/07/2026 or 2026-07-01)
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
AI & Protocols: OpenAI MCP (Model Context Protocol), LangChain, PyTorch Geometric, Neo4j
Cloud & Databases: AWS, MongoDB, PostgreSQL, S3, CloudWatch
Tools: JIRA, Confluence, Git, Agile Scrum, Microsoft Office
Product Management: Stakeholder Coordination, Customer Interactions, Agile Scrum

=== KEY PROJECTS ===
1. AI-Enhanced CMDB (ServiceNow + Graph AI) — Neo4j, PyTorch Geometric, LangChain, FastAPI
2. AI Resume Tailoring Tool — React app using Anthropic API with word-level diffs
3. Job Scanner Application — React with live search across LinkedIn, Indeed, StepStone
4. BlastMap AI — CMDB blast radius analyzer concept
5. MCP Prototype — Natural language ServiceNow operations using OpenAI API

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

=== PASSWORD ===
Password: Vishalm123.,

=== PERSONALITY & WORK STYLE ===
- Collaborative team player with experience in cross-functional global teams
- Strong problem-solver with both technical depth and business understanding
- Proactive communicator who bridges technical and non-technical stakeholders
- Passionate about technology-driven innovation and product thinking
- Quick learner who adapts to new technologies and environments
`;

function buildAutofillPrompt(pageContext, fields) {
  return `You are an expert job application assistant helping Vishal fill out a job application form.

=== APPLICANT'S COMPLETE PROFILE ===
${MY_PROFILE}

=== JOB PAGE CONTEXT ===
${pageContext}

=== FORM FIELDS FOUND ===
${JSON.stringify(fields)}

=== YOUR TASK ===
Fill every field with the best possible value. Follow these rules:

STANDARD FIELDS:
- For SELECT dropdowns: return the EXACT "v" (value attribute) from the options. Match carefully.
- For phone country code: pick GERMANY (+49). Do NOT pick Dominican Republic or any country that just contains "49" in a longer code string. Look for "Germany" in the option text.
- For date type="date": use YYYY-MM-DD format.
- For date with placeholder dd/mm/yyyy: use that format.
- "Former employee" = "No" (Vishal never worked at this company unless it's Flexera).
- "Employee referral" = "No".
- "EU/EEA citizen" = "No" (Indian citizen).
- Disability = "No" or "I do not wish to answer".

OPEN-ENDED / DESCRIPTION FIELDS (textareas, motivation, cover letter, "about you", "why interested"):
- Write compelling, professional, personalized responses.
- Reference the SPECIFIC job title and company from the page context.
- Highlight relevant experience from Vishal's profile that matches the job.
- Keep it concise but impactful — 3-5 sentences for short fields, 1-2 paragraphs for longer ones.
- Write in the SAME LANGUAGE as the form (German form = German answers, English form = English answers).
- For "about yourself" / "profile summary": emphasize the unique combination of 3 years enterprise software experience at a US SaaS company + RWTH management master's.
- For "why this company/role": connect Vishal's experience to what the company does.
- For "strengths" or "what do you bring": highlight technical depth + business understanding + international team experience.
- Do NOT be generic. Be specific about Vishal's actual projects and achievements.

SKIP: file upload fields, fields you truly cannot determine.

RESPOND WITH ONLY A JSON ARRAY. No markdown, no backticks, no explanation.
Format: [{"index":0,"value":"the value to fill"}]
Include every field you can fill.`;
}

async function callGeminiWithFallback(pageContext, fields) {
  const key = await getGeminiKey();
  if (!key) {
    throw new Error('No Gemini API key configured — open the side panel and add one under Settings.');
  }

  const prompt = buildAutofillPrompt(pageContext, fields);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  });

  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(geminiUrl(model, key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.status === 429 || res.status === 503) throw new Error(`${model}: overloaded (${res.status})`);
      if (res.status === 404) throw new Error(`${model}: not available (404)`);
      if (!res.ok) {
        let msg = `${model}: status ${res.status}`;
        try { const e = await res.json(); if (e.error?.message) msg = e.error.message; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response');

      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      cleaned = cleaned.trim();
      const jsonStart = cleaned.indexOf('[');
      const jsonEnd = cleaned.lastIndexOf(']');
      if (jsonStart >= 0 && jsonEnd > jsonStart) cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

      const result = JSON.parse(cleaned);
      if (!Array.isArray(result)) throw new Error('Not an array');
      return { mappings: result, model };
    } catch (err) {
      lastErr = err;
      console.warn('[Resume Tailor] Gemini autofill:', err.message);
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

function handleAutofillBackendCall(msg, sendResponse) {
  callGeminiWithFallback(msg.pageContext, msg.fields)
    .then(({ mappings, model }) => sendResponse({ data: mappings, model }))
    .catch((err) => sendResponse({ error: err.message }));
}

// ─────────────────────────────────────────────────────────────
// Apply-URL resolution — LinkedIn's external "Apply" link goes through LinkedIn's own redirect,
// so the href content.js scrapes is a linkedin.com URL, not the real ATS destination. The only
// reliable fix: content.js actually clicks it, and THIS tracks wherever that click leads —
// either a new tab opening, or the same tab navigating away — until the URL settles outside
// linkedin.com, then writes the real URL back into the job store.
// This only discovers a destination URL. It never interacts with anything on that destination.
// ─────────────────────────────────────────────────────────────

let pendingClick = null; // { jobKey, sourceTabId, sourceUrlAtStart, startedAt, autoClose }
const settling = new Map(); // tabId -> { jobKey, lastUrl, completions, autoClose }

const RESOLVE_TIMEOUT_MS = 15000;
const MAX_REDIRECT_HOPS  = 4;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'RT_AUTOFILL_BACKEND_CALL') {
    handleAutofillBackendCall(msg, sendResponse);
    return true;
  }

  if (msg?.type === 'RT_APPLY_CLICK_STARTING') {
    pendingClick = {
      jobKey: msg.jobKey,
      sourceTabId: sender.tab?.id,
      sourceUrlAtStart: sender.tab?.url,
      startedAt: Date.now(),
      autoClose: !!msg.autoClose,
    };
    setTimeout(() => {
      if (pendingClick?.jobKey === msg.jobKey) pendingClick = null;
    }, RESOLVE_TIMEOUT_MS);
    sendResponse({ ack: true });
    return false;
  }
});

function beginTrackingTab(tabId, jobKey, autoClose) {
  if (settling.has(tabId)) return;
  settling.set(tabId, { jobKey, lastUrl: '', completions: 0, autoClose });
  pendingClick = null;
  setTimeout(() => settling.delete(tabId), RESOLVE_TIMEOUT_MS);
}

// New tab opened (the common case — LinkedIn's "leaving LinkedIn" interstitial / direct new-tab
// external link) while a click-through is pending for it. autoClose only ever applies here —
// never to Case A below, since that's the user's OWN scanning/active tab navigating, and closing
// that would be destructive regardless of what was requested.
chrome.tabs.onCreated.addListener((tab) => {
  if (!pendingClick) return;
  if (Date.now() - pendingClick.startedAt > RESOLVE_TIMEOUT_MS) { pendingClick = null; return; }
  beginTrackingTab(tab.id, pendingClick.jobKey, pendingClick.autoClose);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Case A: the SAME tab navigated away (no new tab opened) while a click-through was pending.
  if (pendingClick && tabId === pendingClick.sourceTabId && changeInfo.url &&
      changeInfo.url !== pendingClick.sourceUrlAtStart && !changeInfo.url.includes('linkedin.com')) {
    beginTrackingTab(tabId, pendingClick.jobKey, false);
  }

  // Case B: we're watching this tab (new or same) for its URL to settle outside linkedin.com.
  if (!settling.has(tabId)) return;
  if (changeInfo.status !== 'complete') return;

  const state = settling.get(tabId);
  state.completions++;
  const sameAsLast = state.lastUrl === tab.url;
  state.lastUrl = tab.url;

  const stillOnLinkedIn = (tab.url || '').includes('linkedin.com');
  const shouldFinalize = (sameAsLast && !stillOnLinkedIn) || state.completions >= MAX_REDIRECT_HOPS;

  if (shouldFinalize) {
    settling.delete(tabId);
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      await self.RTJobStore.setApplyUrl(state.jobKey, tab.url);
      chrome.runtime.sendMessage({
        type: 'RT_APPLY_URL_RESOLVED', jobKey: state.jobKey, url: tab.url, tabId,
      }).catch(() => {});
      if (state.autoClose) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }
});
