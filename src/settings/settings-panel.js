import { LanguageDetect } from "../shared/language-detect.js";
import { PluginLog } from "../shared/pluginlog.js";
import { createStatusSetter } from "../shared/status.js";

let settingsTimer = null;

const setStatus = createStatusSetter("status");

const ENGINE_HINTS = {
    bergamot: "Offline translation via WebAssembly — no server needed",
    libre: "Requires a running LibreTranslate server",
    ai: "Uses the AI endpoint configured below for every translation",
};

// --- Engine / section visibility ---

function updateEngineSections() {
    const engine = document.getElementById("translation-engine").value;
    document.getElementById("section-bergamot").style.display =
        engine === "bergamot" ? "" : "none";
    document.getElementById("section-libre").style.display =
        engine === "libre" ? "" : "none";
    const hint = document.getElementById("engine-hint");
    if (hint) hint.textContent = ENGINE_HINTS[engine] || "";
    updateAiSection();
}

function updateAiSection() {
    const engine = document.getElementById("translation-engine").value;
    const enabled = document.getElementById("ai-enabled").checked;
    // AI config is mandatory when AI is the translation engine, and optional
    // when AI is only refining another engine's output.
    document.getElementById("section-ai-config").style.display =
        enabled || engine === "ai" ? "" : "none";
}

function applyDebugVisibility(enabled) {
    const panel = document.getElementById("log-panel");
    if (panel) panel.style.display = enabled ? "" : "none";
}

// --- Read / Apply settings (declarative field map keeps both directions in sync) ---

const FIELD_MAP = [
    { key: "translationEngine", id: "translation-engine", guard: "truthy" },
    {
        key: "bergamotQuality",
        radio: "bergamot-quality",
        fallback: "base-memory",
        guard: "truthy",
    },
    { key: "libreTranslateUrl", id: "libre-url", type: "url", guard: "truthy" },
    {
        key: "targetLangs",
        id: "target-langs",
        type: "langSingle",
        guard: "truthy",
    },
    { key: "scope", radio: "scope", fallback: "sheet", guard: "truthy" },
    {
        key: "translateShapes",
        id: "translate-shapes",
        type: "checkbox",
        guard: "defined",
    },
    {
        key: "displayMode",
        radio: "display-mode",
        fallback: "preview",
        guard: "truthy",
    },
    {
        key: "autoCommit",
        id: "auto-commit",
        type: "checkbox",
        guard: "defined",
    },
    {
        key: "concurrentConnections",
        id: "concurrent-connections",
        type: "number",
        fallback: 5,
        guard: "defined",
    },
    { key: "aiEnabled", id: "ai-enabled", type: "checkbox", guard: "defined" },
    {
        key: "debugEnabled",
        id: "debug-enabled",
        type: "checkbox",
        guard: "defined",
    },
    { key: "aiEndpoint", id: "ai-endpoint", type: "url", guard: "defined" },
    { key: "aiApiKey", id: "ai-api-key", guard: "defined" },
    { key: "aiModel", id: "ai-model", type: "modelSelect", guard: "truthy" },
];

function readField(field) {
    if (field.radio) {
        const radios = document.querySelectorAll(
            `input[name="${field.radio}"]`,
        );
        for (const r of radios) {
            if (r.checked) return r.value;
        }
        return field.fallback;
    }
    const el = document.getElementById(field.id);
    switch (field.type) {
        case "checkbox":
            return el.checked;
        case "number":
            return Number.parseInt(el.value, 10) || field.fallback;
        case "url":
            return el.value.replace(/\/+$/, "");
        case "langSingle":
            return [el.value || "en"];
        case "modelSelect":
            return el.value || "";
        default:
            return el.value;
    }
}

function applyField(field, settings) {
    const value = settings[field.key];
    const guardPasses =
        field.guard === "defined" ? value !== undefined : !!value;
    if (!guardPasses) return;

    if (field.radio) {
        const radios = document.querySelectorAll(
            `input[name="${field.radio}"]`,
        );
        for (const r of radios) r.checked = r.value === value;
        return;
    }

    const el = document.getElementById(field.id);
    switch (field.type) {
        case "checkbox":
            el.checked = value;
            break;
        case "langSingle":
            el.value = value[0] || "en";
            break;
        case "modelSelect": {
            let found = false;
            for (let i = 0; i < el.options.length; i++) {
                if (el.options[i].value === value) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement("option");
                opt.value = value;
                opt.textContent = value;
                el.insertBefore(opt, el.firstChild);
            }
            el.value = value;
            break;
        }
        default:
            el.value = value;
    }
}

