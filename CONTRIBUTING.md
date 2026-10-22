# Contributing

Thank you for your interest in contributing to Enterprise Knowledge Copilot.

## Before you start

- Read `README.md` for the product overview and run paths.
- For architecture and security details, see `docs/ARCHITECTURE.md` and
  `docs/SECURITY.md` in the source tree.
- Open an issue (or check existing ones) before starting large changes. Small
  fixes can go straight to a pull request.
- Keep changes focused. Do not mix unrelated refactors with a fix or feature.

## Prerequisites

- Git
- Python 3.12
- Node.js 22 or newer
- `uv` (Python dependency manager)
- PostgreSQL 15+ with `pgvector` for native development, or Docker with Compose v2

## Development setup (native)

```bash
git clone https://github.com/AmirRghp/enterprise-knowledge-copilot.git
cd enterprise-knowledge-copilot
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and DB_PASSWORD (and APP_ENCRYPTION_KEY if needed).
cd apps/api && uv sync --locked && cd ../..
cd apps/web && npm ci && cd ../..
```

Then create and migrate the application database, and run the services:

```bash
cd apps/api
DB_NAME=enterprise_knowledge_copilot uv run --locked alembic upgrade head
cd ../..
./run.sh
```

`run.sh` starts the API, web app, and ingestion worker together. The web app is
available at `http://localhost:3000`.

For Docker-based development, follow the "Production setup" section of
`README.md`.

## Commands that gate changes

Run the commands that match the area you touched. Do not claim a check passed
unless you ran it.

### API (`apps/api`)

```bash
uv run --locked pytest -q
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked mypy app
uv run --locked alembic check
```

### Web (`apps/web`)

```bash
npm run lint
npm run typecheck
npm run format:check
npm run build
npm run test:proxy
```

Run the other `test:*` scripts that cover the area you changed (see
`apps/web/package.json`).

## Domain review before editing

- Check `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/SECURITY.md`, and
  `docs/API.md` for the contract your change touches.
- Roles and authorization are enforced server-side; never move a server-side
  check into the UI.
- Treat document text and user questions as untrusted data.
- Schema changes must be incremental migrations; never reset or delete an
  existing database or volume.
- Do not send secrets, non-public document text, or unauthorized data to logs,
  the client, or external services.

## Pull request contract

- One logical change per pull request.
- Keep the diff as small as possible; avoid unrelated refactoring.
- Add or update tests for behavior changes and regressions.
- Update documentation when behavior, API, security, schema, or commands change.
- Do not commit secrets, `.env`, build output, or local database files.
- Do not add dependencies unless they are necessary and licensed compatibly.
- Confirm the relevant checks above pass and report pass/fail/skip honestly.

## Commit messages

Use a short, imperative subject line. Conventional prefixes (`feat:`, `fix:`,
`docs:`, `chore:`) are welcome but not required.

## Reporting bugs and features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. Include the minimum
information needed to reproduce the problem, and remove secrets and personal data.

## Security issues

See `SECURITY.md`. Do not post exploit details or secrets in public issues.

## License

By submitting a pull request, you agree that your contribution is licensed under
the MIT License of this project (see `LICENSE`).