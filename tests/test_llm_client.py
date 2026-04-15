import pytest

from qgen.config import AppConfig
from qgen.question_generator import build_llm_client


def test_build_llm_client_errors_when_no_gateway_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GW_GATEWAY_API_KEY", raising=False)
    monkeypatch.setenv("GW_BASE_URL", "https://example.invalid")
    monkeypatch.setenv("GW_CHAT_MODEL", "gpt-4.1-mini")
    cfg = AppConfig.from_dict({})
    with pytest.raises(ValueError, match="GW_GATEWAY_API_KEY"):
        build_llm_client(cfg)


def test_build_llm_client_errors_when_no_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GW_GATEWAY_API_KEY", "gw_dummy_key")
    monkeypatch.delenv("GW_BASE_URL", raising=False)
    cfg = AppConfig.from_dict({})
    with pytest.raises(ValueError, match="GW_BASE_URL"):
        build_llm_client(cfg)


def test_build_llm_client_constructs_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GW_GATEWAY_API_KEY", "gw_dummy_key")
    monkeypatch.setenv("GW_BASE_URL", "https://example.invalid")
    monkeypatch.setenv("GW_CHAT_MODEL", "gpt-4.1-mini")

    captured: dict[str, object] = {}

    class _FakeOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(
        "qgen.question_generator.OpenAI", _FakeOpenAI, raising=True
    )

    cfg = AppConfig.from_dict({})
    client = build_llm_client(cfg)
    assert client is not None
    assert captured["api_key"] == "gw_dummy_key"
    assert captured["base_url"] == "https://example.invalid"
