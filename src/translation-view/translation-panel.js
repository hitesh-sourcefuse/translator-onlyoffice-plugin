import { LanguageDetect } from "../shared/language-detect.js";
import { PluginLog } from "../shared/pluginlog.js";
import { createStatusSetter } from "../shared/status.js";

let currentCell = null; // { sheetName, cellRef, entry, displayMode, sourceLang, targetLang }
let currentView = "view-cell"; // track active view to avoid polling overrides
let currentAlternatives = null; // { current: string, alternatives: string[] }
let aiImproving = false; // tracks whether AI improvement is in progress
let supportedPairs = []; // [{from, to}] — populated from background

const langName = LanguageDetect.langName;

// --- View helpers ---

function showView(id) {
    currentView = id;
    [
        "view-cell",
        "view-history",
        "view-alternatives",
        "view-cell-history",
    ].forEach((v) => {
        document.getElementById(v).classList.toggle("hidden", v !== id);
    });
}

const setStatus = createStatusSetter("status");

function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
        d.toLocaleDateString() +
        " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
}

// Refs are internal ("shape:n:Line Callout 1 2#p0"); show the user the shape's
// own name instead, with a paragraph number only when it is not the first.
function refLabel(cellRef) {
    if (typeof cellRef !== "string") return "";
    const m = /^shape:(?:n:(.*?)|i:(\d+))(?:#p(\d+))?$/.exec(cellRef);
    if (!m) return cellRef;
    const name = m[1] || "Shape " + m[2];
    const para = m[3] === undefined ? 0 : Number.parseInt(m[3], 10);
    return para > 0 ? name + " ¶" + (para + 1) : name;
}

// --- Language override dropdowns ---

/** Every language appearing on either side of a supported pair, by display name. */
function allPairLanguages() {
    const codes = new Set();
    for (const p of supportedPairs) {
        codes.add(p.from);
        codes.add(p.to);
    }
    return Array.from(codes).sort((a, b) =>
        langName(a).localeCompare(langName(b)),
    );
}

function hasOption(sel, value) {
    return Array.from(sel.options).some((o) => o.value === value);
}

/**
 * Render every language into `sel`, disabling the ones with no model for the
 * current counterpart. Dropping them instead would make the list change shape
 * whenever the other dropdown moves, which reads as the language having
 * vanished rather than being unavailable for this particular direction.
 */
function renderLangOptions(sel, codes, isAvailable, autoLabel) {
    const prev = sel.value;
    sel.innerHTML = "";

    if (autoLabel) {
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = autoLabel;
        sel.appendChild(auto);
    }

    for (const code of codes) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = isAvailable(code)
            ? langName(code)
            : langName(code) + " (no model)";
        opt.disabled = !isAvailable(code);
        sel.appendChild(opt);
    }

    // Keep the previous choice even when it is now unavailable, so the user sees
    // what is selected and why it will not run, instead of being moved silently.
    if (prev && codes.includes(prev)) {
        sel.value = prev;
        return;
    }
    if (autoLabel) {
        sel.value = "";
        return;
    }
    sel.value = codes.find(isAvailable) || "";
}

/** Populate "From" with all languages, enabling those that can reach `selectedTo`. */
function populateFromDropdown(selectedTo) {
    const available = selectedTo
        ? new Set(
              supportedPairs
                  .filter((p) => p.to === selectedTo)
                  .map((p) => p.from),
          )
        : new Set(supportedPairs.map((p) => p.from));
    renderLangOptions(
        document.getElementById("lang-from"),
        allPairLanguages(),
        (code) => available.has(code),
        "Auto-detect",
    );
}

/** Populate "To" with all languages, enabling those reachable from `selectedFrom`. */
function populateToDropdown(selectedFrom) {
    const available = selectedFrom
        ? new Set(
              supportedPairs
                  .filter((p) => p.from === selectedFrom)
                  .map((p) => p.to),
          )
        : new Set(supportedPairs.map((p) => p.to));
    renderLangOptions(
        document.getElementById("lang-to"),
        allPairLanguages(),
        (code) => available.has(code),
        null,
    );
}

