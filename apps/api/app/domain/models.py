"""Domain contracts shared across modules.

These types are framework-free by design: CODE_STYLE.md section 4 forbids the
domain layer from depending on a framework or a provider, so ``Actor`` and
``Role`` carry no FastAPI or SQLAlchemy types.
"""

from typing import Literal
from uuid import UUID

Role = Literal["employee", "manager"]

ROLES: tuple[Role, ...] = ("employee", "manager")

#: How restrictive each role is: ``employee`` lets every authenticated user in,
#: ``manager`` only managers. A move up this order narrows access.
#:
#: The lattice lives in the domain layer because two unrelated subsystems need it
#: and must agree: ingestion applies a narrowing immediately, and retrieval decides
#: which rows an actor may read at all. Two copies of this order would be two
#: chances to disagree about who may see a document.
#:
#: Keyed by ``str`` rather than :data:`Role` because a column read back from the
#: database is typed ``str``. :func:`role_restriction` is the only way to read it,
#: and it refuses rather than guesses.
ROLE_RESTRICTION: dict[str, int] = {"employee": 0, "manager": 1}

#: The ``documents.access_role`` values each role may read, least restrictive
#: first. This is the retrieval allowlist; it is derived from
#: :data:`ROLE_RESTRICTION` so the read side cannot drift from the write side.
VISIBLE_ROLES: dict[Role, tuple[Role, ...]] = {
    role: tuple(
        candidate for candidate in ROLES if ROLE_RESTRICTION[candidate] <= ROLE_RESTRICTION[role]
    )
    for role in ROLES
}


def role_restriction(role: str) -> int:
    """Return how restrictive ``role`` is.

    An unknown role raises instead of defaulting. The retrieval allowlist is built
    from this ordering, so guessing here would silently widen or narrow a document
    boundary; the database CHECK already prevents the value, and this is the
    application-level refusal that does not rely on it.
    """
    if role not in ROLE_RESTRICTION:
        raise ValueError(f"unknown role: {role!r}")
    return ROLE_RESTRICTION[role]


def narrows_access(current: str, incoming: str) -> bool:
    """Return whether ``incoming`` lets fewer people in than ``current``."""
    return role_restriction(incoming) > role_restriction(current)


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
