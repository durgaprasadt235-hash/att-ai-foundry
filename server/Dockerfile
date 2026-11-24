# FastAPI reference backend — Telecom Project.
# Build: docker build -t att-ai-foundry-api ./server
# Run:   docker run -p 8000:8000 --env-file .env att-ai-foundry-api
# Or one command for the whole stack: docker compose up (see docker-compose.yml).
# No secrets are baked into the image: GROQ_API_KEY / ATT_API_* /
# DATABASE_URL come from the environment at run time (see .env.example).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Startup fails loudly when a REQUIRED var is missing for the selected
# mode (see server/config.py) — a misconfigured container exits instead
# of serving half-configured.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
