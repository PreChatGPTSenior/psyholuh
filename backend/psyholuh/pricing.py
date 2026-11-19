import json
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from urllib.parse import quote

import httpx

from . import config
from .budget import BudgetError, PriceQuote, charge_amount, decimal_amount

API_ROOT = "https://openrouter.ai/api/v1"
TTL = 120
CACHE_SIZE = 16
MODEL_SLUG = re.compile(r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+")
ROUTE_TAG = re.compile(r"[a-z0-9_.-]+(?:/[a-z0-9_.-]+)*")
UNIT = 1_000_000

# This request sends text only and has no tools, web search, transforms, or plugins.
TEXT_RATES = {
    "prompt",
    "completion",
    "request",
    "internal_reasoning",
    "input_cache_read",
    "input_cache_write",
    "input_cache_write_1h",
}
OTHER_MODALITY_RATES = {"image", "image_output", "audio", "audio_output", "web_search"}
PRICE_FIELDS = TEXT_RATES | OTHER_MODALITY_RATES | {"discount", "overrides"}


@dataclass(frozen=True)
class Rates:
    prompt: Decimal
    completion: Decimal
    request: Decimal
    cache: Decimal
    reasoning: Decimal

    def maximum(self, other: "Rates") -> "Rates":
        return Rates(
            max(self.prompt, other.prompt),
            max(self.completion, other.completion),
            max(self.request, other.request),
            max(self.cache, other.cache),
            max(self.reasoning, other.reasoning),
        )


@dataclass(frozen=True)
class Catalog:
    endpoints: list[dict]
    expires_at: float


catalogs: OrderedDict[str, Catalog] = OrderedDict()


def json_decimals(body: bytes | str):
    return json.loads(body, parse_float=Decimal)


def price(value) -> Decimal:
    amount = decimal_amount(value)
    # An unsupported or nonsensical catalog price cannot authorize a paid call.
    if amount > 1 or amount.as_tuple().exponent < -24:
        raise ValueError("Catalog rate out of range")
    return amount


def price_tier(pricing: dict) -> Rates:
    discount = price(pricing.get("discount", 0))
    if discount >= 1:
        raise ValueError("Unbounded catalog discount")
    factor = 1 - discount

    def rate(name: str, required: bool = False) -> Decimal:
        raw = price(pricing[name] if required else pricing.get(name, 0))
        # Catalog discounts may be conditional. Use the undiscounted rate,
        # rounded upward if reconstructing it does not terminate exactly.
        return (raw / factor).quantize(
            Decimal("0.000000000000000001"), rounding=ROUND_CEILING
        )

    return Rates(
        rate("prompt", required=True),
        rate("completion", required=True),
        rate("request"),
        max(
            rate("input_cache_read"),
            rate("input_cache_write"),
            rate("input_cache_write_1h"),
        ),
        rate("internal_reasoning"),
    )


def endpoint_rates(
    endpoint: dict, prompt_tokens: int, completion_tokens: int
) -> Rates | None:
    if endpoint.get("service_tier") not in (None, "default", "standard"):
        return None
    parameters = endpoint.get("supported_parameters")
    if not isinstance(parameters, list) or not {"max_tokens", "reasoning"}.issubset(
        parameters
    ):
        return None
    context = endpoint.get("context_length")
    prompt_limit = endpoint.get("max_prompt_tokens")
    completion_limit = endpoint.get("max_completion_tokens")
    if type(context) is not int or prompt_tokens + completion_tokens > context:
        return None
    if prompt_limit is not None and (
        type(prompt_limit) is not int or prompt_tokens > prompt_limit
    ):
        return None
    if completion_limit is not None and (
        type(completion_limit) is not int or completion_tokens > completion_limit
    ):
        return None
    pricing = endpoint.get("pricing")
    if not isinstance(pricing, dict) or pricing.keys() - PRICE_FIELDS:
        return None
    try:
        base = price_tier(pricing)
        overrides = pricing.get("overrides", [])
        if not isinstance(overrides, list) or len(overrides) > 24:
            return None
        for tier in overrides:
            if not isinstance(tier, dict) or tier.keys() - (
                PRICE_FIELDS - {"overrides"} | {"min_prompt_tokens"}
            ):
                return None
            threshold = tier.get("min_prompt_tokens")
            if type(threshold) is not int or threshold < 0:
                return None
            if prompt_tokens >= threshold:
                base = base.maximum(price_tier(pricing | tier))
    except (KeyError, ValueError, ArithmeticError):
        return None
    return base


def verify_free_router(models) -> None:
    if not isinstance(models, list) or not 0 < len(models) <= 2048:
        raise ValueError("Invalid public model catalog")
    found = [
        item
        for item in models
        if isinstance(item, dict) and item.get("id") == config.FREE_ROUTER
    ]
    if len(found) != 1:
        raise ValueError("Free router missing or duplicated")
    prices = found[0]["pricing"]
    if (
        not isinstance(prices, dict)
        or not {"prompt", "completion"}.issubset(prices)
        or prices.keys() - PRICE_FIELDS
        or prices.get("overrides", []) != []
        or any(price(rate) != 0 for key, rate in prices.items() if key != "overrides")
    ):
        raise ValueError("Free router does not have a verified zero price")


async def fetch_catalog(client: httpx.AsyncClient, model: str) -> Catalog:
    now = time.monotonic()
    previous = catalogs.get(model)
    if previous is not None and previous.expires_at > now:
        catalogs.move_to_end(model)
        return previous
    if not MODEL_SLUG.fullmatch(model):
        raise ValueError("Request must use a concrete catalog model")
    path = (
        "models"
        if model == config.FREE_ROUTER
        else f"models/{quote(model, safe='/')}/endpoints"
    )
    response = await client.get(
        f"{API_ROOT}/{path}", timeout=httpx.Timeout(8, connect=4)
    )
    response.raise_for_status()
    if len(response.content) > 2_000_000:
        raise ValueError("Catalog response is too large")
    data = json_decimals(response.content)["data"]
    if model == config.FREE_ROUTER:
        verify_free_router(data)
        endpoints = []
    else:
        if data["id"] != model:
            raise ValueError("Catalog does not match the requested model")
        endpoints = data["endpoints"]
        if not isinstance(endpoints, list) or not 0 < len(endpoints) <= 256:
            raise ValueError("Invalid endpoint catalog")
    result = Catalog(endpoints, now + TTL)
    catalogs[model] = result
    catalogs.move_to_end(model)
    while len(catalogs) > CACHE_SIZE:
        catalogs.popitem(last=False)
    return result


async def quote_request(
    client: httpx.AsyncClient, payload: dict, revision: int
) -> PriceQuote:
    try:
        catalog = await fetch_catalog(client, payload["model"])
        # UTF-8 plus rendered role/framing headroom bounds text tokenization
        # conservatively without relying on a provider-specific tokenizer.
        prompt_tokens = 256 + sum(
            len(message["content"].encode("utf-8")) + len(message["role"]) + 64
            for message in payload["messages"]
        )
        completion_tokens = payload["max_tokens"]
        if payload["model"] == config.FREE_ROUTER:
            routing = {
                "allow_fallbacks": False,
                "max_price": dict.fromkeys(
                    ("prompt", "completion", "request", "audio", "image"), "0"
                ),
            }
            return PriceQuote(
                prompt_tokens, completion_tokens, 0, routing, catalog.expires_at
            )
        groups: dict[str, list[Rates | None]] = {}
        for endpoint in catalog.endpoints:
            if not isinstance(endpoint, dict):
                raise TypeError("Invalid endpoint")
            tag = endpoint.get("tag")
            if isinstance(tag, str) and ROUTE_TAG.fullmatch(tag):
                groups.setdefault(tag, []).append(
                    endpoint_rates(endpoint, prompt_tokens, completion_tokens)
                )

        offers = []
        for tag, endpoints in groups.items():
            # A parent slug also matches any of its catalog variants. Include
            # them in the same bound or discard the route if any is unverified.
            candidates = endpoints + [
                rate
                for child, child_rates in groups.items()
                if child.startswith(tag + "/")
                for rate in child_rates
            ]
            if any(rate is None for rate in candidates):
                continue
            rates = Rates(Decimal(0), Decimal(0), Decimal(0), Decimal(0), Decimal(0))
            for rate in candidates:
                rates = rates.maximum(rate)
            expected = charge_amount(
                prompt_tokens * (rates.prompt + rates.cache)
                + completion_tokens * (rates.completion + rates.reasoning)
                + rates.request
            )
            offers.append((expected, tag, rates))
        if not offers:
            raise ValueError("No eligible OpenRouter endpoint has a bounded quote")
        amount, tag, rates = min(offers, key=lambda item: (item[0], item[1]))
        routing = {
            "only": [tag],
            "order": [tag],
            "allow_fallbacks": False,
            "require_parameters": True,
            "max_price": {
                "prompt": format(rates.prompt * UNIT, "f"),
                "completion": format(rates.completion * UNIT, "f"),
                "request": format(rates.request, "f"),
            },
        }
        return PriceQuote(
            prompt_tokens, completion_tokens, amount, routing, catalog.expires_at
        )
    except (httpx.HTTPError, KeyError, TypeError, ValueError, ArithmeticError) as exc:
        raise BudgetError("budget_pricing_unavailable", revision) from exc
