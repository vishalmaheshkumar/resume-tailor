# Use official Python slim — install only what's needed
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root

# Install LibreOffice headless (minimal set) + fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Create a fake home for LibreOffice (needs writable user dir)
RUN mkdir -p /root/.config

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/main.py .
COPY app/start.py .
COPY template.docx .
COPY cover_letter_template.docx .

CMD ["python", "start.py"]