/** Initialise both dropdowns for the current cell’s detected / configured languages. */
function initLangDropdowns(sourceLang, targetLang) {
    if (supportedPairs.length === 0) return; // not loaded yet

    document.getElementById("lang-override").classList.remove("hidden");
    const fromSel = document.getElementById("lang-from");
    const toSel = document.getElementById("lang-to");

    populateToDropdown(sourceLang || "");
    if (targetLang && hasOption(toSel, targetLang)) toSel.value = targetLang;

    populateFromDropdown(toSel.value);
    // An undetected source must stay on "Auto-detect". Falling through to the
    // first entry in the list is what made undetected Japanese show as Arabic.
    fromSel.value =
        sourceLang && hasOption(fromSel, sourceLang) ? sourceLang : "";
}

/** Fire re-translation with the currently selected From/To pair. */
function triggerRetranslate() {
    if (!currentCell) return;
    const fromSel = document.getElementById("lang-from");
    const toSel = document.getElementById("lang-to");
    const sourceLang = fromSel.value;
    const targetLang = toSel.value;
    if (!sourceLang || !targetLang) return;

    // Check if pair is supported
    const pairExists = supportedPairs.some(
        (p) => p.from === sourceLang && p.to === targetLang,
    );
    if (!pairExists) {
        // Unsupported pair — show original text
        setStatus(
            langName(sourceLang) +
                " → " +
                langName(targetLang) +
                " not supported",
            "error",
        );
        return;
    }

    const sourceText = currentCell.entry ? currentCell.entry.sourceText : null;
    if (!sourceText) return;

    window.Asc.plugin.sendToPlugin("onRetranslateCell", {
        sheetName: currentCell.sheetName,
        cellRef: currentCell.cellRef,
        sourceLang: sourceLang,
        targetLang: targetLang,
        sourceText: sourceText,
    });
}

// --- Cell view ---

