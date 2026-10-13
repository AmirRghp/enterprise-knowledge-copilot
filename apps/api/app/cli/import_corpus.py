"""Stage the 20 repository corpus documents. Run the existing worker afterward."""

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select

from app.db.engine import create_engine, create_session_factory
from app.db.models import User
from app.domain.models import Actor
from app.ingestion.contracts import UploadRejectedError
from app.ingestion.corpus import ImportResult, ingest_corpus
from app.provider_config.contracts import ProviderConfigurationError
from app.settings import Settings, load_settings


async def import_corpus(settings: Settings, *, manager_login: str) -> ImportResult:
    engine = create_engine(settings)
    factory = create_session_factory(engine)
    try:
        from app.provider_config.contracts import ProviderConfigurationError
        from app.provider_config.runtime import bind_runtime, get_runtime

        if not get_runtime(await bind_runtime(settings, factory)).connections["embedding"]:
            raise ProviderConfigurationError("embedding provider is not configured")
        async with factory() as session:
            user = (
                await session.execute(
                    select(User).where(
                        User.login == manager_login,
                        User.is_active.is_(True),
                        User.role == "manager",
                    )
                )
            ).scalar_one_or_none()
            if user is None:
                raise UploadRejectedError("active manager account required")
            actor = Actor(user.user_id, "manager", uuid.uuid4())
            await session.rollback()
            return await ingest_corpus(
                session,
                actor=actor,
                max_bytes=settings.upload_max_bytes,
                max_active_documents=settings.upload_max_active_documents,
            )
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manager-login", default="manager")
    arguments = parser.parse_args(argv)
    try:
        result = asyncio.run(import_corpus(load_settings(), manager_login=arguments.manager_login))
    except ProviderConfigurationError:
        print("import refused: configure embedding in the manager panel", file=sys.stderr)
        return 1
    except UploadRejectedError as error:
        print(f"import refused: {error.safe_code}", file=sys.stderr)
        return 1
    except OSError:
        print("import failed: repository corpus files unavailable", file=sys.stderr)
        return 1
    print(f"corpus created={result.created} existing={result.existing}; run the ingestion worker")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
