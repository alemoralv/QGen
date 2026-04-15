from __future__ import annotations

import json
import re
import time
from abc import ABC, abstractmethod
from typing import Any

from openai import OpenAI

from qgen.config import AppConfig
from qgen.models import QARecord, Segment


def _gateway_rejects_temperature_param(exc: BaseException) -> bool:
    """True when the gateway indicates `temperature` is not valid for this model."""
    status = getattr(exc, "status_code", None)
    if status != 400:
        return False
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error") or {}
        if err.get("param") == "temperature":
            return True
        msg = str(err.get("message", "")).lower()
        if "temperature" in msg and (
            "unsupported" in msg or "not supported" in msg
        ):
            return True
    text = str(exc).lower()
    return "temperature" in text and (
        "unsupported" in text or "not supported" in text
    )


# Backwards-compat alias (tests import the old name).
_openai_rejects_temperature_param = _gateway_rejects_temperature_param


def _build_prompt(
    segment: Segment,
    question_count: int,
    question_instructions: str,
    difficulty: str,
) -> str:
    return f"""
You are generating study questions and expected correct answers from a PDF segment.

Rules:
1) Keep the output language the same as the source text language.
2) Generate exactly {question_count} question-answer pairs.
3) Follow these user instructions: {question_instructions}
4) Difficulty level: {difficulty}
5) Ensure answers are concise but complete and factually grounded in the provided text.
6) Output ONLY valid JSON (no markdown), as an array of objects with exactly:
   - question
   - expectedResponse

Source metadata:
- PDF: {segment.source_pdf}
- Segment index: {segment.segment_index}
- Page range: {segment.page_start}-{segment.page_end}

Source text:
\"\"\"
{segment.text}
\"\"\"
""".strip()


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    stripped = text.strip()
    candidates = [stripped]

    fence_match = re.search(r"```(?:json)?\s*(\[.*\])\s*```", stripped, re.DOTALL)
    if fence_match:
        candidates.insert(0, fence_match.group(1))

    array_match = re.search(r"(\[.*\])", stripped, re.DOTALL)
    if array_match:
        candidates.append(array_match.group(1))

    parse_error: Exception | None = None
    for candidate in candidates:
        repaired = re.sub(r",\s*([\]}])", r"\1", candidate)
        try:
            payload = json.loads(repaired)
            if isinstance(payload, list):
                normalized: list[dict[str, Any]] = []
                for item in payload:
                    if isinstance(item, dict):
                        normalized.append(item)
                return normalized
        except Exception as exc:  # noqa: BLE001
            parse_error = exc
    raise ValueError(f"Could not parse JSON array from model output: {parse_error}")


class CompletionClient(ABC):
    @abstractmethod
    def complete(self, prompt: str) -> str:
        pass


class _GatewayBackend(CompletionClient):
    """Calls the LLM gateway via an OpenAI-compatible Chat Completions endpoint.

    The OpenAI SDK is reused with a custom ``base_url`` so the requests are
    routed through the gateway. This keeps the call surface portable and lets
    us swap providers behind the gateway without touching this code.
    """

    def __init__(self, client: OpenAI, config: AppConfig, model: str) -> None:
        self._client = client
        self._config = config
        self._model = model
        self._omit_temperature: bool = False

    def _chat_create(self, prompt: str, *, include_temperature: bool) -> Any:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": self._config.max_output_tokens,
        }
        if include_temperature:
            kwargs["temperature"] = self._config.temperature
        return self._client.chat.completions.create(**kwargs)

    def complete(self, prompt: str) -> str:
        include_temp = not self._omit_temperature
        try:
            response = self._chat_create(prompt, include_temperature=include_temp)
        except Exception as exc:
            if include_temp and _gateway_rejects_temperature_param(exc):
                self._omit_temperature = True
                response = self._chat_create(prompt, include_temperature=False)
            else:
                raise
        try:
            content = response.choices[0].message.content
        except (AttributeError, IndexError, TypeError):
            content = ""
        return (content or "").strip()


def build_llm_client(config: AppConfig) -> CompletionClient:
    """Build the gateway-backed LLM client.

    Requires ``GW_GATEWAY_API_KEY`` and ``GW_BASE_URL`` (or whatever names were
    configured in ``config.yaml``) to be set in the environment / .env file.
    """
    api_key = config.get_gateway_key()
    base_url = config.get_gateway_base_url()
    model = config.get_gateway_model()
    client = OpenAI(api_key=api_key, base_url=base_url)
    return _GatewayBackend(client, config, model)


def generate_qa_for_segment(
    client: CompletionClient,
    config: AppConfig,
    segment: Segment,
    question_count: int,
) -> list[QARecord]:
    if question_count <= 0:
        return []
    if not segment.text.strip():
        return []

    prompt = _build_prompt(
        segment=segment,
        question_count=question_count,
        question_instructions=config.question_instructions,
        difficulty=config.difficulty,
    )

    last_error: Exception | None = None
    for attempt in range(1, config.retry_attempts + 1):
        try:
            text = client.complete(prompt)
            rows = _extract_json_array(text)
            records: list[QARecord] = []
            for row in rows[:question_count]:
                question = str(row.get("question", "")).strip()
                expected = str(row.get("expectedResponse", "")).strip()
                if question and expected:
                    records.append(
                        QARecord(
                            question=question,
                            expectedResponse=expected,
                            sourcePdf=segment.source_pdf,
                            segmentIndex=segment.segment_index,
                            pageStart=segment.page_start,
                            pageEnd=segment.page_end,
                        )
                    )
            return records
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < config.retry_attempts:
                time.sleep(config.retry_backoff_seconds * attempt)
    raise RuntimeError(
        f"Failed to generate Q&A for {segment.source_pdf} segment "
        f"{segment.segment_index} after retries: {last_error}"
    )
