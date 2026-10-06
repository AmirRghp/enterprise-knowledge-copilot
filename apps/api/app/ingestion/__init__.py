"""Document ingestion: validated upload, a durable queue, and the worker.

ARCHITECTURE.md section 6 describes the flow this package implements. The router
lives in ``app/api/manager.py``; everything here is framework-free so the worker
CLI and the tests drive exactly the same code.
"""
