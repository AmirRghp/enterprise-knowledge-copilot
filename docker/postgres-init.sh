#!/bin/sh
set -eu
# Reuse the guarded provisioner; the Docker DB is separate from native databases.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v target_db_app=enterprise-pgvector \
  -v target_db_test=enterprise_knowledge_copilot_test \
  -f /opt/provision.sql
