# Project instructions

Read [docs/AGENTS.md](docs/AGENTS.md) and the relevant core documents before substantial work. That file centralizes this project's agent instructions; keep this root file as a discovery pointer.

Part 7 adds the Ollama embedding adapter with the Nomic prefixes, bounded retry, and vector validation under apps/api; it is implemented and verified locally but not yet published. Embedding sends `truncate: false` so over-long input errors instead of being silently trimmed, validates exactly 768 finite values, re-reads the model digest before every embedding and fails closed when it differs from the required `OLLAMA_EMBED_DIGEST`, and bounds each attempt with a real wall-clock deadline.
