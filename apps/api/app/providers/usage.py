"""Combine known figures without turning incomplete accounting into zero."""

from collections.abc import Sequence
from typing import Any

from app.providers.base import ProviderUsage


def usage_record(usage: ProviderUsage) -> dict[str, Any]:
    return {
        "provider": usage.provider,
        "model": usage.model,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "attempts": usage.attempts,
        "billed_units": usage.billed_units,
        "cost": str(usage.cost) if usage.cost is not None else None,
        "currency": usage.currency,
    }


def summarize_usage(usages: Sequence[ProviderUsage]) -> ProviderUsage | None:
    if not usages:
        return None

    def total(name: str) -> Any:
        values = [getattr(usage, name) for usage in usages]
        return sum(values) if all(v is not None for v in values) else None

    last = usages[-1]
    common = set.intersection(*(set(u.billed_units or {}) for u in usages))
    billed: dict[str, int | float | str] = {}
    for key in common if len({u.provider for u in usages}) == 1 else []:
        values = [(u.billed_units or {})[key] for u in usages]
        numeric = [
            value
            for value in values
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ]
        if len(numeric) == len(values):
            billed[key] = sum(numeric)
    if len(usages) == 1:
        billed = last.billed_units or {}

    return ProviderUsage(
        provider=last.provider if len({u.provider for u in usages}) == 1 else "multiple",
        model=last.model if len({u.model for u in usages}) == 1 else "multiple",
        input_tokens=total("input_tokens"),
        output_tokens=total("output_tokens"),
        attempts=total("attempts"),
        cost=total("cost")
        if len(usages) == 1
        or (last.currency is not None and len({u.currency for u in usages}) == 1)
        else None,
        currency=last.currency if len({u.currency for u in usages}) == 1 else None,
        billed_units=billed or None,
    )
