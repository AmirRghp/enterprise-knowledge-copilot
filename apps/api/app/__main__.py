import sys

import uvicorn

from app.logging_setup import install_structured_logging
from app.main import create_app
from app.settings import ConfigurationError


def main() -> int:
    try:
        app = create_app()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    # The endpoint logs its request_id, reason and attempt count as `extra`; without this
    # handler those fields are computed and then dropped, and a refusal is unreadable.
    install_structured_logging()
    # Raw access logs contain query strings; keep them off until safe request logging exists.
    # Use the socket peer for throttling; arbitrary forwarding headers are untrusted.
    uvicorn.run(app, host="127.0.0.1", port=8000, access_log=False, proxy_headers=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
