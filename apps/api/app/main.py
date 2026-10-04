from fastapi import FastAPI

from app.api.health import router as health_router
from app.settings import load_settings


def create_app() -> FastAPI:
    load_settings()
    app = FastAPI(title="Enterprise Knowledge Copilot API", version="0.1.0")
    app.include_router(health_router, prefix="/api")
    return app
