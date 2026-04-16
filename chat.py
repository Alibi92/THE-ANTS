import json
import logging
import time
from collections import defaultdict, deque
from threading import Lock

from flask import Blueprint, Response, jsonify, render_template, request, stream_with_context

import anthropic

from config import config

log = logging.getLogger(__name__)

chat_bp = Blueprint("chat", __name__)

SYSTEM_PROMPT_RU = (
    "Ты — AI-ассистент компании THE ANTS. Отвечаешь на русском языке, "
    "чётко и по делу, с разметкой Markdown (жирный, списки, заголовки, код). "
    "Используй web_search для свежей информации и цитируй источники. "
    "Используй web_fetch для анализа конкретных URL. "
    "Для вычислений, обработки данных и построения графиков используй code_execution. "
    "Если пользователь прикрепил изображение или документ — внимательно изучи его перед ответом. "
    "Если вопрос двусмысленный — уточни, прежде чем отвечать."
)

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}
ALLOWED_DOC_TYPES = {
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

_rate_buckets: dict = defaultdict(lambda: deque(maxlen=1024))
_rate_lock = Lock()


def _client() -> anthropic.Anthropic:
    if not config.is_ready:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    return anthropic.Anthropic(api_key=config.api_key)


def _rate_limited(ip: str) -> bool:
    now = time.time()
    window = 60.0
    with _rate_lock:
        bucket = _rate_buckets[ip]
        while bucket and bucket[0] < now - window:
            bucket.popleft()
        if len(bucket) >= config.rate_limit_per_min:
            return True
        bucket.append(now)
    return False


def _build_tools() -> list:
    tools = []
    if config.enable_web_search:
        tools.append({"type": "web_search_20260209", "name": "web_search"})
    if config.enable_web_fetch:
        tools.append({"type": "web_fetch_20260209", "name": "web_fetch"})
    if config.enable_code_execution:
        tools.append({"type": "code_execution_20260120", "name": "code_execution"})
    return tools


def _build_thinking() -> dict | None:
    if not config.enable_thinking:
        return None
    thinking = {"type": "adaptive"}
    if config.model.startswith("claude-opus-4-7"):
        thinking["display"] = "summarized"
    return thinking


def _build_system() -> list | str:
    if config.enable_prompt_caching:
        return [
            {
                "type": "text",
                "text": SYSTEM_PROMPT_RU,
                "cache_control": {"type": "ephemeral"},
            }
        ]
    return SYSTEM_PROMPT_RU


def _kind_for_mime(mime: str) -> str | None:
    if mime in ALLOWED_IMAGE_TYPES:
        return "image"
    if mime in ALLOWED_DOC_TYPES:
        return "document"
    return None


def _normalize_messages(raw_messages: list, attachments: list) -> list:
    """Convert frontend messages to Anthropic content blocks.

    Frontend sends: [{"role": "user"|"assistant", "content": "text"}, ...]
    Attachments belong to the last user message.
    """
    messages = []
    for m in raw_messages:
        role = m.get("role")
        content = m.get("content", "")
        if role not in ("user", "assistant"):
            continue
        if isinstance(content, str):
            blocks = [{"type": "text", "text": content}] if content else []
        elif isinstance(content, list):
            blocks = content
        else:
            blocks = []
        messages.append({"role": role, "content": blocks})

    if attachments and messages and messages[-1]["role"] == "user":
        attach_blocks = []
        for att in attachments:
            file_id = att.get("file_id")
            kind = att.get("kind")
            if not file_id or kind not in ("image", "document"):
                continue
            if kind == "image":
                attach_blocks.append({
                    "type": "image",
                    "source": {"type": "file", "file_id": file_id},
                })
            else:
                block = {
                    "type": "document",
                    "source": {"type": "file", "file_id": file_id},
                }
                if att.get("filename"):
                    block["title"] = att["filename"]
                attach_blocks.append(block)
        messages[-1]["content"] = attach_blocks + messages[-1]["content"]

    return messages


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@chat_bp.get("/chat")
def index():
    return render_template("chat.html", cfg=config.public())


@chat_bp.get("/api/chat/config")
def api_config():
    return jsonify(config.public())


@chat_bp.post("/api/chat/upload")
def api_upload():
    if not config.is_ready:
        return jsonify({"error": "Модель не настроена"}), 503
    if not config.enable_file_upload:
        return jsonify({"error": "Загрузка файлов отключена"}), 403

    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "Файл не получен"}), 400

    mime = (file.mimetype or "").lower()
    kind = _kind_for_mime(mime)
    if not kind:
        return jsonify({"error": f"Неподдерживаемый тип файла: {mime or 'unknown'}"}), 415

    data = file.read()
    max_bytes = config.max_upload_mb * 1024 * 1024
    if len(data) > max_bytes:
        return jsonify({"error": f"Файл больше {config.max_upload_mb} МБ"}), 413
    if len(data) == 0:
        return jsonify({"error": "Файл пустой"}), 400

    try:
        client = _client()
        uploaded = client.beta.files.upload(
            file=(file.filename, data, mime),
        )
    except anthropic.APIError as exc:
        log.exception("File upload to Anthropic failed")
        return jsonify({"error": f"Ошибка загрузки: {exc.message if hasattr(exc, 'message') else str(exc)}"}), 502

    return jsonify({
        "file_id": uploaded.id,
        "filename": file.filename,
        "mime_type": mime,
        "size_bytes": len(data),
        "kind": kind,
    })


