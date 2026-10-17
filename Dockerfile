FROM python:3.13-slim

WORKDIR /app
COPY server.py ./server.py
COPY runtime.py ./runtime.py
COPY schema.sql ./schema.sql
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY web ./web
RUN useradd --create-home discuss && mkdir /data && chown discuss:discuss /data
USER discuss
ENV HOST=0.0.0.0 PORT=8765 DATABASE_PATH=/data/discuss.sqlite3 PYTHONUNBUFFERED=1
EXPOSE 8765
VOLUME ["/data"]
CMD ["python", "server.py", "--no-demo"]
