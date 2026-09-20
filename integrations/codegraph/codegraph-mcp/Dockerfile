FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py fetch_api_key.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Non-root (CIS Docker Benchmark / least-privilege) — matches xcoder's own Dockerfile and
# codegraph-api's, rather than this image's default root user.
RUN useradd --create-home --shell /bin/bash mcp && chown -R mcp:mcp /app
USER mcp

ENV CODEGRAPH_API_URL=http://localhost:8000
# CODEGRAPH_API_KEY must be supplied at `docker run` time for standalone use (see README's
# "Option A: Docker"). In docker-compose, leave it unset and set ADMIN_PASSWORD instead —
# entrypoint.sh fetches a real key by logging in, since codegraph-api generates it at boot.

# Only used when MCP_TRANSPORT=streamable-http (docker-compose's `codegraph-mcp` service).
# Ignored for the default stdio transport used by Claude Desktop/Code and xcoder's local mode.
EXPOSE 8900

ENTRYPOINT ["./entrypoint.sh"]
