from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


def _load_env_file() -> None:
    """Load variables from project-root .env, then cwd .env (if python-dotenv is installed)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")
    load_dotenv()


@dataclass(slots=True)
class AppConfig:
    # Names of the env vars that hold the gateway secrets/config.
    gateway_api_key_env: str = "GW_GATEWAY_API_KEY"
    gateway_base_url_env: str = "GW_BASE_URL"
    gateway_model_env: str = "GW_CHAT_MODEL"
    # Fallback model id used only when the env var is missing/empty.
    model: str = "gpt-4.1-mini"

    documents_dir: str = "documents"
    output_dir: str = "outputs"
    pages_per_segment: int = 10
    num_questions: int = 20
    question_instructions: str = (
        "Generate useful, factual comprehension questions that cover key points."
    )
    difficulty: str = "mixed"
    temperature: float = 0.2
    max_output_tokens: int = 4000
    include_metadata_columns: bool = False
    retry_attempts: int = 3
    retry_backoff_seconds: float = 2.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AppConfig":
        cfg = cls(**data)
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.pages_per_segment <= 0:
            raise ValueError("pages_per_segment must be > 0")
        if self.num_questions <= 0:
            raise ValueError("num_questions must be > 0")
        if not (0 <= self.temperature <= 2):
            raise ValueError("temperature must be between 0 and 2")
        if self.max_output_tokens <= 0:
            raise ValueError("max_output_tokens must be > 0")
        if self.retry_attempts <= 0:
            raise ValueError("retry_attempts must be > 0")
        if self.retry_backoff_seconds <= 0:
            raise ValueError("retry_backoff_seconds must be > 0")
        if not str(self.gateway_api_key_env).strip():
            raise ValueError("gateway_api_key_env must be non-empty")
        if not str(self.gateway_base_url_env).strip():
            raise ValueError("gateway_base_url_env must be non-empty")
        if not str(self.gateway_model_env).strip():
            raise ValueError("gateway_model_env must be non-empty")

    # --- Gateway accessors -------------------------------------------------
    def get_gateway_key(self) -> str:
        value = os.getenv(self.gateway_api_key_env, "").strip()
        if not value:
            raise ValueError(
                f"Environment variable {self.gateway_api_key_env} is missing or empty. "
                f"Set it in the project .env (expected format: gw_...)."
            )
        return value

    def get_gateway_base_url(self) -> str:
        value = os.getenv(self.gateway_base_url_env, "").strip()
        if not value:
            raise ValueError(
                f"Environment variable {self.gateway_base_url_env} is missing or empty. "
                f"Set it in the project .env."
            )
        # Ensure no trailing slash; OpenAI SDK appends its own path suffix.
        return value.rstrip("/")

    def get_gateway_model(self) -> str:
        value = os.getenv(self.gateway_model_env, "").strip()
        return value or self.model

    # --- Paths -------------------------------------------------------------
    @property
    def documents_path(self) -> Path:
        return Path(self.documents_dir)

    @property
    def output_path(self) -> Path:
        return Path(self.output_dir)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    _load_env_file()
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError("config.yaml must contain a top-level mapping")
    return AppConfig.from_dict(raw)