function renderCellView(data) {
    currentCell = data;
    currentAlternatives = null;

    // Update language indicator (source → target)
    const langIndicator = document.getElementById("lang-indicator");
    if (data.sourceLang && data.targetLang) {
        langIndicator.textContent =
            langName(data.sourceLang) + " → " + langName(data.targetLang);
        langIndicator.classList.remove("hidden");
    } else {
        langIndicator.classList.add("hidden");
    }

    // Initialise language override dropdowns (only if pairs are loaded)
    if (supportedPairs.length > 0 && !data.translating) {
        initLangDropdowns(data.sourceLang || "", data.targetLang || "");
    }

    const noTransEl = document.getElementById("no-translation");
    const listEl = document.getElementById("translations-list");
    listEl.innerHTML = "";

    // Reset button states (may have been disabled by passthrough)
    const btnAltReset = document.getElementById("btn-alternatives");
    btnAltReset.disabled = false;
    btnAltReset.style.opacity = "";
    btnAltReset.style.pointerEvents = "";
    const btnHistReset = document.getElementById("btn-history");
    btnHistReset.disabled = false;
    btnHistReset.style.opacity = "";
    btnHistReset.style.pointerEvents = "";

    if (!data.entry) {
        if (data.translating) {
            noTransEl.textContent = "Translating…";
            noTransEl.classList.remove("hidden");
        } else {
            noTransEl.textContent = "No translation for this cell";
            noTransEl.classList.remove("hidden");
        }
        listEl.classList.add("hidden");
        document.getElementById("cell-footer").classList.add("hidden");
        document.getElementById("btn-alternatives").classList.add("hidden");
        document.getElementById("btn-history").classList.add("hidden");
        document.getElementById("btn-improve-ai").classList.add("hidden");
        return;
    }
    // Reset text for next time
    noTransEl.textContent = "No translation for this cell";

    noTransEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    document.getElementById("cell-footer").classList.remove("hidden");

    const entry = data.entry;
    const isPassthrough = entry._passthrough === true;
    const displayMode = data.displayMode || "preview";

    // Passthrough: show as-is, no date, buttons disabled
    if (isPassthrough) {
        const langs = Object.keys(entry.translations || {});
        for (let p = 0; p < langs.length; p++) {
            const pBlock = document.createElement("div");
            pBlock.className = "translation-block";
            pBlock.innerHTML =
                "<div class='lang-text'>" +
                escapeHtml(entry.translations[langs[p]]) +
                "</div>";
            listEl.appendChild(pBlock);
        }
        // Footer: cell ref only, no date
        document.getElementById("cell-ref").textContent = refLabel(
            data.cellRef,
        );
        document.getElementById("cell-ref").title = data.cellRef || "";
        document.getElementById("cell-date").textContent = "";
        document.getElementById("cell-stale").classList.add("hidden");
        document.getElementById("btn-revert").classList.add("hidden");
        // Show alternatives & history buttons but disabled
        const btnAlt = document.getElementById("btn-alternatives");
        btnAlt.classList.remove("hidden");
        btnAlt.disabled = true;
        btnAlt.style.opacity = "0.35";
        btnAlt.style.pointerEvents = "none";
        const btnHist = document.getElementById("btn-history");
        btnHist.classList.remove("hidden");
        btnHist.disabled = true;
        btnHist.style.opacity = "0.35";
        btnHist.style.pointerEvents = "none";
        const btnImproveAiPt = document.getElementById("btn-improve-ai");
        btnImproveAiPt.classList.add("hidden");
        return;
    }

    // Show which alternative or user input was selected (if any)
    if (entry._userInput) {
        const badge = document.createElement("div");
        badge.className = "alt-badge user-input-badge";
        badge.textContent = "User Input";
        listEl.appendChild(badge);
    } else if (entry._alternativeIndex != null && entry._alternativeIndex > 0) {
        const badge = document.createElement("div");
        badge.className = "alt-badge";
        badge.textContent = "Alternative " + entry._alternativeIndex;
        listEl.appendChild(badge);
    }

    // In preview mode: show translations. In replace mode: show original source.
    if (displayMode === "replace") {
        const orig = document.createElement("div");
        orig.className = "translation-block";
        orig.innerHTML =
            "<div class='lang-label'>Original</div><div class='lang-text'>" +
            escapeHtml(entry.sourceText) +
            "</div>";
        listEl.appendChild(orig);
    } else {
        // preview mode: show each translation directly (no language label)
        const langs = Object.keys(entry.translations || {});
        for (let i = 0; i < langs.length; i++) {
            const block = document.createElement("div");
            block.className = "translation-block";
            block.innerHTML =
                "<div class='lang-text'>" +
                escapeHtml(entry.translations[langs[i]]) +
                "</div>";
            listEl.appendChild(block);
        }
    }

    // Footer — cell ref + translated date
    document.getElementById("cell-ref").textContent = refLabel(data.cellRef);
    document.getElementById("cell-ref").title = data.cellRef || "";
    document.getElementById("cell-date").textContent = entry.lastTranslated
        ? "Translated: " + formatDate(entry.lastTranslated)
        : "";

    const staleEl = document.getElementById("cell-stale");
    staleEl.classList.toggle("hidden", !entry._stale);

    const revertBtn = document.getElementById("btn-revert");
    revertBtn.classList.toggle("hidden", entry.status !== "replaced");

    document.getElementById("btn-alternatives").classList.remove("hidden");
    document.getElementById("btn-history").classList.remove("hidden");

    // Show 'Improve with AI' only when engine is libre and cell has a translation
    const btnImproveAi = document.getElementById("btn-improve-ai");
    const isAiEngine = data.translationEngine === "ai";
    if (!isPassthrough && data.entry && !isAiEngine) {
        btnImproveAi.classList.remove("hidden");
    } else {
        btnImproveAi.classList.add("hidden");
    }
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// --- Cell-level history view ---

function renderCellHistory(entries) {
    const list = document.getElementById("cell-history-list");
    if (!entries || entries.length === 0) {
        list.innerHTML =
            "<div class='history-empty'>No history available</div>";
        return;
    }
    let html = "";
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        html += "<div class='history-entry'>";
        html += "<div class='history-entry-header'>";
        html += "<span class='history-date'>" + formatDate(e.ts) + "</span>";
        html +=
            "<span class='history-type history-type-" +
            escapeHtml(e.type || "unknown") +
            "'>" +
            escapeHtml(e.type || "") +
            "</span>";
        html += "</div>";
        if (e.type === "updated" && e.oldSource) {
            html += "<div class='history-diff'>";
            html += escapeHtml(e.oldSource) + " → ";
            const langs = Object.keys(
                e.newTranslations || e.oldTranslations || {},
            );
            for (let l = 0; l < langs.length; l++) {
                const lang = langs[l];
                const oldT = e.oldTranslations?.[lang] || "";
                const newT = e.newTranslations?.[lang] || oldT;
                html +=
                    "<span class='lang-label'>[" +
                    lang.toUpperCase() +
                    "]</span> " +
                    escapeHtml(oldT) +
                    " → " +
                    escapeHtml(newT) +
                    " ";
            }
            html += "</div>";
        } else if (e.type === "created") {
            const cLangs = Object.keys(e.newTranslations || {});
            for (let cl = 0; cl < cLangs.length; cl++) {
                html +=
                    "<div class='history-diff'><span class='lang-label'>[" +
                    cLangs[cl].toUpperCase() +
                    "]</span> " +
                    escapeHtml(e.newTranslations?.[cLangs[cl]]) +
                    "</div>";
            }
        } else if (
            e.type === "alternative_selected" ||
            e.type === "user_input"
        ) {
            const aLangs = Object.keys(
                e.newTranslations || e.oldTranslations || {},
            );
            for (let al = 0; al < aLangs.length; al++) {
                const aLang = aLangs[al];
                const aOld = e.oldTranslations?.[aLang] || "";
                const aNew = e.newTranslations?.[aLang] || "";
                html +=
                    "<div class='history-diff'><span class='lang-label'>[" +
                    aLang.toUpperCase() +
                    "]</span> " +
                    escapeHtml(aOld) +
                    " → " +
                    escapeHtml(aNew) +
                    "</div>";
            }
        }
        html += "</div>";
    }
    list.innerHTML = html;
}

