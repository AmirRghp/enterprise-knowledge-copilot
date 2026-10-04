from anyio import CapacityLimiter
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.auth import router as auth_router
from app.api.health import router as health_router
from app.auth.rate_limit import LoginRateLimiter
from app.settings import load_settings


def create_app() -> FastAPI:
    settings = load_settings()
    app = FastAPI(title="Enterprise Knowledge Copilot API", version="0.1.0")
    app.state.login_rate_limiter = LoginRateLimiter(
        settings.login_rate_pair_limit,
        settings.login_rate_ip_limit,
        settings.login_rate_window_seconds,
        settings.login_rate_max_keys,
    )
    app.state.password_limiter = CapacityLimiter(4)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        # Never serialize raw input, validation context or messages containing secrets.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [{"loc": item["loc"], "type": item["type"]} for item in error.errors()]
            },
        )

    app.include_router(health_router, prefix="/api")
    # Auth routes declare their own /api/auth prefix.
    app.include_router(auth_router)
    return app