function readFromUI() {
    const result = {};
    for (const field of FIELD_MAP) {
        result[field.key] = readField(field);
    }
    return result;
}

function applyToUI(settings) {
    for (const field of FIELD_MAP) {
        applyField(field, settings);
    }
    applyDebugVisibility(settings.debugEnabled);
    updateEngineSections();
    updateAiSection();
}

// --- Model list rendering ---

function renderModelList(cachedModels) {
    const container = document.getElementById("model-list");
    if (!cachedModels || cachedModels.length === 0) {
        container.innerHTML =
            '<div class="model-empty">No models cached yet. Models download automatically on first use.</div>';
        document.getElementById("cache-total-size").textContent = "0 MB";
        return;
    }

    // Group by language pair (extract from URL path)
    const pairs = {};
    let totalBytes = 0;
    for (const m of cachedModels) {
        totalBytes += m.byteLength;
        // URL like: .../models/ja-en/.../model.jaen.intgemm.alphas.bin.gz
        const match = m.key.match(/\/models\/([a-z_]+-[a-z_]+)\//);
        if (match) {
            const pair = match[1];
            if (!pairs[pair]) pairs[pair] = { files: [], totalSize: 0 };
            pairs[pair].files.push(m);
            pairs[pair].totalSize += m.byteLength;
        }
    }

    let html = "";
    for (const [pair, data] of Object.entries(pairs).sort()) {
        const [from, to] = pair.split("-");
        const sizeMB = (data.totalSize / 1048576).toFixed(1);
        html += '<div class="model-row">';
        html += `<span class="model-pair">${from} → ${to}</span>`;
        html += `<span class="model-status cached">● ${sizeMB} MB</span>`;
        html += `<button class="model-btn delete" data-pair="${pair}" title="Remove from cache">✕</button>`;
        html += "</div>";
    }
    container.innerHTML = html;
    document.getElementById("cache-total-size").textContent =
        `${(totalBytes / 1048576).toFixed(1)} MB`;

    // Attach delete handlers
    for (const btn of container.querySelectorAll(".model-btn.delete")) {
        btn.addEventListener("click", () => {
            const pair = btn.dataset.pair;
            // Find all cache keys for this pair
            const keysToDelete = cachedModels
                .filter((m) => m.key.indexOf(`/models/${pair}/`) !== -1)
                .map((m) => m.key);
            for (const key of keysToDelete) {
                window.Asc.plugin.sendToPlugin("onDeleteModelCache", {
                    key: key,
                });
            }
        });
    }
}

const langName = LanguageDetect.langName;

function populateLanguageDropdowns(available) {
    if (!available?.languages) return;
    const langs = available.languages;

    // Populate all language selects (target, add-model-from, add-model-to)
    const ids = ["target-langs", "add-model-from", "add-model-to"];
    for (const id of ids) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        const current = sel.value;
        sel.innerHTML = "";
        for (const code of langs) {
            const opt = document.createElement("option");
            opt.value = code;
            opt.textContent = langName(code);
            sel.appendChild(opt);
        }
        // Restore previous selection if still valid
        if (langs.includes(current)) sel.value = current;
    }
}

function renderDbStats(stats) {
    const rows = stats.rows || 0;
    document.getElementById("db-rows").textContent =
        `${rows} / 1,048,576 (${((rows / 1048576) * 100).toFixed(2)}%)`;
    document.getElementById("db-max-history").textContent =
        `${stats.maxHistory || 0} entries`;
    document.getElementById("db-active").textContent = stats.active || 0;
}

// --- Fetch AI models ---