// --- Translations list view ---

function requestTranslations() {
    const scope = document.getElementById("filter-scope").value;
    const status = document.getElementById("filter-status").value;
    document.getElementById("history-list").innerHTML =
        "<div class='trans-list-empty'>Loading...</div>";
    window.Asc.plugin.sendToPlugin("onRequestTranslations", {
        scope: scope,
        status: status,
        sheetName: currentCell ? currentCell.sheetName : null,
        cellRef: currentCell ? currentCell.cellRef : null,
    });
}

function renderTranslationsList(entries) {
    const list = document.getElementById("history-list");
    if (!entries || entries.length === 0) {
        list.innerHTML =
            "<div class='trans-list-empty'>No translations found</div>";
        return;
    }
    let html = "";
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const statusClass = "trans-status-" + (e.status || "active");
        html += "<div class='trans-entry'>";
        html += "<div class='trans-entry-ref'>";
        html +=
            "<span>" +
            escapeHtml(e.sheetName) +
            " · " +
            escapeHtml(refLabel(e.cellRef)) +
            "</span>";
        html +=
            "<span class='trans-entry-status " +
            statusClass +
            "'>" +
            escapeHtml(e.status || "active") +
            "</span>";
        html += "</div>";
        html +=
            "<div class='trans-entry-source'>" +
            escapeHtml(e.sourceText || "") +
            "</div>";
        const langs = Object.keys(e.translations || {});
        for (let l = 0; l < langs.length; l++) {
            html +=
                "<div class='trans-entry-translations'>" +
                "<span class='lang-label'>[" +
                langs[l].toUpperCase() +
                "]</span> " +
                escapeHtml(e.translations[langs[l]]) +
                "</div>";
        }
        html += "</div>";
    }
    list.innerHTML = html;
}

