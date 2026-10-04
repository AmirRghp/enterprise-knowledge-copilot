"""Regression tests for the provisioning guard in ``apps/api/sql/provision.sql``.

The guards once read a raw ``count(*)`` into psql's ``\\if``. psql only treats
``0`` and ``1`` as booleans and silently takes the FALSE branch for any other
integer, so a collision affecting *both* target databases produced ``2``,
silently bypassed the guard, and let the script continue into ``CREATE EXTENSION``
against a database it did not own -- while still printing success and exiting 0.

These tests are static: they read the SQL file and assert that no ``\\if`` is fed
a ``count(*)``. The behavioural matrix is proven against a live psql in the
documented run log; see DATABASE.md section 11 and TESTING.md section 7.
"""

import re
from pathlib import Path

PROVISION_SQL = Path(__file__).resolve().parents[1] / "sql" / "provision.sql"
SOURCE = PROVISION_SQL.read_text(encoding="utf-8")


def _strip_comments(sql: str) -> str:
    return "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))


def _conditional_flags(sql: str) -> list[str]:
    """Names of variables consumed by ``\\if``, in file order."""
    return re.findall(r"^\\if\s+:(\w+)", sql, flags=re.MULTILINE)


def _projection_for(sql: str, alias: str) -> str | None:
    """Return the ``SELECT ... AS <alias>`` projection, honouring nested parens."""
    for match in re.finditer(r"SELECT\s+EXISTS\s*\(", sql):
        depth = 0
        for index in range(match.end() - 1, len(sql)):
            if sql[index] == "(":
                depth += 1
            elif sql[index] == ")":
                depth -= 1
                if depth == 0:
                    tail = sql[index + 1 :]
                    if re.match(rf"\s*AS\s+{re.escape(alias)}\b", tail):
                        return sql[match.start() : index + 1]
                    break
    return None


def test_provision_sql_exists_and_is_readable() -> None:
    assert PROVISION_SQL.is_file()
    assert "ON_ERROR_STOP" in SOURCE


def test_no_conditional_reads_a_count_aggregate() -> None:
    """A count(*) feeding \\if is the defect: any value above 1 bypasses the guard."""
    offenders = [
        name
        for name in _conditional_flags(SOURCE)
        for match in re.finditer(
            rf"count\(\*\)\s+AS\s+{re.escape(name)}\b", _strip_comments(SOURCE)
        )
    ]
    assert not offenders, f"these \\if flags are fed by count(*): {offenders}"


def test_guard_flags_are_boolean_exists() -> None:
    """Each guard must be an EXISTS projection, which can only be t or f."""
    guards = ("foreign_owned_db", "over_privileged_role", "extra_owned_db")
    body = _strip_comments(SOURCE)
    for guard in guards:
        assert _projection_for(body, guard) is not None, (
            f"{guard} is not a boolean EXISTS projection"
        )
        assert guard in _conditional_flags(SOURCE)


def test_secret_flag_is_boolean_not_arithmetic() -> None:
    """The password check must yield true/false, not 0/1."""
    body = _strip_comments(SOURCE)
    assert re.search(r"=\s*0\s+AS\s+secret_missing\b", body)
    assert "CASE" not in re.search(r".*AS\s+secret_missing\b", body, flags=re.DOTALL).group(0)


def test_guards_precede_every_mutation() -> None:
    """No CREATE/ALTER/\\connect may appear before the last guard."""
    body = _strip_comments(SOURCE)
    statements = [
        match.start()
        for match in re.finditer(r"CREATE\s+(ROLE|DATABASE|EXTENSION)|ALTER\s+ROLE|\\connect", body)
    ]
    guards = [match.start() for match in re.finditer(r"AS\s+\w*_?(owned_db|role)\b", body)]
    assert guards, "no guard definitions found"
    assert statements, "no mutation statements found"
    assert max(guards) < min(statements), (
        "a mutation statement appears before the guards finish; "
        "the fail-closed guarantee would be lost"
    )


def test_every_if_is_followed_by_an_endif() -> None:
    depth = 0
    for match in re.finditer(r"^\\(if|endif)\b", SOURCE, flags=re.MULTILINE):
        depth += 1 if match.group(1) == "if" else -1
        assert depth >= 0, "unmatched \\endif"
    assert depth == 0, f"{depth} unterminated \\if block(s)"


def test_password_is_read_from_environment_not_argv() -> None:
    """The secret must come from the container environment."""
    assert re.search(r'\\set\s+provision_secret\s+`printf\s+%s\s+"\$EKC_DB_PASSWORD"`', SOURCE)
    assert "-v app_password" not in SOURCE
    assert "app_password" not in SOURCE


def test_guard_flags_yield_booleans_not_integers() -> None:
    """An EXISTS projection must be typed boolean, which \\if always accepts.

    psql's ``\\if`` treats 0 and 1 as booleans but silently takes the FALSE branch
    for any other integer, so a flag whose SQL type is integer is only safe while
    it happens to be 0 or 1. EXISTS is boolean and therefore has no unsafe value.
    """
    body = _strip_comments(SOURCE)
    for guard in ("foreign_owned_db", "over_privileged_role", "extra_owned_db"):
        projection = _projection_for(body, guard)
        assert projection is not None, f"{guard} has no EXISTS projection"
        assert not re.match(
            r"SELECT\s+(count|sum|min|max|avg)\s*\(", projection, flags=re.IGNORECASE
        ), f"{guard} uses a non-boolean aggregate"
