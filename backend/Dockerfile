FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY psyholuh ./psyholuh
CMD ["uvicorn", "psyholuh.app:app", "--host", "0.0.0.0", "--port", "8000"]

FROM base AS audio
COPY requirements-audio.txt .
RUN pip install --no-cache-dir -r requirements-audio.txt

FROM base AS api
