import os
import sys
import shutil
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    
    # Log startup info
    print(f"[startup] PORT={port}", flush=True)
    print(f"[startup] GEMINI_KEY set: {bool(os.environ.get('GEMINI_KEY'))}", flush=True)
    
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    print(f"[startup] LibreOffice found: {soffice}", flush=True)
    
    from pathlib import Path
    tmpl = Path(__file__).parent / "template.docx"
    print(f"[startup] template.docx exists: {tmpl.exists()}", flush=True)
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        log_level="info"
    )
