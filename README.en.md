# Enterprise Knowledge Copilot

Persian-language assistant for asking questions about organizational documents and viewing answers with their source. A fresh installation contains no sample documents; the administrator registers the organization name and adds the organization's own documents from the management panel.

> **Data and privacy:** The product starts without sample documents. The administrator must only upload documents the organization is authorized to process. Before enabling an external provider, align the outgoing question and evidence sent for generation or reranking with the organization's privacy policy.

## Production setup

Docker Compose is the recommended path. It runs the web, API, worker, and PostgreSQL services and runs database migrations automatically.

### Requirements

- Docker with Docker Compose v2
- Internet access to pull images and build the application

### 1. Get the project

```bash
git clone https://github.com/AmirRghp/enterprise-knowledge-copilot.git
cd enterprise-knowledge-copilot
cp .env.example .env
```

### 2. Configure the environment

Replace the sample values in `.env` with two separate strong passwords:

```dotenv
POSTGRES_PASSWORD=replace-with-a-strong-unique-password
DB_PASSWORD=replace-with-another-strong-unique-password
```

If you use a provider with an API key in the panel, generate an encryption key. Put the command output in the empty `APP_ENCRYPTION_KEY=` in `.env`. You can skip this step for Ollama without an API key.

```bash
docker compose run --build --rm --no-deps api python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Keep this key safe and do not change it after provider keys are stored; without it the application cannot read stored keys.

### 3. Run the application

```bash
docker compose up -d --build
docker compose ps
```

After the services are ready, open the application:

- Application: [http://localhost:3000](http://localhost:3000)
- First administrator setup: [http://localhost:3000/setup](http://localhost:3000/setup)

On a fresh installation, register the company/organization name and the first administrator account on the setup page. This page closes after the first account is created. Add later administrators from `/manager/users`.

### 4. Connect models

In `/manager/providers`, add, test, and activate at least one **embedding** connection and one **chat** connection. A fresh installation has no provider connections. Reranking is optional and off by default.

For OpenAI or OpenRouter, enter the connection type, model name, and API key. For Ollama, run the model server separately and make sure it is reachable from the API; Compose does not install Ollama or models. `ollama-setup.md` explains host and Docker settings.

#### Linux with Docker Engine and local Ollama

If Ollama runs on the same Linux host, use the project's override file instead of the normal Compose command so the API and worker can reach host Ollama securely through the relay:

```bash
docker compose -f compose.yaml -f compose.ollama-linux.yaml up -d --build
```

Ollama and its models must be installed and running on the host separately. To view logs or stop these services, pass both files to Compose. Connection details and troubleshooting are in `ollama-setup.md`.

### 5. Upload organizational documents

Upload authorized organizational documents in `/manager/documents`. Processing runs in the background; after documents are ready, open the question page at [http://localhost:3000/ask](http://localhost:3000/ask). The repository and production image contain no sample documents.

## Runtime management

```bash
docker compose logs -f api worker web  # view service logs
docker compose down                    # stop; database data is kept
```

The web app is available on `localhost:3000` and PostgreSQL on `localhost:5434` by default. To change the PostgreSQL port, set `POSTGRES_HOST_PORT` in `.env`. Services bind only to the host loopback.

`docker compose down` keeps data. Running `docker compose down -v` removes the database volume and destroys all its data. `POSTGRES_PASSWORD` is applied only when a fresh volume is created; changing it in `.env` does not change the password of an existing volume.

## Running without Docker

This method is for development and requires Python 3.12, [`uv`](https://docs.astral.sh/uv/), Node.js 22 or newer, npm, and PostgreSQL 16 with the pgvector extension. Prepare the database and the restricted application role, then run from the repository root:

```bash
cp .env.example .env
./run.sh
```

`run.sh` syncs dependencies, runs application migrations, and starts the API, web app, and worker. Press `Ctrl+C` to stop all three. This script does not install or start PostgreSQL.

## Features

- Multi-turn Persian chat with durable, per-account history, even after logout.
- Lexical and semantic retrieval over authorized documents, with answers that cite sources.
- Source links and verified quotes shown in the details of each answer.
- Management of accounts and the lifecycle of Markdown, plain text, PDF, DOCX, XLSX, and XLS documents for administrators; text can also be typed or pasted in the form.
- Configurable providers for chat and embedding; optional reranking.

Quote validity is checked, but semantic correctness of all model prose is not guaranteed. Evaluate answer quality with human review.

## Current development status

Current capabilities are listed above. Open-source development, CI, demo, batch/local-folder ingestion, ACL/SSO, developer API, optional OCR, and operations are not implemented yet. Drive is deferred because of unreliable connectivity.

## License

Project code is licensed under MIT; the full text is in [LICENSE](LICENSE). Third-party dependencies and assets have separate licenses; see [NOTICE](NOTICE) and the related license files. The web image does not use Next.js image optimization, and sharp/libvips packages are not included in its runtime output.

## Development commands

```bash
(cd apps/api && uv run --locked pytest -q)
(cd apps/api && uv run --locked ruff check .)
(cd apps/api && uv run --locked mypy app)
(cd apps/web && npm run lint)
(cd apps/web && npm run typecheck)
(cd apps/web && npm run build)
```

## Language

This is the English entry point. The Persian version is [README.md](README.md).