"""Acceptance run for Part 10 against the running stack.

Drives the real API over HTTP and inspects the real application database, so
nothing here is a stub. Every claim printed is read back from the database or from
a response, not assumed from the request that was sent.
"""

from __future__ import annotations

import asyncio
import getpass
import json
import os
import pathlib
import subprocess
import time

import httpx

API = "http://127.0.0.1:8000"
WEB_ORIGIN = "http://localhost:3000"
# The environment file lives at the repository root, one level above apps/api.
ENV = pathlib.Path(__file__).resolve().parents[3] / ".env"

V1 = """# سیاست جبران خدمت

مقدمه‌ای کوتاه.

## شرایط

درخواست تا پایان همان ماه ثبت شود.

## استثنا

در صورت بیماری، مهلت یک ماه دیگر است.
"""

V2 = """# سیاست جبران خدمت

مقدمه‌ای کوتاه.

## استثنا

در صورت بیماری، مهلت یک ماه دیگر است.

## مهلت

مهلت ثبت درخواست سه ماه است.
"""

# Passes upload validation, then fails deterministically in the parser: an
# unterminated front-matter block. A whitespace-only body would be refused at
# upload time, so it would never reach a worker at all.
UNPARSEABLE = "---\ntitle: x\nkey: y\n\nمتن بدنه\n"


def psql(sql: str) -> str:
    """Run one read-only query against the application database."""
    password = ""
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith("DB_PASSWORD="):
            password = line.split("=", 1)[1]
    result = subprocess.run(
        [
            "psql",
            "-h",
            "127.0.0.1",
            "-p",
            "5433",
            "-U",
            "enterprise_knowledge_copilot",
            "-d",
            "enterprise_knowledge_copilot",
            "-Atc",
            sql,
        ],
        capture_output=True,
        text=True,
        env={"PGPASSWORD": password, "PATH": "/usr/bin:/bin"},
        check=True,
    )
    return result.stdout.strip()


def document_row(document_id: str) -> dict[str, str]:
    raw = psql(
        "SELECT status || '|' || access_role || '|' || COALESCE(staged_access_role, '-') || '|'"
        " || title || '|' || COALESCE(current_revision, '-') || '|' || COALESCE(staged_title, '-')"
        f" FROM documents WHERE document_id = '{document_id}'"
    )
    keys = [
        "status",
        "access_role",
        "staged_access_role",
        "title",
        "current_revision",
        "staged_title",
    ]
    values = raw.split("|")
    return dict(zip(keys, values, strict=False))


def section_ids_of_revision(document_id: str, revision: str) -> list[str]:
    out = psql(
        "SELECT string_agg(section_id, ',' ORDER BY ordinal) FROM sections"
        f" WHERE document_id = '{document_id}' AND revision = '{revision}'"
    )
    return out.split(",") if out else []


def revision_row_count(document_id: str, revision: str) -> tuple[int, int]:
    raw = psql(
        "SELECT (SELECT count(*) FROM sections WHERE document_id ="
        f" '{document_id}' AND revision = '{revision}') || '|' ||"
        " (SELECT count(*) FROM chunks WHERE document_id ="
        f" '{document_id}' AND revision = '{revision}')"
    )
    return tuple(int(part) for part in raw.split("|"))  # type: ignore[return-value]


async def wait_for_job(client: httpx.AsyncClient, job_id: str, *, label: str) -> dict[str, object]:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        response = await client.get(
            f"{API}/api/manager/jobs/{job_id}", headers={"Origin": WEB_ORIGIN}
        )
        response.raise_for_status()
        body = response.json()
        if body["status"] in ("ready", "failed"):
            print(
                f"      job {job_id[:8]} → {body['status']}"
                + (f" ({body['safe_error']})" if body["safe_error"] else "")
            )
            return body
        await asyncio.sleep(1.0)
    raise AssertionError(f"{label}: job {job_id} never settled")


