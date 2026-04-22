FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-common \
    fonts-liberation \
    fonts-dejavu \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/main.py .
COPY app/start.py .
COPY template.docx .

CMD ["python", "start.py"]