function fetchModels() {
    const endpoint = document
        .getElementById("ai-endpoint")
        .value.replace(/\/+$/, "");
    const apiKey = document.getElementById("ai-api-key").value;
    if (!endpoint) {
        setStatus("Enter an AI endpoint first", "error");
        return;
    }
    const btn = document.getElementById("btn-fetch-models");
    btn.disabled = true;
    btn.textContent = "…";
    setStatus("Fetching models…", "");
    window.Asc.plugin.sendToPlugin("onFetchModels", {
        endpoint: endpoint,
        apiKey: apiKey,
    });
}

// --- Receive messages from background ---

window.Asc.plugin.attachEvent("onLog", (data) => {
    PluginLog.log(data.key || "BG", data.message || "");
});

window.Asc.plugin.attachEvent("onModelsResult", (data) => {
    const btn = document.getElementById("btn-fetch-models");
    btn.disabled = false;
    btn.textContent = "↻";
    if (data.error) {
        setStatus(data.error, "error");
        return;
    }
    const models = data.models || [];
    if (models.length === 0) {
        setStatus("No models found", "error");
        return;
    }
    const select = document.getElementById("ai-model");
    const currentModel = select.value;
    select.innerHTML = "";
    for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
    }
    if (currentModel && models.indexOf(currentModel) !== -1) {
        select.value = currentModel;
    } else {
        select.value = models[0];
    }
    setStatus(`${models.length} model(s) found`, "success");
    onSettingChange();
});

window.Asc.plugin.attachEvent("onSettingsState", (data) => {
    if (data.settings) applyToUI(data.settings);
    if (data.currentPath)
        document.getElementById("current-file-path").textContent =
            data.currentPath;
    if (data.renameBanner) {
        document
            .getElementById("file-rename-banner")
            .classList.remove("hidden");
        document.getElementById("file-rename-msg").textContent =
            data.renameBanner;
    } else if (data.renameBanner === null) {
        document.getElementById("file-rename-banner").classList.add("hidden");
    }
    if (data.fileOverride) {
        document.getElementById("file-scope").value =
            data.fileOverride.scope || "";
        document.getElementById("file-display-mode").value =
            data.fileOverride.displayMode || "";
    }
    if (data.dbStats) renderDbStats(data.dbStats);
});

window.Asc.plugin.attachEvent("onModelCacheStatus", (data) => {
    renderModelList(data.models || []);
    if (data.available) populateLanguageDropdowns(data.available);
});

window.Asc.plugin.attachEvent("onModelDownloadProgress", (data) => {
    const pair = data.from + "-" + data.to;
    if (data.state === "downloading") {
        setStatus("Downloading " + data.from + "→" + data.to + " model…", "");
        // Show the pair immediately in the list with downloading status
        addDownloadingRow(pair);
    } else if (data.state === "done") {
        setStatus("Model " + data.from + "→" + data.to + " ready", "success");
        removeDownloadingRow(pair);
    } else if (data.state === "error") {
        setStatus(
            "Download failed: " + (data.message || "unknown error"),
            "error",
        );
        removeDownloadingRow(pair);
    }
});

function addDownloadingRow(pair) {
    const container = document.getElementById("model-list");
    // Remove "no models" placeholder
    const empty = container.querySelector(".model-empty");
    if (empty) empty.remove();
    // Don't add if already shown
    if (container.querySelector('[data-pair="' + pair + '"]')) return;
    const parts = pair.split("-");
    const div = document.createElement("div");
    div.className = "model-row";
    div.setAttribute("data-pair", pair);

    const pairSpan = document.createElement("span");
    pairSpan.className = "model-pair";
    pairSpan.textContent = parts[0] + " → " + parts[1];

    const statusSpan = document.createElement("span");
    statusSpan.className = "model-status downloading";
    statusSpan.textContent = "⟳ Downloading…";

    const btnSpan = document.createElement("span");
    btnSpan.className = "model-btn";
    btnSpan.style.visibility = "hidden";
    btnSpan.textContent = "✕";

    div.appendChild(pairSpan);
    div.appendChild(statusSpan);
    div.appendChild(btnSpan);
    container.appendChild(div);
}

function removeDownloadingRow(pair) {
    const container = document.getElementById("model-list");
    const row = container.querySelector(
        '.model-row[data-pair="' + pair + '"] .model-status.downloading',
    );
    if (row) row.closest(".model-row").remove();
}