async def main() -> int:
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        checks.append((name, condition, detail))
        print(f"  {'OK  ' if condition else 'FAIL'} {name}{'  ' + detail if detail else ''}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        print("\n[0] ورود به عنوان مدیر")
        login = await client.post(
            f"{API}/api/auth/login",
            json={
                "login": os.environ.get("EKC_MANAGER_LOGIN", "manager"),
                "password": _manager_password(),
            },
            headers={"Origin": WEB_ORIGIN},
        )
        check("login 200", login.status_code == 200, str(login.status_code))
        cookie = login.cookies.get("ekc_session")
        check("session cookie issued", bool(cookie))
        client.cookies.set("ekc_session", cookie or "")

        print("\n[1] وضعیت اولیهٔ یک سند مجموعه")
        before = section_ids_of_revision(
            "DOC-001", psql("SELECT current_revision FROM documents WHERE document_id='DOC-001'")
        )
        print(f"      DOC-001 sections: {before}")

        print("\n[2] بارگذاری سند تازه با دسترسی کارمندان")
        created = await _send(
            client, "POST", f"{API}/api/manager/documents", V1, "سیاست جبران خدمت", "employee"
        )
        check("create 202", created.status_code == 202, str(created.status_code))
        document_id = created.json()["document_id"]
        job = created.json()["job_id"]
        check("no document text in the response", "جبران" not in created.text)
        settled = await wait_for_job(client, job, label="create")
        check("create became ready", settled["status"] == "ready", str(settled["status"]))
        v1_sections = section_ids_of_revision(
            document_id, document_row(document_id)["current_revision"]
        )
        print(f"      published sections: {v1_sections}")
        check("three sections published", len(v1_sections) == 3, str(v1_sections))
        check("effective role is employee", document_row(document_id)["access_role"] == "employee")

        print("\n[3] جایگزینی با باریک‌تر کردن دسترسی (employee → manager)")
        narrowed = await _send(
            client,
            "PUT",
            f"{API}/api/manager/documents/{document_id}",
            V2,
            "سیاست جبران خدمت",
            "manager",
        )
        check("replace 202", narrowed.status_code == 202, str(narrowed.status_code))
        immediate = document_row(document_id)
        check(
            "narrowing applies while the job is still running",
            immediate["access_role"] == "manager",
            f"access_role={immediate['access_role']} staged={immediate['staged_access_role']}",
        )
        check(
            "the published title is untouched before activation",
            immediate["title"] == "سیاست جبران خدمت",
            immediate["title"],
        )
        settled = await wait_for_job(client, narrowed.json()["job_id"], label="narrow")
        check("narrowed replacement ready", settled["status"] == "ready", str(settled["status"]))
        after_narrow = document_row(document_id)
        v2_sections = section_ids_of_revision(document_id, after_narrow["current_revision"])
        print(f"      published sections after replacement: {v2_sections}")
        check(
            "staging columns cleared at activation",
            after_narrow["staged_access_role"] == "-" and after_narrow["staged_title"] == "-",
        )
        check(
            "kept section kept its id",
            v1_sections[0] == v2_sections[0] and v1_sections[2] == v2_sections[1],
            f"{v1_sections} → {v2_sections}",
        )
        check(
            "removed section id not recycled",
            v1_sections[1] not in v2_sections,
            f"{v1_sections[1]} vs {v2_sections}",
        )
        check(
            "new section got an id above the mark",
            int(v2_sections[2][1:]) > max(int(s[1:]) for s in v1_sections),
            str(v2_sections),
        )

        print("\n[4] جایگزینی با گسترده‌تر کردن دسترسی (manager → employee)")
        widened = await _send(
            client,
            "PUT",
            f"{API}/api/manager/documents/{document_id}",
            V1,
            "سیاست جبران خدمت",
            "employee",
        )
        check("replace 202", widened.status_code == 202, str(widened.status_code))
        immediate = document_row(document_id)
        check(
            "widening does not apply before activation",
            immediate["access_role"] == "manager" and immediate["staged_access_role"] == "employee",
            f"access_role={immediate['access_role']} staged={immediate['staged_access_role']}",
        )
        settled = await wait_for_job(client, widened.json()["job_id"], label="widen")
        check("widened replacement ready", settled["status"] == "ready", str(settled["status"]))
        after_widen = document_row(document_id)
        check(
            "widening applied at activation",
            after_widen["access_role"] == "employee",
            after_widen["access_role"],
        )

        print("\n[5] جایگزینی‌ای که شکست می‌خورد")
        published_before = document_row(document_id)["current_revision"]
        sections_before = section_ids_of_revision(document_id, published_before)
        failed = await _send(
            client,
            "PUT",
            f"{API}/api/manager/documents/{document_id}",
            UNPARSEABLE,
            "عنوان نامعتبر",
            "manager",
        )
        check("replace 202", failed.status_code == 202, str(failed.status_code))
        check(
            "narrowing applied at once even though the replacement will fail",
            document_row(document_id)["access_role"] == "manager",
        )
        settled = await wait_for_job(client, failed.json()["job_id"], label="fail")
        check("failed job reported", settled["status"] == "failed", str(settled["safe_error"]))
        after_fail = document_row(document_id)
        check(
            "failed replacement kept the narrowing",
            after_fail["access_role"] == "manager",
            after_fail["access_role"],
        )
        check(
            "failed replacement kept the current revision",
            after_fail["current_revision"] == published_before,
        )
        check(
            "failed replacement left the sections alone",
            section_ids_of_revision(document_id, published_before) == sections_before,
        )
        check("staging columns cleared after failure", after_fail["staged_access_role"] == "-")
        check(
            "failed replacement left no staged rows",
            revision_row_count(document_id, failed.json()["revision"]) == (0, 0),
            str(revision_row_count(document_id, failed.json()["revision"])),
        )

        print("\n[6] حذف منطقی")
        published_revision = document_row(document_id)["current_revision"]
        published_counts = revision_row_count(document_id, published_revision)
        deleted = await client.delete(
            f"{API}/api/manager/documents/{document_id}", headers={"Origin": WEB_ORIGIN}
        )
        check("delete 204", deleted.status_code == 204, str(deleted.status_code))
        check("delete returns no body", deleted.content == b"")
        after_delete = document_row(document_id)
        check("document is inactive", after_delete["status"] == "inactive", after_delete["status"])
        check("current revision kept", after_delete["current_revision"] == published_revision)
        check(
            "published rows kept",
            revision_row_count(document_id, published_revision) == published_counts,
            str(published_counts),
        )
        check("staging columns cleared on delete", after_delete["staged_access_role"] == "-")
        again = await client.delete(
            f"{API}/api/manager/documents/{document_id}", headers={"Origin": WEB_ORIGIN}
        )
        check("second delete is still 204", again.status_code == 204, str(again.status_code))
        unknown = await client.delete(
            f"{API}/api/manager/documents/DOC-404", headers={"Origin": WEB_ORIGIN}
        )
        check(
            "delete of an unknown id is 204", unknown.status_code == 204, str(unknown.status_code)
        )
        after_delete_replace = await _send(
            client, "PUT", f"{API}/api/manager/documents/{document_id}", V1, "دوباره", "employee"
        )
        check(
            "replacing a deleted document is 409",
            after_delete_replace.status_code == 409,
            str(after_delete_replace.status_code),
        )

        print("\n[7] فهرست، سند حذف‌شده را نشان می‌دهد")
        listing = await client.get(f"{API}/api/manager/documents", headers={"Origin": WEB_ORIGIN})
        row = next(d for d in listing.json()["documents"] if d["document_id"] == document_id)
        check("list reports inactive", row["content_status"] == "inactive", row["content_status"])

        print("\n[8] مجموعهٔ متنی دست‌نخورده مانده است")
        after = section_ids_of_revision(
            "DOC-001", psql("SELECT current_revision FROM documents WHERE document_id='DOC-001'")
        )
        check("corpus document untouched", after == before, f"{before} → {after}")
        check(
            "corpus roles untouched",
            psql("SELECT access_role FROM documents WHERE document_id='DOC-001'") == "employee",
        )

    failed_count = sum(1 for _, ok, _ in checks if not ok)
    print(f"\n{len(checks) - failed_count}/{len(checks)} acceptance checks passed")
    if failed_count:
        print(json.dumps([name for name, ok, _ in checks if not ok], ensure_ascii=False, indent=2))
    print(f"\ndocument created for this run: {document_id} (inactive)")
    return 1 if failed_count else 0


def _manager_password() -> str:
    return getpass.getpass("Manager password: ")


async def _send(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    content: str,
    title: str,
    access_role: str,
) -> httpx.Response:
    return await client.request(
        method,
        url,
        data={"title": title, "access_role": access_role},
        files={"file": ("policy.md", content.encode("utf-8"), "text/markdown")},
        headers={"Origin": WEB_ORIGIN},
    )


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
