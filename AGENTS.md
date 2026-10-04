# Project instructions

Read [docs/AGENTS.md](docs/AGENTS.md) and the relevant core documents before substantial work. That file centralizes this project's agent instructions; keep this root file as a discovery pointer.

Part 3 adds the isolated project database, ORM models, Alembic migrations, and an operator provisioning script under apps/api; it is approved and published after local verification. Part 4 adds server-side authentication (login/logout/me, Argon2id, opaque sessions, Origin enforcement, and bounded in-process login throttling) under apps/api; implementation and targeted/full local checks passed, and it awaits user review before publication. The limiter uses the actual peer address; direct local proxy traffic shares the loopback IP bucket because forwarded headers are ignored.
