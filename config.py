import os
import secrets
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    api_key: str = field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY", "").strip())
    model: str = field(default_factory=lambda: os.environ.get("CLAUDE_MODEL", "claude-opus-4-7").strip())
    effort: str = field(default_factory=lambda: os.environ.get("CLAUDE_EFFORT", "high").strip())
    max_tokens: int = field(default_factory=lambda: _int("CLAUDE_MAX_TOKENS", 16000))
    max_upload_mb: int = field(default_factory=lambda: _int("MAX_UPLOAD_MB", 25))
    rate_limit_per_min: int = field(default_factory=lambda: _int("RATE_LIMIT_PER_MIN", 20))

    enable_web_search: bool = field(default_factory=lambda: _bool("ENABLE_WEB_SEARCH"))
    enable_web_fetch: bool = field(default_factory=lambda: _bool("ENABLE_WEB_FETCH"))
    enable_code_execution: bool = field(default_factory=lambda: _bool("ENABLE_CODE_EXECUTION"))
    enable_file_upload: bool = field(default_factory=lambda: _bool("ENABLE_FILE_UPLOAD"))
    enable_thinking: bool = field(default_factory=lambda: _bool("ENABLE_THINKING"))
    enable_prompt_caching: bool = field(default_factory=lambda: _bool("ENABLE_PROMPT_CACHING"))

    flask_secret: str = field(
        default_factory=lambda: os.environ.get("FLASK_SECRET_KEY") or secrets.token_urlsafe(32)
    )
    flask_debug: bool = field(default_factory=lambda: _bool("FLASK_DEBUG", False))

    @property
    def is_ready(self) -> bool:
        return bool(self.api_key)

    def public(self) -> dict:
        return {
            "ready": self.is_ready,
            "model": self.model,
            "effort": self.effort,
            "max_upload_mb": self.max_upload_mb,
            "features": {
                "web_search": self.enable_web_search,
                "web_fetch": self.enable_web_fetch,
                "code_execution": self.enable_code_execution,
                "file_upload": self.enable_file_upload,
                "thinking": self.enable_thinking,
                "prompt_caching": self.enable_prompt_caching,
            },
        }


config = Config()