// --- Auto-save on change ---

function onSettingChange() {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
        window.Asc.plugin.sendToPlugin("onSettingsChanged", readFromUI());
        setStatus("Settings saved", "success");
    }, 500);
}

// --- Plugin lifecycle ---

window.Asc.plugin.init = () => {
    window.Asc.plugin.sendToPlugin("onWindowReady", {});

    // Engine switch
    document
        .getElementById("translation-engine")
        .addEventListener("change", () => {
            updateEngineSections();
            onSettingChange();
        });

    // AI toggle
    document.getElementById("ai-enabled").addEventListener("change", () => {
        updateAiSection();
        onSettingChange();
    });

    // Debug toggle
    document
        .getElementById("debug-enabled")
        .addEventListener("change", function () {
            applyDebugVisibility(this.checked);
            onSettingChange();
        });

    // Auto-save listeners
    for (const id of [
        "libre-url",
        "target-langs",
        "auto-commit",
        "concurrent-connections",
        "ai-endpoint",
        "ai-api-key",
        "ai-model",
    ]) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener("change", onSettingChange);
        el.addEventListener("input", onSettingChange);
    }

    // Quality radio buttons
    for (const r of document.querySelectorAll(
        'input[name="bergamot-quality"]',
    )) {
        r.addEventListener("change", onSettingChange);
    }

    // Scope radio buttons
    for (const r of document.querySelectorAll('input[name="scope"]')) {
        r.addEventListener("change", onSettingChange);
    }

    // Display mode radio buttons
    for (const r of document.querySelectorAll('input[name="display-mode"]')) {
        r.addEventListener("change", onSettingChange);
    }

    // Fetch AI models
    document
        .getElementById("btn-fetch-models")
        .addEventListener("click", fetchModels);

    // Per-file overrides
    for (const id of ["file-scope", "file-display-mode"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener("change", () => {
            window.Asc.plugin.sendToPlugin("onFileSettingChanged", {
                scope: document.getElementById("file-scope").value || null,
                displayMode:
                    document.getElementById("file-display-mode").value || null,
            });
        });
    }

    // Update file record
    const updateRecordBtn = document.getElementById("btn-update-record");
    if (updateRecordBtn)
        updateRecordBtn.addEventListener("click", () => {
            window.Asc.plugin.sendToPlugin("onUpdateFileRecord", {});
        });

    // Cache actions
    document
        .getElementById("btn-clear-model-cache")
        .addEventListener("click", () => {
            window.Asc.plugin.sendToPlugin("onDeleteModelCache", {});
            setStatus("Model cache cleared", "success");
        });

    const compactHistoryBtn = document.getElementById("btn-compact-history");
    if (compactHistoryBtn)
        compactHistoryBtn.addEventListener("click", () => {
            window.Asc.plugin.sendToPlugin("onCompactHistory", {});
        });

    // Add model pair UI
    document
        .getElementById("btn-add-model")
        .addEventListener("click", function () {
            document.getElementById("add-model-row").classList.remove("hidden");
            this.classList.add("hidden");
        });

    document.getElementById("btn-cancel-add").addEventListener("click", () => {
        document.getElementById("add-model-row").classList.add("hidden");
        document.getElementById("btn-add-model").classList.remove("hidden");
    });

    document
        .getElementById("btn-download-model")
        .addEventListener("click", () => {
            const from = document.getElementById("add-model-from").value;
            const to = document.getElementById("add-model-to").value;
            if (from === to) {
                setStatus("Source and target must differ", "error");
                return;
            }
            window.Asc.plugin.sendToPlugin("onDownloadModel", {
                from: from,
                to: to,
            });
            document.getElementById("add-model-row").classList.add("hidden");
            document.getElementById("btn-add-model").classList.remove("hidden");
            setStatus(`Downloading ${from}→${to} model…`, "");
        });

    // Request initial cache status
    window.Asc.plugin.sendToPlugin("onGetModelCacheStatus", {});

    // Initial visibility
    updateEngineSections();
    updateAiSection();
};

window.Asc.plugin.button = (id) => {
    if (id === -1) {
        if (settingsTimer) {
            clearTimeout(settingsTimer);
            settingsTimer = null;
        }
    }
};