// --- Events from background ---

window.Asc.plugin.attachEvent("onCellSelected", (data) => {
    if (
        currentView === "view-history" ||
        currentView === "view-alternatives" ||
        currentView === "view-cell-history"
    ) {
        // Update data silently — user is in another view, don't yank them out
        currentCell = data;
        return;
    }
    showView("view-cell");
    renderCellView(data);
});

window.Asc.plugin.attachEvent("onLanguagePairsLoaded", (data) => {
    supportedPairs = data?.pairs || [];
    PluginLog.log(
        "TRANS-PANEL",
        "language pairs loaded: " + supportedPairs.length,
    );
    // If we already have a cell, init the dropdowns now
    if (currentCell && supportedPairs.length > 0) {
        initLangDropdowns(
            currentCell.sourceLang || "",
            currentCell.targetLang || "",
        );
    }
});

window.Asc.plugin.attachEvent("onHistoryLoaded", (data) => {
    renderCellHistory(data.entries);
});

window.Asc.plugin.attachEvent("onShowHistory", (data) => {
    if (data && data.view === "document") {
        showView("view-history");
        requestTranslations();
    }
});

window.Asc.plugin.attachEvent("onTranslationsLoaded", (data) => {
    renderTranslationsList(data.entries || []);
});

window.Asc.plugin.attachEvent("onTranslationProgress", (data) => {
    // Only update the status bar — never touch the main content area here.
    // The content area is owned by onCellSelected so it won't dance.
    if (data.state === "translating") {
        const done = data.done || 0;
        const total = data.total || "?";
        setStatus("Translating " + done + " / " + total + "…", "");
    } else if (data.state === "scanning") {
        setStatus("Scanning…", "");
    } else if (data.state === "done") {
        setStatus(data.message || "Translation complete", "success");
    } else if (data.state === "error") {
        setStatus(data.message || "Translation failed", "error");
    }
});

window.Asc.plugin.attachEvent("onStatus", (data) => {
    setStatus(data.message || "", data.type || "");
});

window.Asc.plugin.attachEvent("onAlternativesLoaded", (data) => {
    if (!data) return;
    // Ignore stale responses from a different cell
    if (!currentCell || data.cellRef !== currentCell.cellRef) return;
    currentAlternatives = {
        current: data.current || "",
        alternatives: data.alternatives || [],
    };

    // Store source text (hidden element, used by copy button)
    const sourceEl = document.getElementById("alt-source-text");
    if (currentCell?.entry?.sourceText) {
        sourceEl.textContent = currentCell.entry.sourceText;
    }

    // Clear user input textarea
    document.getElementById("alt-user-input").value = "";

    const select = document.getElementById("alt-select");
    select.innerHTML = "";

    const allOptions = [data.current].concat(data.alternatives);
    const labels = ["Current Translation"];
    for (let i = 0; i < data.alternatives.length; i++) {
        labels.push("Alternative " + (i + 1));
    }

    for (let j = 0; j < allOptions.length; j++) {
        const opt = document.createElement("option");
        opt.value = j;
        opt.textContent = labels[j];
        select.appendChild(opt);
    }

    // Add "Custom Translation" option at the end
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = "Custom Translation";
    select.appendChild(customOpt);

    select.value = "0";
    // Show preview, hide textarea
    document.getElementById("alternatives-preview").textContent =
        data.current || "";
    document.getElementById("alternatives-preview").classList.remove("hidden");
    document.getElementById("alt-user-input").classList.add("hidden");

    // Engines without an alternatives API still allow a custom translation, so
    // keep the control usable but say why the list is empty.
    if (data.unsupported) {
        setStatus(data.reason || "Alternatives not available", "info");
    }
});

