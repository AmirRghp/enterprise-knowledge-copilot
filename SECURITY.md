# Security Policy

This document is the entry point for security reporting and the security posture of
**Enterprise Knowledge Copilot**. Detailed, implementation-level controls are
documented in `docs/SECURITY.md` in the source tree (development documentation).

## Supported versions

Only the latest state of the `main` branch (and the most recent release built
from it) is supported. There is no long-term support branch and no backported
security fixes for older releases.

## Reporting a vulnerability

Please do not open a public issue with exploit details or a working proof of
concept.

**Current reporting path (verified on 2026-10-22):** GitHub's private
vulnerability reporting feature is **disabled** for this repository (the GitHub
REST API reports `{"enabled": false}`). Until it is enabled, use one of these:

1. Open a GitHub issue using the "Security issue" guidance below, with the
   minimum information needed and **no secrets**.
2. Contact the maintainer privately through GitHub (`@AmirRghp`) for sensitive
   details that must not be public.

No response-time commitment or SLA is made. Reports are handled on a best-effort
basis. If a report is accepted, credit is optional and follows the reporter's
preference.

### What to include

- Affected version or commit SHA.
- A minimal, reproducible description of the issue.
- The impact you believe it has.
- Whether any real data, credentials, or documents were exposed.

### What not to include

- API keys, passwords, tokens, `.env` contents, or database credentials.
- Real organizational documents or personal data.
- Full exploit code that could be used against other installations.

## Scope

**In scope:** the code in `apps/api`, `apps/web`, `docker/`, `compose.yaml`,
`compose.ollama-linux.yaml`, and the documented runtime configuration.

**Out of scope:** third-party providers and APIs (OpenAI, OpenRouter, Ollama,
PostgreSQL, base images), the host operating system, and infrastructure you
operate. Denial-of-service against systems you do not own is also out of scope.

## Security-relevant design notes

- Authentication is server-side: roles and active status are read from the
  database on every request; client-supplied roles are never trusted.
- Retrieval, rerank, generation, citation validation, and source display all
  re-check authorization and the current revision before returning data.
- Provider credentials are encrypted at rest with `APP_ENCRYPTION_KEY` and never
  logged.
- Uploaded documents are limited by type and size (1 MiB by default) and are
  never executed.
- The application does not use `next/image`; image optimization is disabled.

For the full control list, see `docs/SECURITY.md` in the source tree.