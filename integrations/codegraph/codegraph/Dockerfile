FROM python:3.11-slim

WORKDIR /code

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV CODEGRAPH_DB=/data/graph.db
ENV PROJECTS_ROOT=/data/projects
ENV PYTHONPATH=/code

# Run as a non-root user (CIS Docker Benchmark / least-privilege) rather than the image's
# default root — matches xcoder's own Dockerfile, which already does this. /data is created and
# chowned here (not just left to the VOLUME line) so the fresh named volume docker-compose
# mounts on first `up` inherits these permissions instead of root:root, which would otherwise
# leave this non-root user unable to write CODEGRAPH_DB/PROJECTS_ROOT under it.
RUN useradd --create-home --shell /bin/bash codegraph \
  && mkdir -p /data \
  && chown -R codegraph:codegraph /code /data
USER codegraph

VOLUME ["/data"]
EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