window.Asc.plugin.attachEvent("onAiImproveResult", (data) => {
    aiImproving = false;
    const btn = document.getElementById("btn-improve-ai");
    btn.textContent = "Improve with AI";
    btn.disabled = false;
    if (data?.success) {
        setStatus("AI improvement saved", "success");
    } else {
        setStatus(data?.message || "AI improvement failed", "error");
    }
});

window.Asc.plugin.attachEvent("onAlternativeSaved", (data) => {
    if (data?.success) {
        setStatus("Alternative saved", "success");
        currentAlternatives = null;
        // Go back to cell view
        showView("view-cell");
        if (currentCell) renderCellView(currentCell);
    } else {
        setStatus(data?.message ? data.message : "Save failed", "error");
    }
});

// --- User actions ---

window.Asc.plugin.init = () => {
    PluginLog.log("TRANS-PANEL", "init");

    // --- Language override dropdown handlers ---
    document.getElementById("lang-from").addEventListener("change", () => {
        // Re-filter "To" options based on new "From"
        populateToDropdown(document.getElementById("lang-from").value);
        triggerRetranslate();
    });
    document.getElementById("lang-to").addEventListener("change", () => {
        // Re-filter "From" options based on new "To"
        populateFromDropdown(document.getElementById("lang-to").value);
        triggerRetranslate();
    });

    document.getElementById("btn-history").addEventListener("click", () => {
        if (!currentCell?.entry) return;
        showView("view-cell-history");
        document.getElementById("cell-history-list").innerHTML =
            "<div class='history-loading'>Loading...</div>";
        window.Asc.plugin.sendToPlugin("onLoadHistory", {
            sheetName: currentCell.sheetName,
            cellRef: currentCell.cellRef,
        });
    });

    document
        .getElementById("btn-history-back")
        .addEventListener("click", () => {
            showView("view-cell");
            if (currentCell) renderCellView(currentCell);
        });

    document.getElementById("btn-revert").addEventListener("click", () => {
        if (!currentCell) return;
        window.Asc.plugin.sendToPlugin("onRevertCell", {
            sheetName: currentCell.sheetName,
            cellRef: currentCell.cellRef,
        });
    });

    document
        .getElementById("btn-alternatives")
        .addEventListener("click", () => {
            if (!currentCell?.entry) return;
            currentAlternatives = null;
            showView("view-alternatives");
            document.getElementById("alternatives-preview").innerHTML =
                "<div class='alternatives-loading'>Fetching alternatives…</div>";
            document
                .getElementById("alternatives-preview")
                .classList.remove("hidden");
            document.getElementById("alt-select").innerHTML = "";
            document.getElementById("alt-user-input").value = "";
            document.getElementById("alt-user-input").classList.add("hidden");
            // Show source text immediately while alternatives load
            const sourceEl = document.getElementById("alt-source-text");
            if (currentCell?.entry?.sourceText) {
                sourceEl.textContent = currentCell.entry.sourceText;
            } else {
                sourceEl.textContent = "";
            }
            window.Asc.plugin.sendToPlugin("onFetchAlternatives", {
                sheetName: currentCell.sheetName,
                cellRef: currentCell.cellRef,
            });
        });

    document.getElementById("btn-improve-ai").addEventListener("click", () => {
        if (!currentCell?.entry || aiImproving) return;
        aiImproving = true;
        const btn = document.getElementById("btn-improve-ai");
        btn.textContent = "Improving…";
        btn.disabled = true;
        setStatus("Improving translation with AI…", "");
        window.Asc.plugin.sendToPlugin("onImproveWithAI", {
            sheetName: currentCell.sheetName,
            cellRef: currentCell.cellRef,
        });
    });

    document.getElementById("btn-alt-back").addEventListener("click", () => {
        currentAlternatives = null;
        showView("view-cell");
        if (currentCell) renderCellView(currentCell);
    });

    document.getElementById("alt-select").addEventListener("change", () => {
        const val = document.getElementById("alt-select").value;
        const preview = document.getElementById("alternatives-preview");
        const textarea = document.getElementById("alt-user-input");

        if (val === "custom") {
            // Show textarea, hide preview
            preview.classList.add("hidden");
            textarea.classList.remove("hidden");
            textarea.focus();
        } else {
            // Show preview, hide textarea
            textarea.classList.add("hidden");
            preview.classList.remove("hidden");
            if (!currentAlternatives) return;
            const idx = parseInt(val, 10);
            const allOptions = [currentAlternatives.current].concat(
                currentAlternatives.alternatives,
            );
            preview.textContent = allOptions[idx] || "";
        }
    });

    document.getElementById("btn-save-alt").addEventListener("click", () => {
        if (!currentCell) return;
        const val = document.getElementById("alt-select").value;

        if (val === "custom") {
            // Save user-provided custom translation
            const userText = document
                .getElementById("alt-user-input")
                .value.trim();
            if (!userText) {
                setStatus("Please enter a translation", "error");
                return;
            }
            window.Asc.plugin.sendToPlugin("onSaveAlternative", {
                sheetName: currentCell.sheetName,
                cellRef: currentCell.cellRef,
                selectedText: userText,
                selectedIndex: -1,
                isUserInput: true,
            });
        } else {
            // Save selected alternative
            if (!currentAlternatives) return;
            const idx = parseInt(val, 10);
            const allOptions = [currentAlternatives.current].concat(
                currentAlternatives.alternatives,
            );
            const selectedText = allOptions[idx] || "";
            window.Asc.plugin.sendToPlugin("onSaveAlternative", {
                sheetName: currentCell.sheetName,
                cellRef: currentCell.cellRef,
                selectedText: selectedText,
                selectedIndex: idx,
            });
        }
    });

    // Copy source text button
    document.getElementById("btn-copy-source").addEventListener("click", () => {
        const sourceText =
            document.getElementById("alt-source-text").textContent || "";
        if (!sourceText) return;
        navigator.clipboard
            .writeText(sourceText)
            .then(() => {
                const btn = document.getElementById("btn-copy-source");
                btn.textContent = "\u2713 Copied";
                btn.classList.add("copied");
                setTimeout(() => {
                    btn.textContent = "\uD83D\uDCCB Copy Source";
                    btn.classList.remove("copied");
                }, 1500);
            })
            .catch(() => {
                setStatus("Copy failed", "error");
            });
    });

    document.getElementById("btn-back").addEventListener("click", () => {
        showView("view-cell");
        if (currentCell) renderCellView(currentCell);
    });

    document.getElementById("filter-scope").addEventListener("change", () => {
        if (currentView === "view-history") requestTranslations();
    });

    document.getElementById("filter-status").addEventListener("change", () => {
        if (currentView === "view-history") requestTranslations();
    });

    // Close panel on ESC key
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || e.keyCode === 27) {
            e.preventDefault();
            window.Asc.plugin.sendToPlugin("onCloseTranslationPanel", {});
        }
    });

    // Visual hint: light gray background when panel is not focused (ESC won't work)
    window.addEventListener("focus", () => {
        document.body.classList.remove("inactive");
    });
    window.addEventListener("blur", () => {
        document.body.classList.add("inactive");
    });
    // Start inactive if panel doesn't have focus on load
    if (!document.hasFocus()) {
        document.body.classList.add("inactive");
    }

    window.Asc.plugin.sendToPlugin("onWindowReady", {});
};

window.Asc.plugin.button = (id) => {
    void id;
};
