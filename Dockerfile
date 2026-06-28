# Root image for Railway: Node MCP server + Python JobSpy scraper in one container.
# Replaces the old docker-in-docker approach (docker run jobspy ...), which does
# not work on Railway because the runtime has no Docker daemon.
FROM node:20-slim

# System Python + venv tooling for the JobSpy scraper
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Install Python dependencies (python-jobspy) into an isolated venv
COPY jobspy/requirements.txt ./jobspy/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r jobspy/requirements.txt

# Copy the rest of the source
COPY . .

ENV NODE_ENV=production \
    PATH="/opt/venv/bin:$PATH" \
    PYTHON_CMD=/opt/venv/bin/python3 \
    JOBSPY_MAIN=/app/jobspy/main.py \
    ENABLE_SSE=1

# Railway provides $PORT at runtime; index.js reads it.
CMD ["npm", "start"]
