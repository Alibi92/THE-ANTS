(function () {
    "use strict";

    const CFG = window.CHAT_CONFIG || {};
    if (!CFG.ready) return;

    const $ = (sel) => document.querySelector(sel);

    const els = {
        messages: $("#messages"),
        form: $("#chat-form"),
        composer: $("#composer"),
        send: $("#btn-send"),
        stop: $("#btn-stop"),
        newChat: $("#btn-new-chat"),
        fileInput: $("#file-input"),
        attachments: $("#attachments"),
        thinking: $("#thinking-indicator"),
        history: $("#chat-history"),
    };

    const STORE_KEY = "theants_chat_threads_v1";
    const MAX_THREADS = 50;

    const state = {
        threadId: null,
        messages: [],
        attachments: [],
        streaming: false,
        controller: null,
        current: null,
    };

    /* ---------- Storage ---------- */

    function loadThreads() {
        try {
            return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
        } catch (_) {
            return [];
        }
    }

    function saveThreads(threads) {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(threads.slice(0, MAX_THREADS)));
        } catch (_) { /* quota or disabled */ }
    }

    function persistCurrent() {
        if (!state.threadId || state.messages.length === 0) return;
        const threads = loadThreads().filter((t) => t.id !== state.threadId);
        const firstUser = state.messages.find((m) => m.role === "user");
        const title = (firstUser?.content || "Новый чат").slice(0, 60);
        threads.unshift({
            id: state.threadId,
            title,
            messages: state.messages,
            updated: Date.now(),
        });
        saveThreads(threads);
        renderHistory();
    }

    function renderHistory() {
        const threads = loadThreads();
        els.history.innerHTML = "";
        if (threads.length === 0) {
            const li = document.createElement("li");
            li.className = "empty";
            li.textContent = "Пока пусто";
            els.history.appendChild(li);
            return;
        }
        for (const t of threads) {
            const li = document.createElement("li");
            li.textContent = t.title;
            li.title = t.title;
            if (t.id === state.threadId) li.classList.add("active");
            li.addEventListener("click", () => loadThread(t.id));
            els.history.appendChild(li);
        }
    }

    function loadThread(id) {
        const thread = loadThreads().find((t) => t.id === id);
        if (!thread) return;
        state.threadId = id;
        state.messages = thread.messages.map((m) => ({ ...m }));
        state.attachments = [];
        renderAllMessages();
        renderHistory();
        renderAttachments();
    }

    function newThread() {
        if (state.streaming) stopStream();
        state.threadId = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        state.messages = [];
        state.attachments = [];
        state.current = null;
        els.messages.innerHTML = welcomeHTML();
        renderAttachments();
        renderHistory();
        els.composer.focus();
    }

    function welcomeHTML() {
        return els._welcomeBackup || "";
    }

    /* ---------- Rendering ---------- */

    function renderAllMessages() {
        els.messages.innerHTML = "";
        for (const m of state.messages) appendMessage(m);
    }

    function appendMessage(msg) {
        const el = document.createElement("div");
        el.className = "msg " + msg.role;
        if (msg.role === "user" && msg.attachments && msg.attachments.length) {
            el.appendChild(renderMsgAttachments(msg.attachments));
        }
        const body = document.createElement("div");
        body.className = "msg-body";
        if (msg.role === "assistant") {
            body.innerHTML = renderMarkdown(msg.content || "");
        } else {
            body.textContent = msg.content || "";
        }
        el.appendChild(body);
        if (msg.citations && msg.citations.length) {
            el.appendChild(renderCitations(msg.citations));
        }
        els.messages.appendChild(el);
        scrollBottom();
        return el;
    }

    function renderMsgAttachments(atts) {
        const wrap = document.createElement("div");
        wrap.className = "msg-attachments";
        for (const a of atts) {
            if (a.kind === "image" && a.preview_url) {
                const img = document.createElement("img");
                img.src = a.preview_url;
                img.alt = a.filename || "image";
                wrap.appendChild(img);
            } else {
                const doc = document.createElement("span");
                doc.className = "doc";
                doc.textContent = "📄 " + (a.filename || "document");
                wrap.appendChild(doc);
            }
        }
        return wrap;
    }

    function renderCitations(citations) {
        const wrap = document.createElement("div");
        wrap.className = "citations";
        const title = document.createElement("div");
        title.className = "citations-title";
        title.textContent = "Источники:";
        wrap.appendChild(title);
        const seen = new Set();
        for (const c of citations) {
            if (!c.url || seen.has(c.url)) continue;
            seen.add(c.url);
            const a = document.createElement("a");
            a.className = "citation-item";
            a.href = c.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = "🔗 " + (c.title || c.url);
            wrap.appendChild(a);
        }
        return wrap;
    }

    function scrollBottom() {
        els.messages.scrollTop = els.messages.scrollHeight;
    }

    /* ---------- Markdown (safe, minimal) ---------- */

    function escapeHTML(s) {
        return s.replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    function renderMarkdown(src) {
        if (!src) return "";

        const blocks = [];
        let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            blocks.push(`<pre><code${lang ? ` class="lang-${escapeHTML(lang)}"` : ""}>${escapeHTML(code)}</code></pre>`);
            return `\u0000BLOCK${blocks.length - 1}\u0000`;
        });

        text = escapeHTML(text);

        text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
            return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        });
        text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)(?![^<]*>)/g, (_, pre, url) => {
            return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        });
        text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        text = text.replace(/(^|[\s(_])\*([^*\n]+)\*(?=$|[\s).,!?_])/g, "$1<em>$2</em>");

        const lines = text.split("\n");
        const out = [];
        let inList = null;
        for (let line of lines) {
            const ul = line.match(/^\s*[-*]\s+(.*)$/);
            const ol = line.match(/^\s*\d+\.\s+(.*)$/);
            const h = line.match(/^(#{1,3})\s+(.*)$/);

            if (ul) {
                if (inList !== "ul") { if (inList) out.push(`</${inList}>`); out.push("<ul>"); inList = "ul"; }
                out.push(`<li>${ul[1]}</li>`);
            } else if (ol) {
                if (inList !== "ol") { if (inList) out.push(`</${inList}>`); out.push("<ol>"); inList = "ol"; }
                out.push(`<li>${ol[1]}</li>`);
            } else {
                if (inList) { out.push(`</${inList}>`); inList = null; }
                if (h) {
                    const lvl = h[1].length;
                    out.push(`<h${lvl}>${h[2]}</h${lvl}>`);
                } else if (line.trim() === "") {
                    out.push("");
                } else {
                    out.push(`<p>${line}</p>`);
                }
            }
        }
        if (inList) out.push(`</${inList}>`);

        let html = out.join("\n").replace(/\n{2,}/g, "\n");
        html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
        return html;
    }

    /* ---------- Attachments ---------- */

    function renderAttachments() {
        els.attachments.innerHTML = "";
        state.attachments.forEach((a, idx) => {
            const chip = document.createElement("div");
            chip.className = "chip" + (a.uploading ? " uploading" : "");

            if (a.kind === "image" && a.preview_url) {
                const img = document.createElement("img");
                img.src = a.preview_url;
                chip.appendChild(img);
            } else {
                const icon = document.createElement("span");
                icon.className = "chip-icon";
                icon.textContent = a.kind === "image" ? "🖼️" : "📄";
                chip.appendChild(icon);
            }

            const name = document.createElement("span");
            name.className = "chip-name";
            name.textContent = a.filename;
            chip.appendChild(name);

            if (!a.uploading) {
                const rm = document.createElement("button");
                rm.type = "button";
                rm.className = "chip-remove";
                rm.innerHTML = "×";
                rm.title = "Убрать";
                rm.addEventListener("click", () => {
                    state.attachments.splice(idx, 1);
                    renderAttachments();
                    updateSendEnabled();
                });
                chip.appendChild(rm);
            }

            els.attachments.appendChild(chip);
        });
    }

    async function uploadFile(file) {
        const placeholder = {
            filename: file.name,
            kind: file.type.startsWith("image/") ? "image" : "document",
            uploading: true,
        };
        if (placeholder.kind === "image") {
            placeholder.preview_url = URL.createObjectURL(file);
        }
        state.attachments.push(placeholder);
        renderAttachments();

        const fd = new FormData();
        fd.append("file", file);
        try {
            const res = await fetch("/api/chat/upload", { method: "POST", body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Ошибка загрузки");
            Object.assign(placeholder, {
                uploading: false,
                file_id: data.file_id,
                mime_type: data.mime_type,
                size_bytes: data.size_bytes,
                kind: data.kind,
            });
            renderAttachments();
            updateSendEnabled();
        } catch (err) {
            const idx = state.attachments.indexOf(placeholder);
            if (idx >= 0) state.attachments.splice(idx, 1);
            renderAttachments();
            showError(err.message || "Не удалось загрузить файл");
        }
    }

    /* ---------- Send / stream ---------- */

    function updateSendEnabled() {
        const hasText = els.composer.value.trim().length > 0;
        const uploading = state.attachments.some((a) => a.uploading);
        els.send.disabled = state.streaming || uploading || (!hasText && state.attachments.length === 0);
    }

    async function send() {
        if (state.streaming) return;
        const text = els.composer.value.trim();
        if (!text && state.attachments.length === 0) return;

        if (!state.threadId) {
            state.threadId = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }

        const welcome = els.messages.querySelector(".chat-welcome");
        if (welcome) welcome.remove();

        const attachMeta = state.attachments
            .filter((a) => a.file_id)
            .map((a) => ({
                file_id: a.file_id,
                kind: a.kind,
                filename: a.filename,
                preview_url: a.preview_url || null,
            }));

        const userMsg = {
            role: "user",
            content: text,
            attachments: attachMeta,
        };
        state.messages.push(userMsg);
        appendMessage(userMsg);

        els.composer.value = "";
        autosize();
        state.attachments = [];
        renderAttachments();
        updateSendEnabled();

        const assistantMsg = {
            role: "assistant",
            content: "",
            citations: [],
            tools: [],
            thinking: "",
        };
        const assistantEl = appendMessage(assistantMsg);
        const bodyEl = assistantEl.querySelector(".msg-body");
        let thinkingEl = null;
        state.current = { msg: assistantMsg, el: assistantEl, body: bodyEl };

        const payload = {
            messages: state.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            attachments: attachMeta.map((a) => ({ file_id: a.file_id, kind: a.kind, filename: a.filename })),
        };

        setStreaming(true);

        try {
            state.controller = new AbortController();
            const res = await fetch("/api/chat/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: state.controller.signal,
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: "Ошибка сервера" }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            if (!res.body) throw new Error("Нет тела ответа");

            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;

                let idx;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (!frame.startsWith("data:")) continue;
                    const json = frame.slice(5).trim();
                    if (!json) continue;
                    let ev;
                    try { ev = JSON.parse(json); } catch (_) { continue; }
                    thinkingEl = handleEvent(ev, assistantMsg, bodyEl, assistantEl, thinkingEl);
                }
            }
        } catch (err) {
            if (err.name === "AbortError") {
                showInlineError(assistantEl, "Остановлено пользователем");
            } else {
                showInlineError(assistantEl, err.message || "Ошибка соединения");
            }
        } finally {
            setStreaming(false);
            if (thinkingEl) thinkingEl.remove();
            persistCurrent();
        }
    }

    function handleEvent(ev, msg, body, wrapper, thinkingEl) {
        switch (ev.type) {
            case "start":
                break;
            case "thinking_start":
                if (!thinkingEl) {
                    thinkingEl = document.createElement("div");
                    thinkingEl.className = "msg thinking";
                    thinkingEl.textContent = "";
                    els.messages.insertBefore(thinkingEl, wrapper);
                }
                els.thinking.hidden = false;
                break;
            case "thinking_delta":
                if (thinkingEl) {
                    thinkingEl.textContent += ev.text || "";
                    scrollBottom();
                }
                break;
            case "text_start":
                els.thinking.hidden = true;
                break;
            case "text_delta":
                msg.content += ev.text || "";
                body.innerHTML = renderMarkdown(msg.content);
                scrollBottom();
                break;
            case "tool_use": {
                const chip = document.createElement("span");
                chip.className = "tool-call";
                chip.textContent = toolLabel(ev.name);
                body.appendChild(chip);
                msg.tools.push({ name: ev.name });
                scrollBottom();
                break;
            }
            case "tool_result":
                break;
            case "citation":
                if (ev.url) {
                    msg.citations.push({ title: ev.title, url: ev.url });
                }
                break;
            case "block_stop":
                break;
            case "done": {
                if (msg.citations.length) {
                    wrapper.appendChild(renderCitations(msg.citations));
                }
                els.thinking.hidden = true;
                if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
                break;
            }
            case "error":
                showInlineError(wrapper, ev.message || "Ошибка");
                if (ev.retry_after) {
                    showInlineError(wrapper, `Попробуйте через ${ev.retry_after} с`);
                }
                break;
        }
        return thinkingEl;
    }

    function toolLabel(name) {
        const map = {
            web_search: "🔎 Поиск в интернете",
            web_fetch: "🌐 Загрузка страницы",
            code_execution: "🐍 Выполнение кода",
        };
        return map[name] || `🔧 ${name}`;
    }

    function showInlineError(wrapperEl, text) {
        const err = document.createElement("div");
        err.className = "msg error";
        err.textContent = text;
        wrapperEl.insertAdjacentElement("afterend", err);
        scrollBottom();
    }

    function showError(text) {
        const err = document.createElement("div");
        err.className = "msg error";
        err.textContent = text;
        els.messages.appendChild(err);
        scrollBottom();
    }

    function setStreaming(v) {
        state.streaming = v;
        els.send.hidden = v;
        els.stop.hidden = !v;
        els.composer.disabled = false;
        updateSendEnabled();
    }

    function stopStream() {
        if (state.controller) state.controller.abort();
    }

    /* ---------- Composer ---------- */

    function autosize() {
        els.composer.style.height = "auto";
        els.composer.style.height = Math.min(els.composer.scrollHeight, 200) + "px";
    }

    /* ---------- Init ---------- */

    function init() {
        els._welcomeBackup = els.messages.innerHTML;
        renderHistory();

        els.form.addEventListener("submit", (e) => {
            e.preventDefault();
            send();
        });

        els.composer.addEventListener("input", () => {
            autosize();
            updateSendEnabled();
        });

        els.composer.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!els.send.disabled) send();
            } else if (e.key === "Escape" && state.streaming) {
                e.preventDefault();
                stopStream();
            }
        });

        els.stop.addEventListener("click", stopStream);
        els.newChat.addEventListener("click", newThread);

        els.fileInput.addEventListener("change", async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            const maxBytes = (CFG.max_upload_mb || 25) * 1024 * 1024;
            for (const f of files) {
                if (f.size > maxBytes) {
                    showError(`Файл "${f.name}" больше ${CFG.max_upload_mb || 25} МБ`);
                    continue;
                }
                uploadFile(f);
            }
        });

        document.querySelectorAll(".suggestion").forEach((btn) => {
            btn.addEventListener("click", () => {
                els.composer.value = btn.dataset.prompt || btn.textContent;
                autosize();
                updateSendEnabled();
                els.composer.focus();
            });
        });

        updateSendEnabled();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
