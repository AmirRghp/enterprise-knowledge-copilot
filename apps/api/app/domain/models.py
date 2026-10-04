"""Domain contracts shared across modules.

These types are framework-free by design: CODE_STYLE.md section 4 forbids the
domain layer from depending on a framework or a provider, so ``Actor`` and
``Role`` carry no FastAPI or SQLAlchemy types.
"""

from typing import Literal
from uuid import UUID

Role = Literal["employee", "manager"]

ROLES: tuple[Role, ...] = ("employee", "manager")


class Actor:
    """A request authenticated by a valid server-side session.

    ``role`` is always read from the ``users`` row on every request. It is never
    copied into the session record and never taken from a header, query
    parameter, or request body (SECURITY.md section 2).
    """

    __slots__ = ("role", "session_id", "user_id")

    def __init__(self, user_id: UUID, role: Role, session_id: UUID) -> None:
        self.user_id = user_id
        self.role = role
        self.session_id = session_id

    def __repr__(self) -> str:
        return f"Actor(user_id={self.user_id}, role={self.role!r})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Actor):
            return NotImplemented
        return (
            self.user_id == other.user_id
            and self.role == other.role
            and self.session_id == other.session_id
        )

    def __hash__(self) -> int:
        return hash((self.user_id, self.role, self.session_id))


def is_valid_role(value: object) -> bool:
    """Narrow an arbitrary value to a :data:`Role` without trusting the caller."""
    return value in ROLES
