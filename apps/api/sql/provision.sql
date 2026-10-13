-- Provisioning for the isolated Enterprise Knowledge Copilot databases.
--
-- Run once, as the EXISTING rag-postgres superuser. It creates only
-- project-scoped objects: one least-privilege role, the application database,
-- and the isolated test database. It never creates a database container, and it
-- never modifies an existing database that belongs to somebody else.
--
-- Fail-closed behaviour: every ownership and privilege check runs BEFORE any
-- mutation. A name collision, a foreign owner, or an over-privileged role
-- aborts the run with a non-zero exit code and changes nothing.
--
-- Password handling: the password is read from the EKC_DB_PASSWORD environment
-- variable INSIDE the container, never from a psql variable or shell argument,
-- so it never appears in argv, in psql output, or in Git. It travels in a 0600
-- temporary env file removed by the trap below; stdin carries only the SQL.
--
-- From apps/api:
--   umask 077
--   env_file="$(mktemp)"
--   trap 'rm -f "$env_file"' EXIT
--   printf 'EKC_DB_PASSWORD=%s\n' "$DB_PASSWORD" > "$env_file"
--   docker exec -i --env-file "$env_file" rag-postgres \
--     psql -q -U rag -d postgres -v ON_ERROR_STOP=1 -f - < sql/provision.sql
--
-- Do not pass the password on stdin instead: psql would then consume the first
-- line of this file as the password, and with rotate_password=1 that would set
-- the role password to SQL text.
--
-- Re-running is safe. Once the role exists, a default run performs NO mutation:
-- it re-verifies ownership and privileges and leaves the password untouched.
-- Rotating the password is an explicit opt-in via rotate_password=1.
--
-- Optional psql variables:
--   dry_run=1            run every check, perform no mutation
--   rotate_password=1    set the role password again (default: leave unchanged)
--   target_role          override the role name (isolated testing)
--   target_db_app        override the application database name
--   target_db_test       override the test database name
--
-- See DATABASE.md sections 1, 10, and 12.
-- Docker fresh-install bootstrap also uses this file with target_db_app set
-- to enterprise-pgvector, against its new dedicated cluster only.

\set ON_ERROR_STOP on
-- Keep query text (which embeds the password for CREATE/ALTER ROLE) out of output.
\set ECHO none

-- ------------------------------------------------------------------ inputs

\if :{?dry_run}
\else
  \set dry_run 0
\endif
\if :{?rotate_password}
\else
  \set rotate_password 0
\endif
\if :{?target_role}
\else
  \set target_role 'enterprise_knowledge_copilot'
\endif
\if :{?target_db_app}
\else
  \set target_db_app 'enterprise_knowledge_copilot'
\endif
\if :{?target_db_test}
\else
  \set target_db_test 'enterprise_knowledge_copilot_test'
\endif

-- Reject a missing, empty, or whitespace-only password before anything else.
-- \quit would exit 0, so an explicit exception is raised instead: under
-- ON_ERROR_STOP that yields exit code 3 and leaves the server untouched.
\set provision_secret `printf %s "$EKC_DB_PASSWORD"`
SELECT length(btrim(coalesce(:'provision_secret', ''))) = 0 AS secret_missing \gset
\if :secret_missing
  \set abort_reason 'EKC_DB_PASSWORD is missing or empty; export it inside the container as described in the header of this file'
  SELECT format('DO $body$ BEGIN RAISE EXCEPTION %L; END $body$', :'abort_reason') \gexec
\endif

-- ------------------------------------------------------- guards (read-only)
--
-- Every flag below is a boolean EXISTS rather than a count(*). psql's \if only
-- accepts 0 and 1 as booleans and silently takes the FALSE branch for any other
-- integer, so a count of 2 (reachable whenever both targets collide) would
-- bypass a guard that must fire. EXISTS can only ever be t or f.

-- 1. Every target database that already exists must belong to the project role.
SELECT EXISTS (
    SELECT 1 FROM pg_database
     WHERE datname IN (:'target_db_app', :'target_db_test')
       AND pg_get_userbyid(datdba) <> :'target_role'
) AS foreign_owned_db \gset
\if :foreign_owned_db
  \set abort_reason 'a target database already exists and is not owned by the project role; refusing to touch it'
  SELECT format('DO $body$ BEGIN RAISE EXCEPTION %L; END $body$', :'abort_reason') \gexec
\endif

-- 2. An existing role must already be least-privilege.
SELECT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = :'target_role'
       AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
) AS over_privileged_role \gset
\if :over_privileged_role
  \set abort_reason 'the project role already exists with elevated privileges; refusing to continue'
  SELECT format('DO $body$ BEGIN RAISE EXCEPTION %L; END $body$', :'abort_reason') \gexec
\endif

-- 3. The project role must not own any database outside the two targets.
SELECT EXISTS (
    SELECT 1 FROM pg_database
     WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = :'target_role')
       AND datname NOT IN (:'target_db_app', :'target_db_test')
) AS extra_owned_db \gset
\if :extra_owned_db
  \set abort_reason 'the project role owns a database outside the two project targets; refusing to continue'
  SELECT format('DO $body$ BEGIN RAISE EXCEPTION %L; END $body$', :'abort_reason') \gexec
\endif

-- Current existence facts, captured after the guards passed. Also EXISTS so no
-- flag in this file can ever hold a value that \if would misread.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_role') AS role_exists \gset
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db_app') AS app_db_exists \gset
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db_test') AS test_db_exists \gset

-- --------------------------------------------------------------- mutations

\if :dry_run
  \echo 'DRY RUN: checks passed; no change will be made'
\else
  -- Role. Created only when missing; an existing role is never altered unless
  -- password rotation is explicitly requested.
  \if :role_exists
    \if :rotate_password
      SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'target_role', :'provision_secret') \gexec
      \echo 'role password rotated on explicit request'
    \else
      \echo 'role already exists; password left unchanged (use rotate_password=1 to rotate)'
    \endif
  \else
    SELECT format(
      'CREATE ROLE %I LOGIN PASSWORD %L',
      :'target_role',
      :'provision_secret'
    )
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_role') \gexec
    \echo 'role created'
  \endif

  -- CREATE DATABASE cannot run inside a transaction block, so each is issued
  -- separately. Ownership lets the limited role create its own schema objects.
  SELECT format('CREATE DATABASE %I OWNER %I', :'target_db_app', :'target_role')
   WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db_app') \gexec
  SELECT format('CREATE DATABASE %I OWNER %I', :'target_db_test', :'target_role')
   WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db_test') \gexec
  \echo 'target databases ensured'

  -- pgvector is not a trusted extension, so the least-privilege role cannot
  -- create it. That is why extension setup stays in this operator step.
  \connect :target_db_app
  CREATE EXTENSION IF NOT EXISTS vector;
  \connect :target_db_test
  CREATE EXTENSION IF NOT EXISTS vector;
  \echo 'vector extension ensured in both target databases'
\endif

\echo 'provisioning checks complete'
