# AI‑чат «THE ANTS» — полное описание

> Документация по AI‑ассистенту, встроенному в сайт **THE ANTS** на базе
> **Claude Opus 4.7**. Всё включено «из коробки»: единственная обязательная
> настройка — `ANTHROPIC_API_KEY` в `.env`. Остальные параметры имеют
> продакшн‑дефолты.

---

## Оглавление

1. [Быстрый старт](#быстрый-старт)
2. [Архитектура](#архитектура)
3. [Конфигурация](#конфигурация)
4. [Возможности AI](#возможности-ai)
5. [Backend](#backend)
6. [Frontend](#frontend)
7. [Структура файлов](#структура-файлов)
8. [Безопасность](#безопасность)
9. [Верификация](#верификация)
10. [Что сознательно не реализовано](#что-сознательно-не-реализовано)

---

## Быстрый старт

```bash
# 1. Установить зависимости
pip install -r requirements.txt

# 2. Скопировать пример и вписать ключ
cp .env.example .env
#  → ANTHROPIC_API_KEY=sk-ant-...

# 3. Запустить
python app.py
#  → http://127.0.0.1:5000/chat
```

Если `ANTHROPIC_API_KEY` пуст — страница `/chat` показывает
дружелюбную заглушку «Модель пока не подключена», сайт не падает.

---

## Архитектура

```
Браузер (/chat)
  ├── HTML/CSS/JS чат‑UI
  ├── localStorage — история тредов (ephemeral, без БД)
  └── fetch POST /api/chat/stream  →  Server‑Sent Events
        │
Flask backend (app.py + chat.py blueprint)
  ├── GET  /chat                → render templates/chat.html
  ├── GET  /api/chat/config     → публичные настройки модели и фич
  ├── POST /api/chat/upload     → Anthropic Files API (возвращает file_id)
  └── POST /api/chat/stream     → SSE прокси к client.messages.stream(...)
        │
Anthropic SDK (anthropic ≥ 0.92)
  └── Claude Opus 4.7
      • adaptive thinking (display: summarized)
      • output_config.effort = high
      • prompt caching на системном промпте
      • tools: web_search, web_fetch, code_execution
      • vision + document через file_id
```

**Ключ API никогда не попадает в браузер.** Фронт шлёт только сообщения
и идентификаторы файлов; backend добавляет системный промпт, tools,
thinking, caching и проксирует стрим.

---

## Конфигурация

Всё управление чатом — через `.env`. Пример (`.env.example`) уже в
репозитории.

| Переменная | Обязательно | По умолчанию | Описание |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Да** | — | Ключ Anthropic. [console.anthropic.com](https://console.anthropic.com/) |
| `CLAUDE_MODEL` | нет | `claude-opus-4-7` | Модель: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| `CLAUDE_EFFORT` | нет | `high` | Глубина размышлений: `low`/`medium`/`high`/`xhigh`/`max` |
| `CLAUDE_MAX_TOKENS` | нет | `16000` | Максимум токенов на ответ |
| `MAX_UPLOAD_MB` | нет | `25` | Лимит размера файла |
| `RATE_LIMIT_PER_MIN` | нет | `20` | Запросов в минуту на IP |
| `FLASK_SECRET_KEY` | нет | auto | Секрет Flask (если пусто — сгенерируется) |
| `FLASK_DEBUG` | нет | `0` | Режим отладки |
| `ENABLE_WEB_SEARCH` | нет | `1` | Веб‑поиск |
| `ENABLE_WEB_FETCH` | нет | `1` | Разбор URL |
| `ENABLE_CODE_EXECUTION` | нет | `1` | Песочница Python |
| `ENABLE_FILE_UPLOAD` | нет | `1` | Загрузка файлов |
| `ENABLE_THINKING` | нет | `1` | Adaptive thinking |
| `ENABLE_PROMPT_CACHING` | нет | `1` | Кэш системного промпта |

---

## Возможности AI

### Серверные инструменты Anthropic

| Инструмент | Type | Что делает |
|---|---|---|
| **Web search** | `web_search_20260209` | Актуальные данные из интернета + цитаты‑источники |
| **Web fetch** | `web_fetch_20260209` | Скачивание и анализ конкретной страницы |
| **Code execution** | `code_execution_20260120` | Python‑песочница: расчёты, `pandas`, `matplotlib`, обработка CSV/PDF, генерация графиков |

### Мультимодальность

- **Vision** — PNG, JPEG, WebP, GIF. Отправляется как
  `{type: "image", source: {type: "file", file_id}}`.
- **Документы** — PDF, TXT, Markdown, CSV, JSON, DOCX, XLSX, PPTX.
  Отправляются как `{type: "document", source: {type: "file", file_id}}`.

### Умные дефолты

- **Adaptive thinking** — Claude сам решает, когда и насколько глубоко
  думать. Для Opus 4.7 добавляется `display: "summarized"`, чтобы
  пользователь видел краткое изложение рассуждений.
- **Prompt caching** — системный промпт помечен
  `cache_control: {type: "ephemeral"}`, повторные запросы дешевле на
  ~90%. В логах SDK виден `cache_read_input_tokens > 0`.
- **Streaming** — `client.messages.stream(...)` с разбором событий в
  реальном времени. Нет таймаутов на длинных ответах.
- **Exponential backoff** — SDK сам ретраит 429/5xx; мы не дублируем.

### Системный промпт (русский, кэшируется)

> Ты — AI‑ассистент компании THE ANTS. Отвечаешь на русском языке,
> чётко и по делу, с разметкой Markdown. Используй `web_search` для
> свежей информации и цитируй источники. Используй `web_fetch` для
> анализа конкретных URL. Для вычислений и графиков — `code_execution`.
> Если пользователь прикрепил изображение или документ — внимательно
> изучи его перед ответом. Если вопрос двусмысленный — уточни.

---

## Backend

### `config.py`

`@dataclass(frozen=True) Config` — читает env через `python-dotenv`,
отдаёт `config.public()` для фронта и `config.is_ready` для guard‑ов.

### `chat.py` — Flask Blueprint

| Route | Method | Назначение |
|---|---|---|
| `/chat` | GET | Рендер страницы `chat.html` |
| `/api/chat/config` | GET | JSON c моделью, фичами и лимитами |
| `/api/chat/upload` | POST | Multipart → Anthropic Files API → `file_id` |
| `/api/chat/stream` | POST | SSE‑стрим ответа Claude |

**Контракт `/api/chat/stream` (вход):**

```json
{
  "messages": [
    {"role": "user", "content": "Привет"},
    {"role": "assistant", "content": "..."},
    {"role": "user", "content": "Следующий вопрос"}
  ],
  "attachments": [
    {"file_id": "file_...", "kind": "image", "filename": "foto.png"}
  ]
}
```

**Выход — Server‑Sent Events (`text/event-stream`):**

| Кадр | Когда |
|---|---|
| `{type: "start", model}` | Начало запроса |
| `{type: "thinking_start"}` | Начался блок thinking |
| `{type: "thinking_delta", text}` | Чанк thinking (Opus 4.7 summarized) |
| `{type: "text_start"}` | Начался видимый ответ |
| `{type: "text_delta", text}` | Чанк текста |
| `{type: "tool_use", name, input}` | Вызов server tool |
| `{type: "citation", title, url, cited_text}` | Источник из web_search |
| `{type: "block_stop"}` | Конец блока |
| `{type: "done", stop_reason, usage}` | Финал + статистика токенов |
| `{type: "error", message, retry_after?}` | Ошибка |

**Обработка ошибок (типизированные исключения SDK):**

| Исключение | Поведение |
|---|---|
| `AuthenticationError` | SSE error «Ключ недействителен» |
| `RateLimitError` | SSE error + `retry_after` из заголовка |
| `APIConnectionError` | SSE error «Нет связи с API» |
| `BadRequestError` | SSE error с message от API |
| `APIError` (остальное) | SSE error с message от API |

**Rate limiting** — in‑memory `deque` timestamps по IP, окно 60 сек,
дефолт 20 RPM.

**Упрощённый вызов SDK:**

```python
with client.messages.stream(
    model=cfg.model,
    max_tokens=cfg.max_tokens,
    system=[{
        "type": "text",
        "text": SYSTEM_PROMPT_RU,
        "cache_control": {"type": "ephemeral"},
    }],
    thinking={"type": "adaptive", "display": "summarized"},  # Opus 4.7
    output_config={"effort": "high"},
    tools=[
        {"type": "web_search_20260209", "name": "web_search"},
        {"type": "web_fetch_20260209", "name": "web_fetch"},
        {"type": "code_execution_20260120", "name": "code_execution"},
    ],
    messages=messages,
    betas=["files-api-2025-04-14"],
) as stream:
    for event in stream:
        yield translate_to_sse(event)
```

### Правки `app.py`

- `app.secret_key = config.flask_secret` (вместо хардкода)
- `app.config["MAX_CONTENT_LENGTH"]` задаёт Flask‑лимит загрузки
- `app.register_blueprint(chat_bp)`
- `app.run(debug=config.flask_debug)` — из env, не хардкод

---

## Frontend

### `templates/chat.html`

Наследует `base.html`. Структура:

- **Sidebar**: кнопка «Новый чат», список тредов из localStorage,
  бейдж с именем модели + зелёный/красный индикатор готовности,
  список включённых фич.
- **Main**: welcome‑экран с 4 подсказками (новости, статистика,
  разбор URL, креатив) → превращается в историю сообщений.
- **Composer**: textarea с auto‑resize, кнопка `📎`, «Отправить» /
  «Стоп», чипы с прикреплёнными файлами, подсказка по клавишам.

### `static/css/chat.css`

Использует существующие CSS‑переменные (`--primary #e63946`, `--dark
#1d3557`, `--radius`, `--shadow`). Ключевые компоненты:

- `.chat-grid` — CSS Grid 260px + fr
- `.msg.user` / `.msg.assistant` / `.msg.thinking` / `.msg.error` —
  четыре типа пузырей
- `.tool-call` — жёлтый чип для server‑tool активности
- `.citations` — пунктирная линия + список источников
- `.ant-spinner` — круговой индикатор (ant = муравей, тематика сайта)
- `@keyframes msg-in` — плавное появление сообщений
- `@media (max-width: 768px)` — sidebar уезжает вниз, пузыри ~92%

### `static/js/chat.js` (без фреймворков, vanilla)

| Модуль | Что делает |
|---|---|
| `state` | `{threadId, messages, attachments, streaming, controller}` |
| `loadThreads/saveThreads` | Синк с `localStorage`, лимит 50 тредов |
| `renderMarkdown(src)` | Безопасный рендер: ````код````, `**bold**`, `*italic*`, `[link](url)`, списки, заголовки `#`…`###`. Пользовательский текст **никогда** не попадает в `innerHTML` без экранирования |
| `appendMessage(msg)` | Создаёт пузырь с Markdown, вложениями, цитатами |
| `uploadFile(file)` | POST `/api/chat/upload`, чип‑placeholder → финальный чип |
| `send()` | POST `/api/chat/stream`, чтение `ReadableStream` через `TextDecoderStream`, парсинг `data:` кадров |
| `handleEvent(ev)` | Диспатч по `ev.type` из SSE‑контракта |
| `autosize()` | Textarea растёт от 1 до 8 строк |
| `setStreaming(v)` | Переключение `Send`/`Stop`, блокировка ввода |
| `stopStream()` | `AbortController.abort()` |

**Клавиатура:**

- **Enter** — отправить
- **Shift+Enter** — новая строка
- **Esc** — остановить стрим

**Навигация в `templates/base.html`:**

```html
<li>
  <a href="{{ url_for('chat.index') }}"
     class="{% if request.endpoint and request.endpoint.startswith('chat.') %}active{% endif %}">
    AI Чат
  </a>
</li>
```

---

## Структура файлов

### Созданы

```
.env.example                # шаблон настроек (ключ + флаги)
.gitignore                  # .env, venv, __pycache__ и т.д.
config.py                   # типизированный env‑loader
chat.py                     # Flask Blueprint (роуты + SSE + upload)
templates/chat.html         # страница /chat
static/css/chat.css         # стили чата в фирменной палитре
static/js/chat.js           # SPA‑логика
```

### Изменены

```
app.py                      # load_dotenv, secret из env, register_blueprint
requirements.txt            # + anthropic>=0.92.0, + python-dotenv>=1.0.1
templates/base.html         # пункт «AI Чат» + подключение chat.css
```

### Не тронуты

```
templates/index.html        # /    — главная
templates/about.html        # /about
templates/contact.html      # /contact
static/css/style.css        # базовые стили сайта
static/js/main.js           # меню + auto‑hide flash
```

---

## Безопасность

- 🔐 **API‑ключ только на сервере** — фронт общается через наш прокси.
- 🔐 **`FLASK_SECRET_KEY` из env** — хардкод
  `'the-ants-secret-key'` заменён, fallback на
  `secrets.token_urlsafe(32)`.
- 📏 **Лимит файла** — двойной: Flask `MAX_CONTENT_LENGTH` + явная
  проверка в `/api/chat/upload` (`config.max_upload_mb`, default 25 МБ).
- 🛡️ **MIME‑whitelist** — только картинки (`png/jpeg/webp/gif`) и
  документы (`pdf/txt/md/csv/json/docx/xlsx/pptx`).
- 🧼 **Безопасный Markdown** — `escapeHTML()` + ручная замена
  паттернов. Пользовательские URL экранируются, `target="_blank"
  rel="noopener noreferrer"`.
- 🚦 **Rate limit** — in‑memory `deque` timestamps по IP, защита от
  случайного RPS.
- 🙅 **Нет CORS** — всё same‑origin, CORS‑заголовков не добавляем.

---

## Верификация

### 1. Запуск

```bash
pip install -r requirements.txt
cp .env.example .env           # прописать ANTHROPIC_API_KEY
python app.py
```

Открыть `http://127.0.0.1:5000/chat`.

### 2. Ручные сценарии

| Сценарий | Ожидание |
|---|---|
| Вопрос на русском | Стриминг текста, корректный Markdown |
| «Последние новости про AI» | Плашка `🔎 Поиск в интернете`, список источников внизу ответа |
| «Разбери https://example.com» | Плашка `🌐 Загрузка страницы`, краткое резюме |
| «Посчитай среднее [1..10]» | Плашка `🐍 Выполнение кода`, численный ответ |
| Прикрепить PNG → «Что на картинке?» | Vision работает |
| Прикрепить PDF → «Перескажи кратко» | Документ обработан |
| Длинный ответ (>8k токенов) | Стрим не прерывается, thinking появляется/исчезает |
| Shift+Enter, Enter, Esc | Клавиатура работает |
| Ширина ≤768px | Sidebar уезжает вниз, пузыри на всю ширину |
| `ANTHROPIC_API_KEY=""` | `/chat` показывает заглушку, не 500 |
| Два одинаковых запроса подряд | В логах `cache_read_input_tokens > 0` |

### 3. Регрессии

- `/`, `/about`, `/contact` работают, активный пункт подсвечен
- Контактная форма флэшит те же сообщения
- Навбар везде одинаковый

---

## Что сознательно не реализовано

Не потому что невозможно, а потому что избыточно для задачи:

- ❌ **База данных и server‑side history** — хватит `localStorage`,
  пользователь сам контролирует свою историю
- ❌ **Аутентификация пользователей** — сайт публичный
- ❌ **Managed Agents / Skills** — для лендинга избыточно
- ❌ **Memory tool** — требует собственный сторедж; если появится
  кейс — добавим в следующей итерации
- ❌ **Мультиязычный UI** — сайт моноязычный (RU)
- ❌ **Custom client‑side tools** — всё нужное покрывается серверными
  тулами Anthropic

---

## Расширение в будущем

Если однажды понадобится — порядок расширения:

1. **Memory** — добавить `{type: "memory_20250818"}` в `tools`,
   реализовать `BetaAbstractMemoryTool` (Python SDK) с хранением в
   `instance/memories/`
2. **Managed Agents** — если нужны persistent сессии с GitHub/MCP:
   `client.beta.agents.create(...)` → `sessions.create(...)`
3. **Batch API** — для фонового анализа писем из формы контактов:
   `client.messages.batches.create(...)` (‑50% стоимости)
4. **Skills** — упаковка доменных знаний THE ANTS в
   `skills/*/SKILL.md`, подключение через `skills=[{type: "custom",
   skill_id: ...}]`

Все расширения укладываются в ту же архитектуру — менять фронт не
придётся.
