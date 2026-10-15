from anyio import CapacityLimiter
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.answer_rate_limit import AnswerRateLimiter
from app.api.answers import ANSWERS_PATH
from app.api.answers import router as answers_router
from app.api.auth import router as auth_router
from app.api.conversations import router as conversations_router
from app.api.documents import router as documents_router
from app.api.health import router as health_router
from app.api.manager import UPLOAD_PATH
from app.api.manager import router as manager_router
from app.api.organization import router as organization_router
from app.api.providers import router as providers_router
from app.api.rate_limits import router as rate_limits_router
from app.api.system_prompts import router as system_prompts_router
from app.api.upload_guard import JSON_BODY_CEILING, UploadGuard, upload_body_ceiling
from app.api.users import router as users_router
from app.auth.rate_limit import LoginRateLimiter
from app.providers.capacity import ProviderCapacity
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
    app.state.provider_capacity = ProviderCapacity()
    # Part 15. Built here rather than per request so the window is shared across every
    # request in this process, which is the entire point of a limiter.
    app.state.answer_rate_limiter = AnswerRateLimiter(
        user_limit=6,
        window_seconds=60,
        max_keys=10_000,
    )
    # The routes that need settings reach the same object rather than rebuilding it.
    app.state.settings = settings

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
    # Auth and manager routes declare their own /api/... prefix.
    app.include_router(auth_router)
    app.include_router(users_router)
    app.include_router(manager_router)
    app.include_router(providers_router)
    app.include_router(system_prompts_router)
    app.include_router(rate_limits_router)
    app.include_router(organization_router)
    # Part 15. Both declared their own /api prefix.
    app.include_router(documents_router)
    app.include_router(answers_router)
    app.include_router(conversations_router)

    # User middleware wraps the router, so it runs before FastAPI parses the body -
    # which it otherwise does before any dependency, and so before the Origin, role and
    # rate checks in the route.
    #
    # Two entries because the two bodies are different things. A multipart upload is a file
    # plus framing overhead; the answer request is a single JSON object, and reusing the
    # multipart figure there would leave a ceiling an order of magnitude above anything
    # legitimate. The answer path is included because pydantic ignores unknown fields, so a
    # valid question beside a very large extra field would otherwise be accepted - and
    # because a sender with no session could still make the server allocate before any
    # dependency refused it.
    app.add_middleware(
        UploadGuard,
        upload_path=UPLOAD_PATH,
        upload_max_body_bytes=upload_body_ceiling(settings),
        json_paths={
            ANSWERS_PATH: JSON_BODY_CEILING,
            "/api/manager/providers": JSON_BODY_CEILING,
            "/api/manager/system-prompts": JSON_BODY_CEILING,
            "/api/manager/settings/rate-limits": 8192,
            "/api/manager/settings/organization": 8192,
            "/api/auth/setup": 8192,
            "/api/manager/users": 8192,
        },
        settings=settings,
    )
    return app
