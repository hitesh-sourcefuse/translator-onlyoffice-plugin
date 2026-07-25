const MAX_LINES = 300;
export const SETTINGS_KEY = "CellTranslator_settings";
let lineCount = 0;

function isDebugEnabled() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return JSON.parse(raw).debugEnabled === true;
    } catch (_e) {
        /* ignore */
    }
    return false;
}

function getPanel() {
    const panel = document.getElementById("log-panel");
    if (panel) panel.style.display = isDebugEnabled() ? "" : "none";
    return panel;
}

function log(key, message) {
    const line = "[" + key + "] " + message;
    console.log(line);
    const panel = getPanel();
    if (!panel) return;
    panel.textContent += line + "\n";
    lineCount++;
    if (lineCount > MAX_LINES) {
        const lines = panel.textContent.split("\n");
        panel.textContent = lines.slice(lines.length - MAX_LINES).join("\n");
        lineCount = MAX_LINES;
    }
    panel.scrollTop = panel.scrollHeight;
}

function clear() {
    const panel = getPanel();
    if (panel) panel.textContent = "";
    lineCount = 0;
}

export const PluginLog = { log, clear };