@chat_bp.post("/api/chat/stream")
def api_stream():
    if not config.is_ready:
        return jsonify({"error": "Модель не настроена. Администратору нужно задать ANTHROPIC_API_KEY."}), 503

    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    if _rate_limited(ip):
        return jsonify({"error": "Слишком много запросов. Подождите минуту."}), 429

    payload = request.get_json(silent=True) or {}
    raw_messages = payload.get("messages") or []
    attachments = payload.get("attachments") or []

    if not raw_messages:
        return jsonify({"error": "Пустой список сообщений"}), 400

    messages = _normalize_messages(raw_messages, attachments)
    if not messages or messages[-1]["role"] != "user":
        return jsonify({"error": "Последнее сообщение должно быть от пользователя"}), 400

    tools = _build_tools()
    thinking = _build_thinking()
    system = _build_system()

    stream_kwargs = {
        "model": config.model,
        "max_tokens": config.max_tokens,
        "system": system,
        "messages": messages,
        "output_config": {"effort": config.effort},
    }
    if tools:
        stream_kwargs["tools"] = tools
    if thinking:
        stream_kwargs["thinking"] = thinking
    if any(att.get("kind") in ("image", "document") for att in attachments):
        stream_kwargs["betas"] = ["files-api-2025-04-14"]

    @stream_with_context
    def generate():
        try:
            client = _client()
            yield _sse({"type": "start", "model": config.model})

            with client.messages.stream(**stream_kwargs) as stream:
                for event in stream:
                    frame = _translate_event(event)
                    if frame is not None:
                        yield _sse(frame)

                final = stream.get_final_message()
                yield _sse({
                    "type": "done",
                    "stop_reason": final.stop_reason,
                    "usage": {
                        "input_tokens": final.usage.input_tokens,
                        "output_tokens": final.usage.output_tokens,
                        "cache_creation_input_tokens": getattr(final.usage, "cache_creation_input_tokens", 0) or 0,
                        "cache_read_input_tokens": getattr(final.usage, "cache_read_input_tokens", 0) or 0,
                    },
                })

        except anthropic.AuthenticationError:
            log.exception("Anthropic auth error")
            yield _sse({"type": "error", "message": "Ключ API недействителен. Проверьте ANTHROPIC_API_KEY."})
        except anthropic.RateLimitError as exc:
            retry = 60
            if hasattr(exc, "response") and exc.response is not None:
                try:
                    retry = int(exc.response.headers.get("retry-after", "60"))
                except (TypeError, ValueError):
                    retry = 60
            yield _sse({"type": "error", "message": "Сервер перегружен, попробуйте позже.", "retry_after": retry})
        except anthropic.APIConnectionError:
            log.exception("Anthropic connection error")
            yield _sse({"type": "error", "message": "Не удалось подключиться к API. Проверьте интернет."})
        except anthropic.BadRequestError as exc:
            log.exception("Anthropic bad request")
            yield _sse({"type": "error", "message": f"Некорректный запрос: {exc.message if hasattr(exc, 'message') else str(exc)}"})
        except anthropic.APIError as exc:
            log.exception("Anthropic API error")
            yield _sse({"type": "error", "message": f"Ошибка API: {exc.message if hasattr(exc, 'message') else str(exc)}"})
        except Exception as exc:
            log.exception("Unexpected chat stream error")
            yield _sse({"type": "error", "message": f"Внутренняя ошибка: {exc}"})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _translate_event(event) -> dict | None:
    """Map anthropic SDK stream events to compact SSE frames for the frontend."""
    et = getattr(event, "type", None)

    if et == "content_block_start":
        block = getattr(event, "content_block", None)
        bt = getattr(block, "type", None)
        if bt == "thinking":
            return {"type": "thinking_start"}
        if bt == "text":
            return {"type": "text_start"}
        if bt == "server_tool_use":
            return {
                "type": "tool_use",
                "name": getattr(block, "name", "tool"),
                "input": getattr(block, "input", None),
            }
        if bt and bt.endswith("_tool_result"):
            return {
                "type": "tool_result",
                "name": bt.replace("_tool_result", ""),
                "summary": _summarize_tool_result(block),
            }
        return None

    if et == "content_block_delta":
        delta = getattr(event, "delta", None)
        dt = getattr(delta, "type", None)
        if dt == "text_delta":
            return {"type": "text_delta", "text": getattr(delta, "text", "")}
        if dt == "thinking_delta":
            return {"type": "thinking_delta", "text": getattr(delta, "thinking", "")}
        if dt == "citations_delta":
            cit = getattr(delta, "citation", None)
            return {
                "type": "citation",
                "title": getattr(cit, "title", None),
                "url": getattr(cit, "url", None),
                "cited_text": getattr(cit, "cited_text", None),
            }
        return None

    if et == "content_block_stop":
        return {"type": "block_stop"}

    if et == "message_stop":
        return None

    return None


def _summarize_tool_result(block) -> str:
    content = getattr(block, "content", None)
    if content is None:
        return ""
    if isinstance(content, str):
        return content[:200]
    try:
        return json.dumps(content, ensure_ascii=False, default=str)[:200]
    except Exception:
        return str(content)[:200]
