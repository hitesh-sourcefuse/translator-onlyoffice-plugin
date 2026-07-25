import { PluginLog } from "../shared/pluginlog.js";
import { createStatusSetter } from "../shared/status.js";

let translating = false; // tracks whether translation is in progress

// --- View helpers ---

function showConfig() {
    document.getElementById("view-config").classList.remove("hidden");
}

const setStatus = createStatusSetter("status");

function setFormDisabled(disabled) {
    const targetLangs = document.getElementById("target-langs");
    const scopeRadios = document.querySelectorAll('input[name="scope"]');
    if (targetLangs) targetLangs.disabled = disabled;
    for (let i = 0; i < scopeRadios.length; i++) {
        scopeRadios[i].disabled = disabled;
    }
}

function setTranslating(active) {
    translating = active;
    const btn = document.getElementById("btn-translate");
    if (active) {
        btn.textContent = "Cancel";
        btn.classList.add("btn-cancel-mode");
        btn.disabled = false;
        setFormDisabled(true);
    } else {
        btn.textContent = "Execute Translation";
        btn.classList.remove("btn-cancel-mode");
        btn.disabled = false;
        setFormDisabled(false);
    }
}

// --- Receive messages from background ---

window.Asc.plugin.attachEvent("onLoading", (data) => {
    if (data?.active) {
        setTranslating(true);
        setStatus(data.title || "Working...", "");
    } else {
        setTranslating(false);
        setStatus("", "");
    }
});

window.Asc.plugin.attachEvent("onState", (data) => {
    if (data.settings) {
        applySettingsToUI(data.settings);
    }
    setTranslating(false);
    showConfig();
    setStatus("");
});

window.Asc.plugin.attachEvent("onStatus", (data) => {
    setTranslating(false);
    showConfig();
    setStatus(data.message || "", data.type || "");
});

window.Asc.plugin.attachEvent("onProgress", (data) => {
    setTranslating(true);
    let msg = "Translating " + (data.done || 0) + " / " + (data.total || "?");
    if (data.current) msg += " (" + data.current + ")";
    setStatus(msg, "");
});

window.Asc.plugin.attachEvent("onLog", (data) => {
    PluginLog.log(data.key || "BG", data.message || "");
});

// Relay events (callCommand not allowed in PluginWindow iframes)
window.Asc.plugin.attachEvent("onWriteToSheet", (data) => {
    window.Asc.plugin.sendToPlugin("onDoWriteToSheet", data);
});

window.Asc.plugin.attachEvent("onReadFromSheet", () => {
    window.Asc.plugin.sendToPlugin("onDoReadFromSheet", {});
});

// --- Plugin lifecycle ---

window.Asc.plugin.init = () => {
    PluginLog.log("PANEL", "panel init");
    setStatus("Connecting...", "");

    document.getElementById("btn-translate").addEventListener("click", () => {
        if (translating) {
            // Cancel mode — send cancel to background
            window.Asc.plugin.sendToPlugin("onCancelTranslation", {});
            return;
        }
        // Translate mode — start translation
        setTranslating(true);
        setStatus("Starting translation...", "");
        const uiSettings = readSettingsFromUI();
        window.Asc.plugin.sendToPlugin("onTranslate", uiSettings);
    });

    // Signal background that panel is open and ready
    window.Asc.plugin.sendToPlugin("onWindowReady", {});
};

// --- Settings (multi-select target-langs, scope; no libre-url in this panel) ---

function readSettingsFromUI() {
    const targetSelect = document.getElementById("target-langs");
    const selectedTargets = [];
    if (targetSelect) {
        for (let i = 0; i < targetSelect.options.length; i++) {
            if (targetSelect.options[i].selected) {
                selectedTargets.push(targetSelect.options[i].value);
            }
        }
    }

    const scopeRadios = document.querySelectorAll('input[name="scope"]');
    let scope = "sheet";
    for (const r of scopeRadios) {
        if (r.checked) {
            scope = r.value;
            break;
        }
    }

    const result = {
        targetLangs: selectedTargets.length ? selectedTargets : ["en"],
        scope: scope,
    };
    const urlEl = document.getElementById("libre-url");
    if (urlEl) result.libreTranslateUrl = urlEl.value.replace(/\/+$/, "");
    return result;
}

function applySettingsToUI(settings) {
    const urlEl = document.getElementById("libre-url");
    if (urlEl && settings.libreTranslateUrl)
        urlEl.value = settings.libreTranslateUrl;

    if (settings.targetLangs) {
        const targetSelect = document.getElementById("target-langs");
        if (targetSelect) {
            for (let i = 0; i < targetSelect.options.length; i++) {
                targetSelect.options[i].selected =
                    settings.targetLangs.indexOf(
                        targetSelect.options[i].value,
                    ) !== -1;
            }
        }
    }
    if (settings.scope) {
        const scopeRadios = document.querySelectorAll('input[name="scope"]');
        for (const r of scopeRadios) r.checked = r.value === settings.scope;
    }
}

window.Asc.plugin.button = (id) => {
    void id;
};
