import { AiTranslator } from "./ai-translator.js";
import { BergamotTranslator } from "./bergamot-translator.js";
import { Checksum } from "./checksum.js";
import { LanguageDetect } from "./language-detect.js";
import { PluginLog, SETTINGS_KEY } from "./pluginlog.js";
import { Sidecar } from "./sidecar.js";
import { Translator } from "./translator.js";

/**
 * Run `translateOne` over `items` with a bounded number of concurrent workers.
 * All three engines share this, so concurrency, abort handling, per-item failure
 * isolation and language detection behave identically whichever one is selected.
 *
 * translateOne(text, sourceLang, targetLang, signal) -> Promise<string>
 * onItemDone(key, translations|null, error|null)
 *
 * Never rejects. Engine setup failure fails every item instead, so the caller
 * always reaches its completion handler rather than hanging forever.
 */
function translateItemsPool({
    items,
    translateOne,
    sourceLang,
    targetLangs,
    poolSize,
    signal,
    onItemDone,
}) {
    const queue = items.slice();
    let translated = 0;
    let failed = 0;

    function worker() {
        if (queue.length === 0 || signal?.aborted) return Promise.resolve();
        const item = queue.shift();

        // Detection is best-effort — a detector throw must fail this item only,
        // never take down the whole batch.
        let itemSourceLang = sourceLang;
        if (!itemSourceLang) {
            try {
                const detection = LanguageDetect.detect(item.value);
                itemSourceLang = detection.language || "en";
            } catch (err) {
                log("language detection failed: " + err.message);
                itemSourceLang = "en";
            }
            item._detectedLang = itemSourceLang;
        }

        const translations = {};
        let chain = Promise.resolve();
        for (const lang of targetLangs) {
            chain = chain.then(() =>
                translateOne(item.value, itemSourceLang, lang, signal).then(
                    (text) => {
                        translations[lang] = text;
                    },
                ),
            );
        }

        return chain
            .then(() => {
                translated++;
                if (onItemDone) onItemDone(item.key, translations, null);
            })
            .catch((err) => {
                if (err?.name === "AbortError") throw err;
                failed++;
                if (onItemDone) onItemDone(item.key, null, err);
            })
            .then(() => worker());
    }

    const workerCount = Math.max(1, Math.min(poolSize || 5, items.length));
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());

    return Promise.all(workers)
        .then(() => ({ translated: translated, failed: failed }))
        .catch(() => ({ translated: translated, failed: failed }));
}

/**
 * Build the per-item translate function for an engine. Bergamot's WASM/model
 * load is resolved once here so a load failure surfaces as a per-item rejection
 * the pool can report, rather than an unhandled rejection that strands the UI.
 */
function buildEngineTranslate(engine, settings) {
    if (engine === "ai") {
        return (text, from, to, sig) =>
            AiTranslator.aiTranslate({
                endpoint: settings.aiEndpoint,
                apiKey: settings.aiApiKey,
                model: settings.aiModel,
                sourceText: text,
                sourceLang: from,
                targetLang: to,
                signal: sig,
            });
    }
    if (engine === "libre") {
        return (text, from, to, sig) =>
            Translator.translate(
                settings.libreTranslateUrl,
                text,
                from,
                to,
                sig,
            );
    }

    const stored = readSettingsFromStorage();
    BergamotTranslator.setQuality(stored.bergamotQuality || "base-memory");
    const ready = BergamotTranslator.getTranslator();
    return (text, from, to) =>
        ready.then((bt) =>
            bt
                .translate({ from: from, to: to, text: text, html: false })
                .then((res) => res.target?.text || ""),
        );
}

// Returns an error message when the engine cannot run with these settings, or
// null when it can. Checked up front so a misconfigured engine fails loudly
// instead of silently falling through to whichever engine happens to be next.
function validateEngineSettings(engine, settings) {
    if (engine === "libre" && !settings.libreTranslateUrl) {
        return "LibreTranslate URL not configured";
    }
    if (engine === "ai") {
        if (!settings.aiEndpoint) return "AI endpoint not configured";
        if (!settings.aiModel) return "AI model not configured";
    }
    return null;
}

const BG_STATUS_KEY = "CellTranslator_bgStatus";
const HIDDEN_SHEET_NAME = "_CellTranslator";

let currentDocId = null;
let ledger = null; // { entries: { checksum: { row, source, translation } }, nextRow }
let cellRefs = null; // { refs: { "Sheet1!$A$1": { refRow, ledgerRow } }, nextRow }
let historyData = null; // { entries: [...], nextRow }
let ledgerLoaded = false; // whether ledger has been read from sheet
let currentEpoch = 0;
let translationWindow = null; // PluginWindow for translation-view.html
const autoTranslateAttempted = {}; // "sheetName!cellRef" -> true, prevents infinite re-trigger
let currentAbortController = null;
let pluginWindow = null;
let panelMode = "main"; // "main" or "settings" — tracks which page is loaded
let panelSettings = null; // per-translation override from panel
let syncWindow = null;
let _lastPolledSheet = null;
let _lastPolledCellRef = null;
let selectionPollInterval = null;
let renameBanner = null; // message shown when the file identity changed
const fileOverrides = readFileOverrides(); // docId -> { scope, displayMode }

const FILE_OVERRIDES_KEY = "CellTranslator_fileOverrides";
const HISTORY_KEEP = 500; // entries retained by "Compact history"

// --- Settings helpers ---

function readSettingsFromStorage() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            // Clean up legacy sourceLang field
            if (parsed.sourceLang !== undefined) {
                delete parsed.sourceLang;
                writeSettingsToStorage(parsed);
            }
            return parsed;
        }
    } catch (_e) {
        /* ignore */
    }
    return {
        targetLangs: ["en"],
        libreTranslateUrl: "http://localhost:15065",
        scope: "sheet",
        translateShapes: true,
        autoCommit: false,
        concurrentConnections: 5,
        translationEngine: "bergamot",
        aiEndpoint: "",
        aiApiKey: "",
        aiModel: "",
        debugEnabled: false,
    };
}

function writeSettingsToStorage(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_e) {
        /* ignore */
    }
}

// --- Helpers ---

function setBgStatus(obj) {
    try {
        localStorage.setItem(BG_STATUS_KEY, JSON.stringify(obj));
    } catch (_e) {
        // ignore
    }

    // Forward progress to translation panel (for auto-translate UX)
    if (translationWindow) {
        if (
            obj.state === "scanning" ||
            obj.state === "translating" ||
            obj.state === "done" ||
            obj.state === "error"
        ) {
            sendToTranslationPanel("onTranslationProgress", {
                state: obj.state,
                done: obj.done,
                total: obj.total,
                current: obj.current,
                message:
                    obj.state === "done"
                        ? (obj.translated || 0) +
                          " translated, " +
                          (obj.failed || 0) +
                          " failed"
                        : obj.message,
            });
        }
    }

    if (!pluginWindow) return;

    let msg = "";
    let type = "";
    if (obj.state === "scanning") {
        msg = obj.message || "Scanning sheet...";
        sendToPanel("onLoading", {
            active: true,
            title: obj.message || "Scanning...",
            sub: "",
            type: "",
        });
    } else if (obj.state === "translating") {
        msg = "Translating " + (obj.done || 0) + "/" + (obj.total || "?");
        if (obj.current) msg += " (" + obj.current + ")";
        sendToPanel("onProgress", {
            done: obj.done || 0,
            total: obj.total || 0,
            current: obj.current,
        });
    } else if (obj.state === "storing") {
        msg = "Saving cache...";
        sendToPanel("onLoading", {
            active: true,
            title: "Saving cache...",
            sub: "Writing to document",
            type: "storing",
        });
    } else if (obj.state === "done") {
        msg =
            "Done — " +
            (obj.translated || 0) +
            " translated, " +
            (obj.failed || 0) +
            " failed";
        type = "success";
        sendToPanel("onLoading", { active: false });
        sendToPanel("onStatus", { message: msg, type: type });
    } else if (obj.state === "error") {
        msg = obj.message || "Error";
        type = "error";
        sendToPanel("onLoading", { active: false });
        sendToPanel("onStatus", { message: msg, type: type });
    } else if (obj.state === "idle") {
        msg = obj.message || "";
        sendToPanel("onLoading", { active: false });
        if (msg) sendToPanel("onStatus", { message: msg, type: "" });
    }
}

function log(msg) {
    // PluginLog.log writes to console when no log-panel element exists
    PluginLog.log("BG-WATCH", msg);
    // Forward log to panel so it appears in the panel's log area
    sendToPanel("onLog", { key: "BG-WATCH", message: msg });
}

// --- Document ID resolution ---

function resolveDocId(callback) {
    window.Asc.plugin.callCommand(
        () => Api.GetFullName(),
        false,
        false,
        (fullName) => {
            callback(Sidecar.resolveDocPath(fullName));
        },
    );
}

// --- Cell reading ---

function getSelectionInfo(callback) {
    window.Asc.plugin.callCommand(
        () => {
            const sheet = Api.GetActiveSheet();
            const out = {
                sheetName: sheet.GetName(),
                address: sheet
                    .GetSelection()
                    .GetAddress(true, true, "xlA1", false),
                shapeRef: null,
            };

            // Selecting a shape does not move the cell cursor, so without this
            // the panel would look up whatever cell happens to sit under it.
            // Resolved in the same callCommand to keep the 1s poll to one call.
            try {
                const picked = sheet.GetSelectedShapes
                    ? sheet.GetSelectedShapes() || []
                    : [];
                if (picked.length > 0) {
                    const shape = picked[0];
                    let name = "";
                    try {
                        if (shape.GetName) name = shape.GetName() || "";
                    } catch (_e) {
                        name = "";
                    }
                    if (name) {
                        // Address the whole shape; the panel expands it into
                        // its paragraphs itself.
                        out.shapeRef = "shape:n:" + name;
                    }
                }
            } catch (_e) {
                out.shapeRef = null;
            }

            return out;
        },
        false,
        false,
        callback,
    );
}

// --- Ledger loading ---

function initEmptyLedger(callback) {
    ledger = { entries: {}, nextRow: 2 };
    cellRefs = { refs: {}, nextRow: 2 };
    historyData = { entries: [], nextRow: 2 };
    ledgerLoaded = true;
    callback();
}

function loadLedger(callback) {
    if (ledgerLoaded) {
        callback();
        return;
    }
    const settings = readSettingsFromStorage();

    // Step 1: Check if _CellTranslator sheet exists (read-only, no creation)
    Sidecar.checkSheetExists((exists) => {
        if (exists) {
            // Sheet exists — read data regardless of autoCommit
            Sidecar.detectVersion((status) => {
                if (status === "legacy") {
                    if (settings.autoCommit) {
                        // autoCommit ON — clear old format and write fresh headers
                        Sidecar.clearSheet(() => {
                            Sidecar.writeHeaders(() => {
                                initEmptyLedger(callback);
                            });
                        });
                    } else {
                        // autoCommit OFF — can't read legacy, just init empty memory
                        log(
                            "legacy sheet found but autoCommit off, skipping sheet modification",
                        );
                        initEmptyLedger(callback);
                    }
                } else if (status === "v3") {
                    // v3 — read existing data into memory
                    Sidecar.readLedger((l) => {
                        ledger = l;
                        Sidecar.readRefs((r) => {
                            cellRefs = r;
                            Sidecar.readHistory((h) => {
                                historyData = h;
                                ledgerLoaded = true;
                                log(
                                    "ledger loaded: " +
                                        Object.keys(l.entries).length +
                                        " entries, " +
                                        Object.keys(r.refs).length +
                                        " refs",
                                );
                                callback();
                            });
                        });
                    });
                } else {
                    // "empty" — sheet exists but blank
                    if (settings.autoCommit) {
                        Sidecar.writeHeaders(() => {
                            initEmptyLedger(callback);
                        });
                    } else {
                        log(
                            "empty sheet found but autoCommit off, skipping header write",
                        );
                        initEmptyLedger(callback);
                    }
                }
            });
        } else {
            // Sheet does NOT exist
            if (settings.autoCommit) {
                // autoCommit ON — create sheet + headers
                Sidecar.ensureSheet((ok) => {
                    if (!ok) {
                        log("ensureSheet failed");
                        initEmptyLedger(callback);
                        return;
                    }
                    Sidecar.writeHeaders(() => {
                        initEmptyLedger(callback);
                    });
                });
            } else {
                // autoCommit OFF — memory only, no sheet creation
                log("autoCommit off, skipping sheet creation");
                initEmptyLedger(callback);
            }
        }
    });
}

// --- Batched cell reading ---

function readAllCellsInBatches(
    sheetName,
    dims,
    batchSize,
    epoch,
    sheetLabel,
    targetLang,
    callback,
) {
    const allFiltered = [];
    let currentRow = dims.startRow || 1;
    const lastRow = dims.lastRow;

    // Guard against invalid dimensions (e.g. sheet not fully loaded yet)
    if (!lastRow || Number.isNaN(lastRow)) {
        log(
            "readAllCellsInBatches: invalid lastRow (" +
                lastRow +
                "), skipping",
        );
        callback(allFiltered);
        return;
    }

    function nextBatch() {
        if (epoch !== currentEpoch) return;
        if (currentRow > lastRow) {
            callback(allFiltered);
            return;
        }

        const endRow = Math.min(currentRow + batchSize - 1, lastRow);
        const label =
            sheetLabel +
            "Scanning rows " +
            currentRow +
            "–" +
            endRow +
            " / " +
            lastRow;
        setBgStatus({ state: "scanning", message: label });

        Sidecar.readCellBatch(
            sheetName,
            currentRow,
            endRow,
            dims.startColLetter,
            dims.endColLetter,
            (result) => {
                if (epoch !== currentEpoch) return;
                const kept = filterTranslatableCells(result.cells, targetLang);
                for (let i = 0; i < kept.length; i++) allFiltered.push(kept[i]);
                currentRow = endRow + 1;
                nextBatch();
            },
        );
    }
    nextBatch();
}

// --- Helpers ---

// Normalizes a cell address to the top-left cell.
// Handles merged/range addresses like "$A$1:$C$3" → "$A$1"
function normalizeAddress(addr) {
    if (!addr) return addr;
    const colonIdx = addr.indexOf(":");
    if (colonIdx !== -1) return addr.substring(0, colonIdx);
    return addr;
}

// Parses "$A$1" or "A1" → { col: "A", row: 1 }
function parseCellRef(cellRef) {
    const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(cellRef);
    if (!m) return null;
    return { col: m[1].toUpperCase(), row: parseInt(m[2], 10) };
}

// Converts column letter(s) to a number: A=1, B=2, ..., Z=26, AA=27, etc.
function colToNumber(col) {
    let n = 0;
    for (let i = 0; i < col.length; i++) {
        n = n * 26 + (col.charCodeAt(i) - 64);
    }
    return n;
}

// Parses a selection address like "$A$1:$C$10" or "$A$1" into a range object
// Returns { startCol, startRow, endCol, endRow } (col as numbers)
function parseSelectionRange(address) {
    if (!address) return null;
    const parts = address.split(":");
    const start = parseCellRef(parts[0]);
    if (!start) return null;
    const end = parts.length > 1 ? parseCellRef(parts[1]) : start;
    if (!end) return null;
    return {
        startCol: colToNumber(start.col),
        startRow: start.row,
        endCol: colToNumber(end.col),
        endRow: end.row,
    };
}

// Checks if a cell reference (e.g. "$B$5") falls within a parsed range
function isCellInRange(cellRef, range) {
    if (!range) return true; // no range = no filter
    const cell = parseCellRef(cellRef);
    if (!cell) return false;
    const cellCol = colToNumber(cell.col);
    return (
        cellCol >= range.startCol &&
        cellCol <= range.endCol &&
        cell.row >= range.startRow &&
        cell.row <= range.endRow
    );
}

// --- Scan & Translate ---

function scanActiveSheet(epoch, forceTranslate) {
    if (epoch !== currentEpoch) return;

    // FIX: Snapshot panelSettings ONCE, clear immediately
    const settings = panelSettings || readEffectiveSettings();
    panelSettings = null; // <-- cleared here, not in filterAndTranslate

    const scope = settings.scope || "sheet";
    log("scan triggered (scope=" + scope + ", manual=" + forceTranslate + ")");
    setBgStatus({ state: "scanning" });

    // Load ledger first
    loadLedger(() => {
        if (epoch !== currentEpoch) return;

        if (scope === "workbook") {
            Sidecar.getAllSheetNames((sheetNames) => {
                if (epoch !== currentEpoch) return;
                log(
                    "workbook scope: " +
                        sheetNames.length +
                        " sheets to process",
                );
                const totalTranslated = 0;
                const totalFailed = 0;

                processSheetList(
                    sheetNames,
                    0,
                    settings,
                    epoch,
                    forceTranslate,
                    totalTranslated,
                    totalFailed,
                );
            });
        } else if (scope === "selection" && settings._selectionCell) {
            // Translate only the single cell that triggered auto-translate from the panel
            const selCell = settings._selectionCell;
            const parsed = parseCellRef(selCell.cellRef);
            if (!parsed) {
                log(
                    "selection scope: could not parse cellRef: " +
                        selCell.cellRef,
                );
                setBgStatus({ state: "idle" });
                sendToTranslationPanel(
                    "onCellSelected",
                    buildCellPanelData(
                        selCell.sheetName,
                        selCell.cellRef,
                        null,
                    ),
                );
                return;
            }
            setBgStatus({
                state: "scanning",
                message: "Reading cell " + selCell.cellRef + "...",
            });
            Sidecar.readCellBatch(
                selCell.sheetName,
                parsed.row,
                parsed.row,
                parsed.col,
                parsed.col,
                (result) => {
                    if (epoch !== currentEpoch) return;
                    const selTargetLang = settings.targetLangs?.[0] || "en";
                    const filtered = filterTranslatableCells(
                        result.cells,
                        selTargetLang,
                    );
                    if (filtered.length === 0) {
                        log(
                            "selection scope: no translatable content in " +
                                selCell.cellRef,
                        );
                        setBgStatus({
                            state: "idle",
                            message: "No translatable content in selected cell",
                        });
                        // Dismiss the "Translating…" spinner in the panel
                        sendToTranslationPanel(
                            "onCellSelected",
                            buildCellPanelData(
                                selCell.sheetName,
                                selCell.cellRef,
                                null,
                            ),
                        );
                        return;
                    }
                    filterAndTranslate(
                        selCell.sheetName,
                        filtered,
                        settings,
                        epoch,
                        forceTranslate,
                        () => {
                            // Translation complete — re-dispatch to send actual result to panel
                            dispatchCellToPanel(
                                selCell.sheetName,
                                selCell.cellRef,
                            );
                        },
                    );
                },
            );
        } else {
            // Single sheet
            Sidecar.getSheetDimensions(null, (dims) => {
                if (epoch !== currentEpoch) return;
                if (!dims) {
                    setBgStatus({
                        state: "error",
                        message: "Failed to read sheet dimensions",
                    });
                    return;
                }
                if (dims.sheetName === HIDDEN_SHEET_NAME) {
                    log("skipping hidden cache sheet");
                    setBgStatus({ state: "idle" });
                    return;
                }
                processSingleSheet(
                    dims,
                    settings,
                    epoch,
                    forceTranslate,
                    "",
                    null,
                );
            });
        }
    });
}

function processSheetList(
    sheetNames,
    index,
    settings,
    epoch,
    forceTranslate,
    totalTranslated,
    totalFailed,
) {
    if (epoch !== currentEpoch) return;
    if (index >= sheetNames.length) {
        const msg =
            "All sheets done — " +
            totalTranslated +
            " translated, " +
            totalFailed +
            " failed";
        log(msg);
        setBgStatus({
            state: "done",
            total: totalTranslated + totalFailed,
            translated: totalTranslated,
            failed: totalFailed,
        });
        return;
    }
    const sheetLabel = "Sheet " + (index + 1) + "/" + sheetNames.length + ": ";
    setBgStatus({
        state: "scanning",
        message: sheetLabel + "Getting dimensions...",
    });

    Sidecar.getSheetDimensions(sheetNames[index], (dims) => {
        if (epoch !== currentEpoch) return;
        if (!dims) {
            log(
                "could not get dimensions for " +
                    sheetNames[index] +
                    ", skipping",
            );
            processSheetList(
                sheetNames,
                index + 1,
                settings,
                epoch,
                forceTranslate,
                totalTranslated,
                totalFailed,
            );
            return;
        }
        processSingleSheet(
            dims,
            settings,
            epoch,
            forceTranslate,
            sheetLabel,
            (translated, failed) => {
                processSheetList(
                    sheetNames,
                    index + 1,
                    settings,
                    epoch,
                    forceTranslate,
                    totalTranslated + (translated || 0),
                    totalFailed + (failed || 0),
                );
            },
        );
    });
}

// Ref keys for shape text are "shape:<id>#p<n>" instead of "$A$1". Everything
// between the ledger and the sheet writer treats a ref as an opaque string, so
// only the reader and the writer need to know the difference.
function isShapeRef(cellRef) {
    return typeof cellRef === "string" && cellRef.indexOf("shape:") === 0;
}

// Shape paragraphs join the same batch as the sheet's cells, so they share one
// ledger, one dedupe pass and one translation run.
function appendShapeItems(sheetName, settings, targetLang, cells, callback) {
    if (settings.translateShapes === false) {
        callback(cells);
        return;
    }
    Sidecar.readShapeTexts(sheetName, (result) => {
        const shapes = result?.shapes || [];
        if (shapes.length === 0) {
            callback(cells);
            return;
        }
        const kept = filterTranslatableCells(shapes, targetLang);
        log(
            shapes.length +
                " shape paragraph(s) on " +
                sheetName +
                ", " +
                kept.length +
                " translatable",
        );
        callback(cells.concat(kept));
    });
}

function processSingleSheet(
    dims,
    settings,
    epoch,
    forceTranslate,
    sheetLabel,
    onDone,
) {
    log("processing " + dims.sheetName + " (" + dims.lastRow + " rows)");
    const targetLang = settings.targetLangs?.[0] || "en";
    readAllCellsInBatches(
        dims.sheetName,
        dims,
        100,
        epoch,
        sheetLabel,
        targetLang,
        (filtered) => {
            if (epoch !== currentEpoch) return;
            appendShapeItems(
                dims.sheetName,
                settings,
                targetLang,
                filtered,
                (withShapes) => {
                    if (epoch !== currentEpoch) return;
                    filterAndTranslate(
                        dims.sheetName,
                        withShapes,
                        settings,
                        epoch,
                        forceTranslate,
                        onDone,
                    );
                },
            );
        },
    );
}

// Checksum.hash is 32-bit FNV-1a, so two unrelated source texts can produce the
// same value. The ledger is keyed by checksum, so trusting the hash alone would
// serve one text's translation for the other with nothing to detect it. Every
// lookup confirms the stored source; a genuine collision gets a "<hash>#n" key.
// Returns { key, entry } — entry is null when the key is free to claim.
function probeLedger(ledger, hash, source) {
    let key = hash;
    for (let i = 1; ; i++) {
        const entry = ledger.entries[key];
        if (!entry) {
            if (i > 1) {
                log("checksum collision on " + hash + " — using key " + key);
            }
            return { key: key, entry: null };
        }
        if (entry.source === source) return { key: key, entry: entry };
        key = hash + "#" + i;
    }
}

function filterAndTranslate(
    sheetName,
    cells,
    settings,
    epoch,
    forceTranslate,
    onDone,
) {
    if (epoch !== currentEpoch) return;

    if (!settings.targetLangs?.length) {
        log("incomplete settings, skipping");
        setBgStatus({
            state: "error",
            message:
                "Incomplete settings — configure target language in Settings panel",
        });
        if (onDone) onDone(0, 0);
        return;
    }

    const engineCheck = settings.translationEngine || "bergamot";
    const engineError = validateEngineSettings(engineCheck, settings);
    if (engineError) {
        log(engineError);
        setBgStatus({ state: "error", message: engineError });
        if (onDone) onDone(0, 0);
        return;
    }

    if (cells.length === 0) {
        log("no translatable cells on " + sheetName);
        setBgStatus({ state: "idle", message: "All cells up to date" });
        if (onDone) onDone(0, 0);
        return;
    }

    log("checking " + cells.length + " cells against ledger");
    setBgStatus({
        state: "scanning",
        message: "Checking " + cells.length + " cells...",
    });

    // Compute checksums and check against ledger
    const needTranslation = [];
    const refsToAdd = []; // cells that have a ledger entry but no ref yet
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const hash = Checksum.hash(cell.value);
        const refKey = Sidecar.rowKey(sheetName, cell.cellRef);

        // Check if this content is already in the ledger
        const ledgerEntry = probeLedger(ledger, hash, cell.value).entry;
        if (ledgerEntry) {
            // Content already translated — just ensure ref exists
            if (!cellRefs.refs[refKey]) {
                refsToAdd.push({
                    sheetName: sheetName,
                    cellRef: cell.cellRef,
                    ledgerRow: ledgerEntry.row,
                    hash: hash,
                });
            }
            // Skip translation
            continue;
        }

        // Not in ledger — needs translation
        needTranslation.push({
            cellRef: cell.cellRef,
            value: cell.value,
            hash: hash,
        });
    }

    // Add missing refs for already-translated content
    if (refsToAdd.length > 0) {
        log(
            refsToAdd.length +
                " cells matched existing ledger entries (adding refs)",
        );
        const batchRefRows = [];
        const addedRefKeys = [];
        const refsNextRowBefore = cellRefs.nextRow;
        for (let r = 0; r < refsToAdd.length; r++) {
            const ref = refsToAdd[r];
            const refRow = cellRefs.nextRow++;
            const refKey = Sidecar.rowKey(ref.sheetName, ref.cellRef);
            cellRefs.refs[refKey] = {
                refRow: refRow,
                ledgerRow: ref.ledgerRow,
            };
            addedRefKeys.push(refKey);
            batchRefRows.push({
                row: refRow,
                sheetName: ref.sheetName,
                cellRef: ref.cellRef,
                ledgerRow: ref.ledgerRow,
            });
        }
        // Write refs if autoCommit
        if (settings.autoCommit && batchRefRows.length > 0) {
            Sidecar.writeBatch([], batchRefRows, [], (ok) => {
                if (ok) return;
                // The sheet never took these rows, so memory must not claim them
                // either — the reserved row numbers would leave a permanent gap.
                log(
                    "writeBatch for new refs failed — rolling back " +
                        addedRefKeys.length +
                        " ref(s)",
                );
                for (let k = 0; k < addedRefKeys.length; k++) {
                    delete cellRefs.refs[addedRefKeys[k]];
                }
                cellRefs.nextRow = refsNextRowBefore;
            });
        }
    }

    const skipped = cells.length - needTranslation.length;
    if (skipped > 0) {
        log(skipped + " cells skipped (already in ledger)");
    }

    if (needTranslation.length === 0) {
        log("all " + cells.length + " cells up to date on " + sheetName);
        setBgStatus({ state: "idle", message: "All cells up to date" });
        if (onDone) onDone(0, 0);
        return;
    }

    log(needTranslation.length + " cells need translation on " + sheetName);

    // Auto-trigger (forceTranslate=false): do NOT translate silently — just report status
    if (!forceTranslate) {
        log(
            needTranslation.length +
                " cells need translation (waiting for user to run Execute Translation)",
        );
        setBgStatus({
            state: "idle",
            message: needTranslation.length + " cell(s) need translation",
        });
        if (onDone) onDone(0, 0);
        return;
    }

    // Health check before translating
    const signal = currentAbortController
        ? currentAbortController.signal
        : null;
    const engine = settings.translationEngine || "bergamot";

    if (engine === "bergamot") {
        // Bergamot is local WASM — no server health check needed
        translateChunked(
            sheetName,
            needTranslation,
            settings,
            epoch,
            signal,
            onDone,
        );
    } else if (engine === "ai") {
        AiTranslator.aiHealthCheck(
            settings.aiEndpoint,
            settings.aiApiKey,
            settings.aiModel,
            signal,
        )
            .then((ok) => {
                if (epoch !== currentEpoch) return;
                if (!ok) {
                    log("AI endpoint unreachable at " + settings.aiEndpoint);
                    setBgStatus({
                        state: "error",
                        message: "AI endpoint unreachable",
                    });
                    if (onDone) onDone(0, 0);
                    return;
                }
                translateChunked(
                    sheetName,
                    needTranslation,
                    settings,
                    epoch,
                    signal,
                    onDone,
                );
            })
            .catch((err) => {
                if (err.name === "AbortError") return;
                log("AI health check error: " + err.message);
                setBgStatus({ state: "error", message: err.message });
                if (onDone) onDone(0, 0);
            });
    } else {
        Translator.healthCheck(settings.libreTranslateUrl, signal)
            .then((ok) => {
                if (epoch !== currentEpoch) return;
                if (!ok) {
                    log(
                        "LibreTranslate unreachable at " +
                            settings.libreTranslateUrl,
                    );
                    setBgStatus({
                        state: "error",
                        message: "LibreTranslate unreachable",
                    });
                    if (onDone) onDone(0, 0);
                    return;
                }
                translateChunked(
                    sheetName,
                    needTranslation,
                    settings,
                    epoch,
                    signal,
                    onDone,
                );
            })
            .catch((err) => {
                if (err.name === "AbortError") return;
                log("health check error: " + err.message);
                setBgStatus({ state: "error", message: err.message });
                if (onDone) onDone(0, 0);
            });
    }
}

function translateChunked(sheetName, cells, settings, epoch, signal, onDone) {
    const totalCells = cells.length;
    let doneCells = 0;
    let translatedCells = 0;
    let failedCells = 0;

    // Keyed by raw cell text, so a plain object would resolve a cell whose
    // value is literally "__proto__" to Object.prototype and crash the batch.
    const valueMap = new Map();
    const uniqueItems = [];
    for (let i = 0; i < cells.length; i++) {
        const val = cells[i].value;
        if (!valueMap.has(val)) {
            valueMap.set(val, []);
            uniqueItems.push({ key: val, value: val, hash: cells[i].hash });
        }
        valueMap.get(val).push(cells[i]);
    }

    const skippedDupes = totalCells - uniqueItems.length;
    if (skippedDupes > 0) {
        log(
            skippedDupes +
                " duplicate cells will reuse translations (" +
                uniqueItems.length +
                " unique values)",
        );
    }

    setBgStatus({ state: "translating", total: totalCells, done: 0 });

    const poolSize = settings.concurrentConnections || 5;
    const pendingLedgerRows = [];
    const pendingRefRows = [];
    const pendingHistoryRows = [];

    // These in-memory structures are mutated as results arrive, but the sheet
    // write is only confirmed much later. Record enough to undo them so a failed
    // writeBatch cannot leave memory claiming rows the document never received.
    const rollback = {
        ledgerNextRow: ledger.nextRow,
        refsNextRow: cellRefs.nextRow,
        historyNextRow: historyData ? historyData.nextRow : 0,
        historyLength: historyData?.entries ? historyData.entries.length : 0,
        addedLedgerKeys: [],
        addedRefKeys: [],
        updatedRefs: [],
    };

    function rollbackPendingWrites() {
        for (let i = 0; i < rollback.addedLedgerKeys.length; i++) {
            delete ledger.entries[rollback.addedLedgerKeys[i]];
        }
        for (let i = 0; i < rollback.addedRefKeys.length; i++) {
            delete cellRefs.refs[rollback.addedRefKeys[i]];
        }
        for (let i = 0; i < rollback.updatedRefs.length; i++) {
            const undo = rollback.updatedRefs[i];
            const ref = cellRefs.refs[undo.key];
            if (ref) ref.ledgerRow = undo.ledgerRow;
        }
        ledger.nextRow = rollback.ledgerNextRow;
        cellRefs.nextRow = rollback.refsNextRow;
        if (historyData) {
            if (historyData.entries) {
                historyData.entries.length = rollback.historyLength;
            }
            historyData.nextRow = rollback.historyNextRow;
        }
    }
    const engine = settings.translationEngine || "bergamot";
    let firstError = null;

    const poolPromise = translateItemsPool({
        items: uniqueItems,
        translateOne: buildEngineTranslate(engine, settings),
        sourceLang: null, // auto-detected per item
        targetLangs: settings.targetLangs,
        poolSize: poolSize,
        signal: signal,
        onItemDone: onPoolItemDone,
    });

    function onPoolItemDone(key, translations, error) {
        if (epoch !== currentEpoch) return;

        const matchingCells = valueMap.get(key) || [];
        let hash = null;
        for (let h = 0; h < matchingCells.length; h++) {
            if (matchingCells[h].hash) {
                hash = matchingCells[h].hash;
                break;
            }
        }

        if (error) {
            log("pool error for value: " + error.message);
            if (!firstError) firstError = error;
            failedCells += matchingCells.length;
            doneCells += matchingCells.length;
            setBgStatus({
                state: "translating",
                total: totalCells,
                done: doneCells,
                current: "",
            });
            return;
        }

        // Get first target language translation as string
        const targetLangs = Object.keys(translations);
        const translationText =
            targetLangs.length > 0 ? translations[targetLangs[0]] : "";

        // Add to ledger (one entry per unique content). Probe for the storage
        // key so a checksum collision with an unrelated source claims its own
        // slot instead of overwriting the entry already there.
        const storeKey = probeLedger(ledger, hash, key).key;
        const ledgerRow = ledger.nextRow++;
        ledger.entries[storeKey] = {
            row: ledgerRow,
            source: key,
            translation: translationText,
        };
        rollback.addedLedgerKeys.push(storeKey);
        pendingLedgerRows.push({
            row: ledgerRow,
            checksum: storeKey,
            source: key,
            translation: translationText,
        });

        // Add refs for all matching cells
        for (let c = 0; c < matchingCells.length; c++) {
            const cell = matchingCells[c];
            const refKey = Sidecar.rowKey(sheetName, cell.cellRef);
            const existingRef = cellRefs.refs[refKey];

            if (existingRef) {
                // Cell already has a ref — content changed, record history
                const oldLedgerRow = existingRef.ledgerRow;
                const oldEntry = findLedgerEntryByRow(oldLedgerRow);
                // Update ref to point to new ledger row
                rollback.updatedRefs.push({
                    key: refKey,
                    ledgerRow: existingRef.ledgerRow,
                });
                existingRef.ledgerRow = ledgerRow;
                pendingRefRows.push({
                    row: existingRef.refRow,
                    sheetName: sheetName,
                    cellRef: cell.cellRef,
                    ledgerRow: ledgerRow,
                });

                // Write history entry — field names must match renderHistoryPanel's expectations
                const histRow = historyData.nextRow++;
                const histTargetLang = settings.targetLangs?.[0] || "en";
                const oldTranslations = {};
                const newTranslations = {};
                if (oldEntry?.translation) {
                    oldTranslations[histTargetLang] = oldEntry.translation;
                }
                if (translationText) {
                    newTranslations[histTargetLang] = translationText;
                }
                const changes = JSON.stringify({
                    ts: new Date().toISOString(),
                    type: "updated",
                    oldSource: oldEntry ? oldEntry.source : "",
                    oldTranslations: oldTranslations,
                    newTranslations: newTranslations,
                });
                historyData.entries.push({
                    row: histRow,
                    cellRefRow: existingRef.refRow,
                    changes: changes,
                });
                pendingHistoryRows.push({
                    row: histRow,
                    cellRefRow: existingRef.refRow,
                    changesJson: changes,
                });
            } else {
                // New ref
                const refRow = cellRefs.nextRow++;
                cellRefs.refs[refKey] = {
                    refRow: refRow,
                    ledgerRow: ledgerRow,
                };
                rollback.addedRefKeys.push(refKey);
                pendingRefRows.push({
                    row: refRow,
                    sheetName: sheetName,
                    cellRef: cell.cellRef,
                    ledgerRow: ledgerRow,
                });
            }

            translatedCells++;
            doneCells++;
        }

        setBgStatus({
            state: "translating",
            total: totalCells,
            done: doneCells,
            current: matchingCells[0].cellRef,
        });

        // Write cell content with translation if displayMode=replace
        if (settings.displayMode === "replace" && translationText) {
            for (let rc = 0; rc < matchingCells.length; rc++) {
                replaceCellWithTranslation(
                    sheetName,
                    matchingCells[rc].cellRef,
                    translationText,
                    () => {},
                );
            }
        }
    }

    poolPromise
        .then((_result) => {
            if (epoch !== currentEpoch) return;

            let msg =
                translatedCells + " translated, " + failedCells + " failed";
            if (skippedDupes > 0)
                msg += " (" + skippedDupes + " duplicates reused)";
            log("translate done on " + sheetName + ": " + msg);

            // Nothing translated at all means the engine itself is unusable (model
            // load failure, endpoint down); report that rather than a clean "done".
            const doneStatus =
                translatedCells === 0 && failedCells > 0
                    ? {
                          state: "error",
                          message:
                              "Translation failed: " +
                              (firstError?.message || "engine unavailable"),
                      }
                    : {
                          state: "done",
                          total: totalCells,
                          translated: translatedCells,
                          failed: failedCells,
                      };

            // Batch write all pending rows to sheet
            if (
                settings.autoCommit &&
                (pendingLedgerRows.length > 0 ||
                    pendingRefRows.length > 0 ||
                    pendingHistoryRows.length > 0)
            ) {
                setBgStatus({ state: "storing" });
                Sidecar.writeBatch(
                    pendingLedgerRows,
                    pendingRefRows,
                    pendingHistoryRows,
                    (ok) => {
                        if (!ok) {
                            log(
                                "writeBatch failed after translation — rolling back in-memory ledger",
                            );
                            rollbackPendingWrites();
                            setBgStatus({
                                state: "error",
                                message:
                                    "Cells translated but could not be saved to the document — run Sync to retry",
                            });
                            if (onDone) onDone(0, totalCells);
                            return;
                        }
                        setBgStatus(doneStatus);
                        if (onDone) onDone(translatedCells, failedCells);
                    },
                );
            } else {
                setBgStatus(doneStatus);
                if (onDone) onDone(translatedCells, failedCells);
            }
        })
        .catch((err) => {
            // translateItemsPool resolves even on engine failure, but a throw in the
            // completion handler above must still not strand the panel.
            log("translate completion failed: " + (err?.message || err));
            setBgStatus({
                state: "error",
                message: "Translation failed: " + (err?.message || err),
            });
            if (onDone) onDone(translatedCells, failedCells);
        });
}

function replaceCellWithTranslation(
    sheetName,
    cellRef,
    translationText,
    callback,
) {
    if (isShapeRef(cellRef)) {
        Sidecar.writeShapeParagraph(
            sheetName,
            cellRef,
            translationText,
            callback,
        );
        return;
    }
    Asc.scope.sheetName = sheetName;
    Asc.scope.cellRef = cellRef;
    Asc.scope.newValue = translationText;
    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let sheet = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.sheetName) {
                    sheet = sheets[i];
                    break;
                }
            }
            if (!sheet) return { ok: false };
            sheet.GetRange(Asc.scope.cellRef).SetValue(Asc.scope.newValue);
            return { ok: true };
        },
        false,
        false,
        (result) => {
            log(
                "replaceCellWithTranslation " +
                    cellRef +
                    ": " +
                    (result?.ok ? "ok" : "failed"),
            );
            if (callback) callback(!!result?.ok);
        },
    );
}

function revertCellToOriginal(sheetName, cellRef) {
    const refKey = Sidecar.rowKey(sheetName, cellRef);
    const ref = cellRefs ? cellRefs.refs[refKey] : null;
    if (!ref) {
        log("revert: no ref found for " + cellRef);
        return;
    }
    const entry = findLedgerEntryByRow(ref.ledgerRow);
    if (!entry) {
        log("revert: no ledger entry for row " + ref.ledgerRow);
        return;
    }
    replaceCellWithTranslation(sheetName, cellRef, entry.source, (ok) => {
        if (ok) {
            log("reverted " + cellRef + " to original");
            sendToTranslationPanel(
                "onCellSelected",
                buildCellPanelData(sheetName, cellRef, entry),
            );
        }
    });
}

function syncAllToDoc(statusCallback) {
    if (!ledger || !cellRefs) {
        if (statusCallback) statusCallback(false);
        return;
    }

    // Build batch from in-memory ledger + refs + history
    const ledgerRows = [];
    const refRows = [];
    const historyRows = [];

    const checksums = Object.keys(ledger.entries);
    for (let li = 0; li < checksums.length; li++) {
        const entry = ledger.entries[checksums[li]];
        ledgerRows.push({
            row: entry.row,
            checksum: checksums[li],
            source: entry.source,
            translation: entry.translation,
            altIndex: entry._alternativeIndex || null,
        });
    }

    const refKeys = Object.keys(cellRefs.refs);
    for (let ri = 0; ri < refKeys.length; ri++) {
        const ref = cellRefs.refs[refKeys[ri]];
        const parts = refKeys[ri].split("!");
        const sn = parts[0];
        const cr = parts.slice(1).join("!");
        refRows.push({
            row: ref.refRow,
            sheetName: sn,
            cellRef: cr,
            ledgerRow: ref.ledgerRow,
        });
    }

    if (historyData?.entries) {
        for (let hi = 0; hi < historyData.entries.length; hi++) {
            const he = historyData.entries[hi];
            historyRows.push({
                row: he.row,
                cellRefRow: he.cellRefRow,
                changesJson: he.changes || "",
            });
        }
    }

    log(
        "syncAllToDoc: " +
            ledgerRows.length +
            " ledger, " +
            refRows.length +
            " refs, " +
            historyRows.length +
            " history",
    );

    // Write first, trim after. Clearing up front means any later failure wipes
    // the cache with nothing to put back; overwriting in place leaves the old
    // rows intact whenever the write never lands.
    const maxRow = (rows) => {
        let max = 1;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].row > max) max = rows[i].row;
        }
        return max;
    };

    Sidecar.ensureSheet((ok) => {
        if (!ok) {
            if (statusCallback) statusCallback(false);
            return;
        }
        Sidecar.writeHeaders((headersOk) => {
            if (!headersOk) {
                log("syncAllToDoc: writeHeaders failed — sheet left untouched");
                if (statusCallback) statusCallback(false);
                return;
            }
            Sidecar.writeBatch(ledgerRows, refRows, historyRows, (writeOk) => {
                if (!writeOk) {
                    log(
                        "syncAllToDoc: writeBatch failed — sheet left untouched",
                    );
                    if (statusCallback) statusCallback(false);
                    return;
                }
                Sidecar.clearTrailingRows(
                    maxRow(ledgerRows) + 1,
                    maxRow(refRows) + 1,
                    maxRow(historyRows) + 1,
                    (trimOk) => {
                        if (!trimOk) {
                            log(
                                "syncAllToDoc: trailing trim failed (data written ok)",
                            );
                        }
                        log("syncAllToDoc: writeBatch ok");
                        if (statusCallback) statusCallback(true);
                    },
                );
            });
        });
    });
}

// --- Translation panel helpers ---

function sendToTranslationPanel(event, data) {
    if (!translationWindow) return;
    translationWindow.command(event, data);
}

function buildPassthroughData(
    sheetName,
    cellRef,
    cellValue,
    targetLang,
    sourceLang,
) {
    const translations = {};
    translations[targetLang || "en"] = cellValue;
    return {
        sheetName: sheetName,
        cellRef: cellRef,
        sourceLang: sourceLang || "",
        entry: {
            sourceText: cellValue,
            translations: translations,
            lastTranslated: null,
            historyCount: 0,
            status: "active",
            _stale: false,
            _passthrough: true,
        },
    };
}

function buildCellPanelData(sheetName, cellRef, ledgerEntry) {
    const settings = readSettingsFromStorage();
    if (!ledgerEntry) {
        return {
            sheetName: sheetName,
            cellRef: cellRef,
            entry: null,
            translationEngine: settings.translationEngine || "bergamot",
            targetLang: settings.targetLangs?.[0] || "en",
        };
    }
    // Build translations object keyed by target language
    const targetLang = settings.targetLangs?.[0] || "en";
    const translations = {};
    if (ledgerEntry.translation) {
        translations[targetLang] = ledgerEntry.translation;
    }

    // Auto-detect source language from the source text
    const detection = LanguageDetect.detect(ledgerEntry.source || "");
    const detectedSourceLang = detection.language || "";

    const entryData = {
        sourceText: ledgerEntry.source,
        translations: translations, // { en: "Tokyo" } — panel expects object
        lastTranslated: null, // V3 ledger doesn't store per-entry timestamps
        historyCount: 0,
        status: "active",
        _stale: false,
    };
    if (ledgerEntry._alternativeIndex != null) {
        entryData._alternativeIndex = ledgerEntry._alternativeIndex;
    }
    if (ledgerEntry._userInput) {
        entryData._userInput = true;
    }
    return {
        sheetName: sheetName,
        cellRef: cellRef,
        entry: entryData,
        translationEngine: settings.translationEngine || "bergamot",
        sourceLang: detectedSourceLang,
        targetLang: targetLang,
    };
}

function isShapeGroupRef(ref) {
    return isShapeRef(ref) && ref.indexOf("#p") === -1;
}

// Record one translated shape paragraph in the ledger, returning its entry.
function recordShapeTranslation(sheetName, cellRef, source, translation) {
    if (!ledger || !cellRefs) return null;
    const hash = Checksum.hash(source);
    const storeKey = probeLedger(ledger, hash, source).key;

    let entry = ledger.entries[storeKey];
    let ledgerRow;
    if (entry) {
        ledgerRow = entry.row;
        entry.translation = translation;
    } else {
        ledgerRow = ledger.nextRow++;
        entry = { row: ledgerRow, source: source, translation: translation };
        ledger.entries[storeKey] = entry;
    }

    const refKey = Sidecar.rowKey(sheetName, cellRef);
    let refRow;
    if (cellRefs.refs[refKey]) {
        refRow = cellRefs.refs[refKey].refRow;
        cellRefs.refs[refKey].ledgerRow = ledgerRow;
    } else {
        refRow = cellRefs.nextRow++;
        cellRefs.refs[refKey] = { refRow: refRow, ledgerRow: ledgerRow };
    }

    if (readSettingsFromStorage().autoCommit) {
        Sidecar.writeBatch(
            [
                {
                    row: ledgerRow,
                    checksum: storeKey,
                    source: source,
                    translation: translation,
                },
            ],
            [
                {
                    row: refRow,
                    sheetName: sheetName,
                    cellRef: cellRef,
                    ledgerRow: ledgerRow,
                },
            ],
            [],
            (ok) => {
                if (!ok) log("writeBatch failed for shape " + cellRef);
            },
        );
    }
    return entry;
}

// Present the shape as one block: source paragraphs joined, translations joined
// in the same order, untranslated paragraphs falling back to their original.
function sendShapePanelData(sheetName, groupRef, paras, targetLang, pending) {
    const settings = readSettingsFromStorage();
    const sourceText = paras.map((p) => p.value).join("\n");
    const translations = {};
    translations[targetLang] = paras
        .map((p) => (p.entry?.translation ? p.entry.translation : p.value))
        .join("\n");

    sendCellResultIfCurrent(sheetName, groupRef, "onCellSelected", {
        sheetName: sheetName,
        cellRef: groupRef,
        sourceLang: LanguageDetect.detect(sourceText).language || "",
        targetLang: targetLang,
        translationEngine: settings.translationEngine || "bergamot",
        translating: !!pending,
        entry: {
            sourceText: sourceText,
            translations: translations,
            lastTranslated: null,
            historyCount: 0,
            status: "active",
            _stale: false,
        },
    });
}

// A shape's paragraphs are separate ledger entries so each keeps its own
// formatting when written back, but the panel would be useless showing only the
// first line of a three-line callout — so it shows the shape whole.
function dispatchShapeToPanel(sheetName, groupRef) {
    const settings = readSettingsFromStorage();
    const targetLang = settings.targetLangs?.[0] || "en";
    const prefix = groupRef + "#p";

    Sidecar.readShapeTexts(sheetName, (result) => {
        const paras = (result?.shapes || []).filter(
            (p) => p.cellRef.indexOf(prefix) === 0,
        );
        if (paras.length === 0) {
            sendCellResultIfCurrent(
                sheetName,
                groupRef,
                "onCellSelected",
                buildCellPanelData(sheetName, groupRef, null),
            );
            return;
        }

        for (let i = 0; i < paras.length; i++) {
            const rk = Sidecar.rowKey(sheetName, paras[i].cellRef);
            const ref = cellRefs ? cellRefs.refs[rk] : null;
            paras[i].entry = ref ? findLedgerEntryByRow(ref.ledgerRow) : null;
        }

        const missing = paras.filter(
            (p) =>
                !p.entry &&
                LanguageDetect.needsTranslation(p.value, targetLang)
                    .needsTranslation,
        );

        const groupKey = sheetName + "!" + groupRef;
        if (missing.length === 0 || autoTranslateAttempted[groupKey]) {
            sendShapePanelData(sheetName, groupRef, paras, targetLang);
            return;
        }

        const engine = settings.translationEngine || "bergamot";
        const engineError = validateEngineSettings(engine, settings);
        if (engineError) {
            log("shape auto-translate skipped: " + engineError);
            sendShapePanelData(sheetName, groupRef, paras, targetLang);
            return;
        }

        autoTranslateAttempted[groupKey] = true;
        // Show the source straight away so the panel is not blank while the
        // engine warms up.
        sendShapePanelData(sheetName, groupRef, paras, targetLang, true);

        log(
            "auto-translating " +
                missing.length +
                " shape paragraph(s) of " +
                groupRef,
        );

        translateItemsPool({
            items: missing.map((p) => ({ key: p.cellRef, value: p.value })),
            translateOne: buildEngineTranslate(engine, settings),
            sourceLang: null,
            targetLangs: [targetLang],
            poolSize: settings.concurrentConnections || 5,
            signal: null,
            onItemDone: (key, translated, error) => {
                const para = paras.find((p) => p.cellRef === key);
                if (!para) return;
                if (error) {
                    log("shape translate failed " + key + ": " + error.message);
                    return;
                }
                const text = translated[targetLang] || "";
                para.entry = recordShapeTranslation(
                    sheetName,
                    key,
                    para.value,
                    text,
                );
                if (settings.displayMode === "replace" && text) {
                    replaceCellWithTranslation(sheetName, key, text, () => {});
                }
            },
        }).then(() => {
            sendShapePanelData(sheetName, groupRef, paras, targetLang);
        });
    });
}

function dispatchCellToPanel(sheetName, cellRef) {
    if (isShapeGroupRef(cellRef)) {
        dispatchShapeToPanel(sheetName, cellRef);
        return;
    }
    const refKey = Sidecar.rowKey(sheetName, cellRef);
    const ref = cellRefs ? cellRefs.refs[refKey] : null;
    const entry = ref ? findLedgerEntryByRow(ref.ledgerRow) : null;

    if (entry) {
        sendToTranslationPanel(
            "onCellSelected",
            buildCellPanelData(sheetName, cellRef, entry),
        );
    } else {
        // No ledger entry — fetch the source text, then decide whether to
        // auto-translate it or show it as passthrough.
        if (isShapeRef(cellRef)) {
            Sidecar.readShapeParagraph(sheetName, cellRef, (shapeText) => {
                decideForSourceText(
                    typeof shapeText === "string" ? shapeText.trim() : null,
                );
            });
            return;
        }

        const parsed = parseCellRef(cellRef);
        if (!parsed) {
            sendToTranslationPanel(
                "onCellSelected",
                buildCellPanelData(sheetName, cellRef, null),
            );
            return;
        }
        Sidecar.readCellBatch(
            sheetName,
            parsed.row,
            parsed.row,
            parsed.col,
            parsed.col,
            (result) => {
                let cellValue = null;
                if (result?.cells && result.cells.length > 0) {
                    cellValue = result.cells[0].value;
                    if (typeof cellValue === "string")
                        cellValue = cellValue.trim();
                }
                decideForSourceText(cellValue);
            },
        );
    }

    // Shared by the cell and shape paths above: both arrive with a source
    // string (or null), and from here on the handling is identical.
    function decideForSourceText(cellValue) {
        {
            // If cell is empty or has no text, show "No translation"
            if (!cellValue) {
                sendToTranslationPanel(
                    "onCellSelected",
                    buildCellPanelData(sheetName, cellRef, null),
                );
                return;
            }

            // Use eld to detect language — if already in target language, show as-is
            const globalSettings = readSettingsFromStorage();
            const targetLang = globalSettings.targetLangs?.[0] || "en";
            const cellDetection = LanguageDetect.needsTranslation(
                cellValue,
                targetLang,
            );

            if (!cellDetection.needsTranslation) {
                const translations = {};
                translations[targetLang] = cellValue;
                const passthroughData = {
                    sheetName: sheetName,
                    cellRef: cellRef,
                    entry: {
                        sourceText: cellValue,
                        translations: translations,
                        lastTranslated: null,
                        historyCount: 0,
                        status: "active",
                        _stale: false,
                        _passthrough: true,
                    },
                };
                log(
                    "passthrough (target-lang) cell: " +
                        sheetName +
                        "!" +
                        cellRef,
                );
                sendToTranslationPanel("onCellSelected", passthroughData);
                return;
            }

            // Cell needs translation — auto-translate
            const detectedSourceLang = cellDetection.detectedLang || "";
            const cellKey = sheetName + "!" + cellRef;
            if (!autoTranslateAttempted[cellKey]) {
                autoTranslateAttempted[cellKey] = true;
                const panelData = buildCellPanelData(sheetName, cellRef, null);
                panelData.translating = true;
                sendToTranslationPanel("onCellSelected", panelData);

                const autoEngine =
                    globalSettings.translationEngine || "bergamot";

                if (autoEngine === "bergamot") {
                    // Bergamot auto-translate for single cell
                    log(
                        "Bergamot auto-translating uncached cell: " +
                            cellKey +
                            " (detected: " +
                            detectedSourceLang +
                            ")",
                    );
                    const bgTargetLang = targetLang;
                    const bgSourceLang = detectedSourceLang || "en";
                    BergamotTranslator.getTranslator()
                        .then((bt) =>
                            bt.translate({
                                from: bgSourceLang,
                                to: bgTargetLang,
                                text: cellValue,
                                html: false,
                            }),
                        )
                        .then((response) => {
                            const translatedText = response.target?.text || "";
                            const hash = Checksum.hash(cellValue);
                            const storeKey = probeLedger(
                                ledger,
                                hash,
                                cellValue,
                            ).key;
                            const ledgerRow = ledger.nextRow++;
                            ledger.entries[storeKey] = {
                                row: ledgerRow,
                                source: cellValue,
                                translation: translatedText,
                            };
                            const refKey2 = Sidecar.rowKey(sheetName, cellRef);
                            const refRow = cellRefs.nextRow++;
                            cellRefs.refs[refKey2] = {
                                refRow: refRow,
                                ledgerRow: ledgerRow,
                            };
                            if (globalSettings.autoCommit) {
                                Sidecar.writeBatch(
                                    [
                                        {
                                            row: ledgerRow,
                                            checksum: storeKey,
                                            source: cellValue,
                                            translation: translatedText,
                                        },
                                    ],
                                    [
                                        {
                                            row: refRow,
                                            sheetName: sheetName,
                                            cellRef: cellRef,
                                            ledgerRow: ledgerRow,
                                        },
                                    ],
                                    [],
                                    (ok) => {
                                        if (!ok)
                                            log(
                                                "writeBatch failed for Bergamot auto-translate",
                                            );
                                    },
                                );
                            }
                            if (
                                globalSettings.displayMode === "replace" &&
                                translatedText
                            ) {
                                replaceCellWithTranslation(
                                    sheetName,
                                    cellRef,
                                    translatedText,
                                    () => {},
                                );
                            }
                            if (
                                sheetName === _lastPolledSheet &&
                                cellRef === _lastPolledCellRef
                            ) {
                                dispatchCellToPanel(sheetName, cellRef);
                            }
                        })
                        .catch((err) => {
                            log(
                                "Bergamot auto-translate error: " + err.message,
                            );
                            // Allow retry on next click
                            delete autoTranslateAttempted[cellKey];
                            // Show original text as passthrough instead of "No translation"
                            sendCellResultIfCurrent(
                                sheetName,
                                cellRef,
                                "onCellSelected",
                                buildPassthroughData(
                                    sheetName,
                                    cellRef,
                                    cellValue,
                                    targetLang,
                                ),
                            );
                        });
                } else if (
                    autoEngine === "ai" &&
                    globalSettings.aiEndpoint &&
                    globalSettings.aiModel
                ) {
                    // AI auto-translate for single cell
                    log(
                        "AI auto-translating uncached cell: " +
                            cellKey +
                            " (detected: " +
                            detectedSourceLang +
                            ")",
                    );
                    const aiTargetLang = targetLang;
                    const aiSourceLang = detectedSourceLang || "en";
                    AiTranslator.aiTranslate({
                        endpoint: globalSettings.aiEndpoint,
                        apiKey: globalSettings.aiApiKey,
                        model: globalSettings.aiModel,
                        sourceText: cellValue,
                        sourceLang: aiSourceLang,
                        targetLang: aiTargetLang,
                        signal: null,
                    })
                        .then((translatedText) => {
                            const hash = Checksum.hash(cellValue);
                            const storeKey = probeLedger(
                                ledger,
                                hash,
                                cellValue,
                            ).key;
                            const ledgerRow = ledger.nextRow++;
                            ledger.entries[storeKey] = {
                                row: ledgerRow,
                                source: cellValue,
                                translation: translatedText,
                            };
                            const refKey2 = Sidecar.rowKey(sheetName, cellRef);
                            const refRow = cellRefs.nextRow++;
                            cellRefs.refs[refKey2] = {
                                refRow: refRow,
                                ledgerRow: ledgerRow,
                            };
                            if (globalSettings.autoCommit) {
                                Sidecar.writeBatch(
                                    [
                                        {
                                            row: ledgerRow,
                                            checksum: storeKey,
                                            source: cellValue,
                                            translation: translatedText,
                                        },
                                    ],
                                    [
                                        {
                                            row: refRow,
                                            sheetName: sheetName,
                                            cellRef: cellRef,
                                            ledgerRow: ledgerRow,
                                        },
                                    ],
                                    [],
                                    (ok) => {
                                        if (!ok)
                                            log(
                                                "writeBatch failed for AI auto-translate",
                                            );
                                    },
                                );
                            }
                            if (
                                globalSettings.displayMode === "replace" &&
                                translatedText
                            ) {
                                replaceCellWithTranslation(
                                    sheetName,
                                    cellRef,
                                    translatedText,
                                    () => {},
                                );
                            }
                            if (
                                sheetName === _lastPolledSheet &&
                                cellRef === _lastPolledCellRef
                            ) {
                                dispatchCellToPanel(sheetName, cellRef);
                            }
                        })
                        .catch((err) => {
                            log("AI auto-translate error: " + err.message);
                            // Allow retry on next click
                            delete autoTranslateAttempted[cellKey];
                            // Show original text as passthrough instead of "No translation"
                            sendCellResultIfCurrent(
                                sheetName,
                                cellRef,
                                "onCellSelected",
                                buildPassthroughData(
                                    sheetName,
                                    cellRef,
                                    cellValue,
                                    targetLang,
                                ),
                            );
                        });
                } else {
                    // LibreTranslate auto-translate
                    panelSettings = {
                        libreTranslateUrl: globalSettings.libreTranslateUrl,
                        targetLangs: globalSettings.targetLangs,
                        scope: "selection",
                        autoCommit: globalSettings.autoCommit,
                        _selectionCell: {
                            sheetName: sheetName,
                            cellRef: cellRef,
                        },
                    };
                    log("auto-translating uncached cell: " + cellKey);
                    onTrigger(true);
                }
            } else {
                // Previous auto-translate attempt failed — allow retry on next click
                delete autoTranslateAttempted[cellKey];
                // Show original text as passthrough instead of "No translation"
                sendToTranslationPanel(
                    "onCellSelected",
                    buildPassthroughData(
                        sheetName,
                        cellRef,
                        cellValue,
                        targetLang,
                    ),
                );
            }
        }
    }
}

// --- Selection polling for translation panel ---

function startSelectionPolling() {
    if (selectionPollInterval) return;
    selectionPollInterval = setInterval(() => {
        if (!translationWindow) {
            stopSelectionPolling();
            return;
        }
        getSelectionInfo((info) => {
            if (!info || info.error) return;
            // A selected shape wins over the cell cursor, which does not move
            // when a drawing is picked.
            const ref = info.shapeRef || normalizeAddress(info.address);
            if (
                info.sheetName === _lastPolledSheet &&
                ref === _lastPolledCellRef
            )
                return;
            _lastPolledSheet = info.sheetName;
            _lastPolledCellRef = ref;
            dispatchCellToPanel(info.sheetName, ref);
        });
    }, 1000);
    log("selection polling started");
}

function stopSelectionPolling() {
    if (selectionPollInterval) {
        clearInterval(selectionPollInterval);
        selectionPollInterval = null;
        log("selection polling stopped");
    }
}

// --- State snapshot for panel ---

function buildState() {
    const settings = readSettingsFromStorage();
    return {
        settings: settings,
        docId: currentDocId,
    };
}

// --- Event handlers ---

function onTrigger(forceTranslate) {
    // Cancel any in-flight scan
    currentEpoch++;
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();

    // Re-resolve so a rename or Save-As mid-session is noticed, but only adopt a
    // real identity — see applyDocId.
    resolveDocId((docId) => {
        applyDocId(docId, () => scanActiveSheet(currentEpoch, forceTranslate));
    });
}

// Adopt a possibly-new document identity. When the file has been renamed or
// saved as a new version, the cached ledger belongs to the previous file and
// must be dropped and reloaded before anything else reads it.
function applyDocId(docId, callback) {
    // Api.GetFullName() is empty while the document is still loading, and
    // resolveDocPath maps that (and any temp-dir path) to the "temp" sentinel.
    // Adopting it would look like a switch to a different file on every sheet
    // change, wiping the ledger and firing reloads that race the running scan.
    if (!docId || docId === "temp") {
        if (!currentDocId) log("docId not resolvable yet, keeping current");
        if (callback) callback();
        return;
    }

    const previous = currentDocId;
    currentDocId = docId;

    if (!previous || previous === docId) {
        if (!previous) log("docId resolved: " + docId);
        if (callback) callback();
        return;
    }

    const kind = Sidecar.detectFileRename(docId, previous);
    log("document changed (" + kind + "): " + previous + " -> " + docId);
    renameBanner =
        kind === "same"
            ? null
            : "This file looks " +
              kind +
              " (was " +
              previous +
              "). Translation memory was reloaded from the current file.";

    ledger = null;
    cellRefs = null;
    historyData = null;
    ledgerLoaded = false;
    for (const key of Object.keys(autoTranslateAttempted)) {
        delete autoTranslateAttempted[key];
    }
    loadLedger(() => {
        log("ledger reloaded after document change");
        sendSettingsState();
        if (callback) callback();
    });
}

// --- Panel window management ---

function sendToPanel(event, data) {
    if (!pluginWindow) return;
    pluginWindow.command(event, data);
}

function sendSettingsState() {
    sendToPanel("onSettingsState", {
        settings: readSettingsFromStorage(),
        currentPath: currentDocId || "",
        dbStats: computeDbStats(),
        renameBanner: renameBanner,
        fileOverride: currentDocId ? fileOverrides[currentDocId] || null : null,
    });
}

// --- Per-file overrides ---

function readFileOverrides() {
    try {
        const raw = localStorage.getItem(FILE_OVERRIDES_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (err) {
        log("could not read file overrides: " + err.message);
        return {};
    }
}

function writeFileOverrides() {
    try {
        localStorage.setItem(FILE_OVERRIDES_KEY, JSON.stringify(fileOverrides));
    } catch (err) {
        log("could not save file overrides: " + err.message);
    }
}

// Base settings with the current document's overrides applied. Overrides belong
// to one workbook, so they are merged at read time rather than written back into
// the shared settings blob.
function readEffectiveSettings() {
    const base = readSettingsFromStorage();
    const override = currentDocId ? fileOverrides[currentDocId] : null;
    if (!override) return base;
    if (override.scope) base.scope = override.scope;
    if (override.displayMode) base.displayMode = override.displayMode;
    return base;
}

// Refs point at ledger row numbers, but the ledger is keyed by checksum, so
// this lookup runs constantly — once per ref when walking a whole sheet. A
// linear scan made that O(n²), so keep a row -> key index.
//
// The index is rebuilt whenever the ledger object is replaced (file change) or
// its entry count moves, and any lookup whose cached key no longer maps to that
// exact row forces a rebuild too — a rollback can free a row that a later add
// reuses while the count coincidentally matches.
let ledgerRowIndex = null;
let ledgerRowIndexSize = -1;
let ledgerRowIndexOwner = null;

function buildLedgerRowIndex(keys) {
    ledgerRowIndex = new Map();
    for (let i = 0; i < keys.length; i++) {
        ledgerRowIndex.set(ledger.entries[keys[i]].row, keys[i]);
    }
    ledgerRowIndexSize = keys.length;
    ledgerRowIndexOwner = ledger;
}

function findLedgerEntryByRow(row) {
    if (!ledger?.entries) return null;
    let keys = Object.keys(ledger.entries);
    if (
        !ledgerRowIndex ||
        ledgerRowIndexOwner !== ledger ||
        ledgerRowIndexSize !== keys.length
    ) {
        buildLedgerRowIndex(keys);
    }

    let key = ledgerRowIndex.get(row);
    let entry = key === undefined ? null : ledger.entries[key];
    if (!entry || entry.row !== row) {
        // Cached mapping is stale for this row — rebuild once and retry.
        keys = Object.keys(ledger.entries);
        buildLedgerRowIndex(keys);
        key = ledgerRowIndex.get(row);
        entry = key === undefined ? null : ledger.entries[key];
        if (!entry || entry.row !== row) return null;
    }

    entry._checksum = key;
    return entry;
}

// A slow engine result can land after the user has already selected another
// cell. Sending it anyway overwrites the panel with the wrong cell's data, so
// confirm the target is still the one on screen.
function sendCellResultIfCurrent(sheetName, cellRef, event, data) {
    if (sheetName !== _lastPolledSheet || cellRef !== _lastPolledCellRef) {
        log("dropping stale " + event + " for " + sheetName + "!" + cellRef);
        return;
    }
    sendToTranslationPanel(event, data);
}

// Which cells are worth sending to an engine: non-empty, not purely numeric or
// date-like, and not already in the target language. Shared so the batch scan
// and the selection scan cannot drift apart on what counts as translatable.
function filterTranslatableCells(cells, targetLang) {
    const kept = [];
    for (let i = 0; i < cells.length; i++) {
        let val = cells[i].value;
        if (typeof val === "string") val = val.trim();
        if (!val || val === "") continue;
        if (/^\s*[\d.,\s%$€¥#+-/:]+\s*$/.test(val)) continue;
        const detection = LanguageDetect.needsTranslation(
            val,
            targetLang || "en",
        );
        if (!detection.needsTranslation) continue;
        cells[i]._detectedLang = detection.detectedLang;
        kept.push(cells[i]);
    }
    return kept;
}

function computeDbStats() {
    const _ledgerCount = ledger ? Object.keys(ledger.entries).length : 0;
    const refsCount = cellRefs ? Object.keys(cellRefs.refs).length : 0;
    const historyCount = historyData ? historyData.entries.length : 0;
    // "rows used" = last written row in the _CellTranslator sheet
    // Each section starts at row 2; nextRow - 1 = last written row
    const lastRow = Math.max(
        ledger ? ledger.nextRow - 1 : 1,
        cellRefs ? cellRefs.nextRow - 1 : 1,
        historyData ? historyData.nextRow - 1 : 1,
    );
    return {
        rows: lastRow, // sheet rows consumed (max of all 3 sections)
        maxHistory: historyCount, // total history entries (V3 has no per-cell depth)
        active: refsCount, // tracked cells (one ref per cell)
    };
}

function ensurePanelWindow() {
    if (pluginWindow) return;
    pluginWindow = new window.Asc.PluginWindow();
    log("panel window created id=" + pluginWindow.id);

    pluginWindow.attachEvent("onWindowReady", () => {
        if (panelMode === "settings") {
            log("settings panel ready, sending enriched settings state");
            sendSettingsState();
        } else {
            log("main panel ready, sending state");
            sendToPanel("onState", buildState());
            const settings = buildState().settings;
            const panelEngine = settings.translationEngine || "bergamot";
            if (panelEngine === "bergamot") {
                BergamotTranslator.getTranslator()
                    .then(() => {
                        sendToPanel("onStatus", {
                            message: "Bergamot engine ready",
                            type: "success",
                        });
                    })
                    .catch(() => {
                        sendToPanel("onStatus", {
                            message: "Bergamot engine failed to load",
                            type: "error",
                        });
                    });
            } else if (panelEngine === "libre" && settings.libreTranslateUrl) {
                Translator.healthCheck(settings.libreTranslateUrl).then(
                    (ok) => {
                        sendToPanel("onStatus", {
                            message: ok
                                ? "Service connected"
                                : "Service unreachable",
                            type: ok ? "success" : "error",
                        });
                    },
                );
            } else if (panelEngine === "ai") {
                sendToPanel("onStatus", {
                    message: settings.aiEndpoint
                        ? "AI engine configured"
                        : "AI endpoint not set",
                    type: settings.aiEndpoint ? "success" : "error",
                });
            }
        }
    });

    pluginWindow.attachEvent("onTranslate", (data) => {
        log("panel: onTranslate");
        if (data) {
            const globalSettings = readSettingsFromStorage();
            panelSettings = {
                libreTranslateUrl: globalSettings.libreTranslateUrl,
                targetLangs: data.targetLangs?.length
                    ? data.targetLangs
                    : globalSettings.targetLangs,
                scope: data.scope || globalSettings.scope,
                autoCommit: globalSettings.autoCommit,
            };
        }
        onTrigger(true);
    });

    // Panel relays write request back here — callCommand IS allowed from panel-event context
    pluginWindow.attachEvent("onDoWriteToSheet", () => {
        syncAllToDoc((ok) => {
            log("write to sheet: " + (ok ? "ok" : "failed"));
            sendToPanel("onLoading", { active: false });
            sendToPanel("onStatus", {
                message: ok ? "Cache saved to document" : "Cache save failed",
                type: ok ? "success" : "error",
            });
        });
    });

    // Panel relays read request back here — callCommand IS allowed from panel-event context
    pluginWindow.attachEvent("onDoReadFromSheet", () => {
        ledgerLoaded = false;
        loadLedger(() => {
            log("sync from doc: ledger reloaded");
            sendToPanel("onState", buildState());
            sendToPanel("onStatus", {
                message: "Cache loaded from document",
                type: "success",
            });
        });
    });

    pluginWindow.attachEvent("onCancelTranslation", () => {
        log("panel: cancel translation requested");
        currentEpoch++;
        if (currentAbortController) currentAbortController.abort();
        currentAbortController = new AbortController();
        setBgStatus({ state: "idle", message: "Translation cancelled" });
    });

    pluginWindow.attachEvent("onSettingsChanged", (newSettings) => {
        log("panel: onSettingsChanged (from settings panel)");
        const oldSettings = readSettingsFromStorage();
        writeSettingsToStorage(newSettings);

        // autoCommit toggled OFF → ON: ensure sheet + headers exist
        if (newSettings.autoCommit && !oldSettings.autoCommit) {
            log("autoCommit turned ON, ensuring sheet exists");
            Sidecar.ensureSheet((ok) => {
                if (!ok) {
                    log("ensureSheet failed on autoCommit toggle");
                    return;
                }
                Sidecar.detectVersion((status) => {
                    if (status !== "v3") {
                        Sidecar.writeHeaders(() => {
                            log(
                                "sheet + headers created after autoCommit toggle",
                            );
                        });
                    }
                });
            });
        }
    });

    pluginWindow.attachEvent("onFileSettingChanged", (data) => {
        if (!currentDocId) {
            log("file setting change ignored — no document identity yet");
            return;
        }
        const override = {
            scope: data?.scope || null,
            displayMode: data?.displayMode || null,
        };
        if (!override.scope && !override.displayMode) {
            delete fileOverrides[currentDocId];
        } else {
            fileOverrides[currentDocId] = override;
        }
        writeFileOverrides();
        log(
            "file override for " +
                currentDocId +
                ": scope=" +
                (override.scope || "-") +
                " displayMode=" +
                (override.displayMode || "-"),
        );
        sendSettingsState();
    });

    pluginWindow.attachEvent("onUpdateFileRecord", () => {
        // The user confirms this is still the same document, so adopt the
        // current identity and push the in-memory memory back into the file.
        resolveDocId((docId) => {
            currentDocId = docId;
            renameBanner = null;
            log("file record updated to " + (docId || "null"));
            syncAllToDoc((ok) => {
                log("file record sync " + (ok ? "ok" : "failed"));
                sendSettingsState();
            });
        });
    });

    pluginWindow.attachEvent("onCompactHistory", () => {
        if (!historyData?.entries) {
            log("compact history: nothing loaded");
            return;
        }
        const before = historyData.entries.length;
        if (before <= HISTORY_KEEP) {
            log("compact history: " + before + " entries, nothing to drop");
            sendSettingsState();
            return;
        }
        // Keep the most recent entries and renumber them into a contiguous
        // block so the rewritten sheet has no gaps. Snapshot first: the drop is
        // only real once the sheet has accepted it, otherwise a later successful
        // sync would trim rows that were never rewritten.
        const previousEntries = historyData.entries;
        const previousNextRow = historyData.nextRow;
        const kept = previousEntries
            .slice(before - HISTORY_KEEP)
            .map((entry, i) => ({ ...entry, row: 2 + i }));
        historyData.entries = kept;
        historyData.nextRow = 2 + kept.length;
        log("compact history: " + before + " -> " + kept.length + " entries");
        syncAllToDoc((ok) => {
            if (!ok) {
                log("compact history sync failed — restoring history");
                historyData.entries = previousEntries;
                historyData.nextRow = previousNextRow;
            }
            sendSettingsState();
        });
    });

    pluginWindow.attachEvent("onFetchModels", (data) => {
        if (!data?.endpoint) {
            sendToPanel("onModelsResult", { error: "No endpoint provided" });
            return;
        }
        const fetchUrl = data.endpoint + "/models";
        const fetchHeaders = {};
        if (data.apiKey) {
            fetchHeaders.Authorization = "Bearer " + data.apiKey;
        }
        log("fetching models from " + fetchUrl);
        fetch(fetchUrl, { headers: fetchHeaders })
            .then((res) => {
                log("fetch models status=" + res.status);
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            })
            .then((json) => {
                const models = (json.data || []).map((m) => m.id).sort();
                log(
                    "fetched " +
                        models.length +
                        " models: " +
                        models.join(", "),
                );
                sendToPanel("onModelsResult", { models: models });
            })
            .catch((err) => {
                log(
                    "fetch models FAILED: name=" +
                        err.name +
                        " message=" +
                        err.message,
                );
                let hint = "";
                if (err.message === "Failed to fetch") {
                    hint =
                        ". Enable CORS in LM Studio: Server tab → Enable CORS";
                }
                sendToPanel("onModelsResult", {
                    error: "Failed to fetch models" + hint,
                });
            });
    });

    pluginWindow.attachEvent("onGetModelCacheStatus", async () => {
        const cached = await BergamotTranslator.listCachedModels();
        let available = null;
        try {
            available = await BergamotTranslator.getAvailableModels();
        } catch (_e) {
            /* ignore */
        }
        sendToPanel("onModelCacheStatus", {
            models: cached,
            available: available,
        });
    });

    pluginWindow.attachEvent("onDeleteModelCache", async (data) => {
        if (data?.key) {
            await BergamotTranslator.deleteCachedModel(data.key);
        } else {
            await BergamotTranslator.clearAllCachedModels();
        }
        const cached = await BergamotTranslator.listCachedModels();
        sendToPanel("onModelCacheStatus", { models: cached });
    });

    pluginWindow.attachEvent("onDownloadModel", async (data) => {
        if (!data?.from || !data?.to) return;
        // Apply quality preference before download
        const settings = readSettingsFromStorage();
        BergamotTranslator.setQuality(
            settings.bergamotQuality || "base-memory",
        );
        sendToPanel("onModelDownloadProgress", {
            from: data.from,
            to: data.to,
            state: "downloading",
        });
        try {
            const bt = await BergamotTranslator.getTranslator();
            await bt.translate({
                from: data.from,
                to: data.to,
                text: "test",
                html: false,
            });
            await new Promise((r) => setTimeout(r, 500));
            sendToPanel("onModelDownloadProgress", {
                from: data.from,
                to: data.to,
                state: "done",
            });
        } catch (err) {
            sendToPanel("onModelDownloadProgress", {
                from: data.from,
                to: data.to,
                state: "error",
                message: err.message,
            });
        }
        const cached = await BergamotTranslator.listCachedModels();
        log("onDownloadModel: cache has " + cached.length + " entries");
        sendToPanel("onModelCacheStatus", { models: cached });
    });

    pluginWindow.attachEvent("onClose", () => {
        log("panel closed via onClose");
        if (pluginWindow) {
            pluginWindow.close();
            pluginWindow = null;
        }
    });
}

function openTranslationPanel() {
    try {
        if (translationWindow) {
            // Already open — just bring to front by re-showing
            translationWindow.show({
                url: "translation-view.html",
                description: "Translation",
                isVisual: true,
                isModal: false,
                buttons: [],
                EditorsSupport: ["cell"],
                size: [360, 400],
            });
            return;
        }
        translationWindow = new window.Asc.PluginWindow();

        translationWindow.attachEvent("onWindowReady", () => {
            log("translation panel ready");
            startSelectionPolling();
            // Send current cell immediately
            getSelectionInfo((info) => {
                if (!info || info.error) return;
                const ref = info.shapeRef || normalizeAddress(info.address);
                _lastPolledSheet = info.sheetName;
                _lastPolledCellRef = ref;
                dispatchCellToPanel(info.sheetName, ref);
            });

            // Send supported language pairs to translation panel
            const engineType =
                readSettingsFromStorage().translationEngine || "bergamot";
            if (engineType === "bergamot") {
                BergamotTranslator.getAvailableModels()
                    .then((models) => {
                        sendToTranslationPanel("onLanguagePairsLoaded", {
                            engine: "bergamot",
                            pairs: models.pairs, // [{from, to, variants}]
                        });
                    })
                    .catch(() => {
                        sendToTranslationPanel("onLanguagePairsLoaded", {
                            engine: "bergamot",
                            pairs: [],
                        });
                    });
            } else {
                // For libre/AI engines, send empty — dropdowns will be free-form
                sendToTranslationPanel("onLanguagePairsLoaded", {
                    engine: engineType,
                    pairs: [],
                });
            }
        });

        translationWindow.attachEvent("onRevertCell", (data) => {
            if (data?.sheetName && data.cellRef) {
                revertCellToOriginal(data.sheetName, data.cellRef);
            }
        });

        translationWindow.attachEvent("onRetranslateCell", (data) => {
            // data: { sheetName, cellRef, sourceLang, targetLang, sourceText }
            if (
                !data?.sheetName ||
                !data.cellRef ||
                !data.sourceText ||
                !data.sourceLang ||
                !data.targetLang
            )
                return;

            log(
                "retranslate cell: " +
                    data.sheetName +
                    "!" +
                    data.cellRef +
                    " " +
                    data.sourceLang +
                    "→" +
                    data.targetLang,
            );

            // Show translating spinner
            sendToTranslationPanel("onCellSelected", {
                sheetName: data.sheetName,
                cellRef: data.cellRef,
                entry: null,
                translating: true,
            });

            const settings = readSettingsFromStorage();
            const engine = settings.translationEngine || "bergamot";

            if (engine === "bergamot") {
                BergamotTranslator.setQuality(
                    settings.bergamotQuality || "base-memory",
                );
                BergamotTranslator.getTranslator()
                    .then((bt) =>
                        bt.translate({
                            from: data.sourceLang,
                            to: data.targetLang,
                            text: data.sourceText,
                            html: false,
                        }),
                    )
                    .then((response) => {
                        const translatedText = response.target?.text || "";
                        const hash = Checksum.hash(data.sourceText);

                        // Update ledger — probe so a checksum collision with an
                        // unrelated source cannot overwrite the wrong entry.
                        let ledgerRow;
                        const probe = probeLedger(
                            ledger,
                            hash,
                            data.sourceText,
                        );
                        if (probe.entry) {
                            ledgerRow = probe.entry.row;
                            probe.entry.translation = translatedText;
                        } else {
                            ledgerRow = ledger.nextRow++;
                            ledger.entries[probe.key] = {
                                row: ledgerRow,
                                source: data.sourceText,
                                translation: translatedText,
                            };
                        }

                        // Ensure ref exists
                        const refKey = Sidecar.rowKey(
                            data.sheetName,
                            data.cellRef,
                        );
                        if (!cellRefs.refs[refKey]) {
                            const refRow = cellRefs.nextRow++;
                            cellRefs.refs[refKey] = {
                                refRow: refRow,
                                ledgerRow: ledgerRow,
                            };
                        }

                        // Write to sidecar if autoCommit
                        if (settings.autoCommit) {
                            Sidecar.writeBatch(
                                [
                                    {
                                        row: ledgerRow,
                                        checksum: probe.key,
                                        source: data.sourceText,
                                        translation: translatedText,
                                    },
                                ],
                                [],
                                [],
                                (ok) => {
                                    if (!ok)
                                        log(
                                            "writeBatch failed for retranslate",
                                        );
                                },
                            );
                        }

                        // Send updated result to panel
                        const panelData = buildCellPanelData(
                            data.sheetName,
                            data.cellRef,
                            ledger.entries[probe.key],
                        );
                        panelData.sourceLang = data.sourceLang;
                        panelData.targetLang = data.targetLang;
                        sendCellResultIfCurrent(
                            data.sheetName,
                            data.cellRef,
                            "onCellSelected",
                            panelData,
                        );
                    })
                    .catch((err) => {
                        log("retranslate error: " + err.message);
                        // Show original text as passthrough on error
                        sendCellResultIfCurrent(
                            data.sheetName,
                            data.cellRef,
                            "onCellSelected",
                            buildPassthroughData(
                                data.sheetName,
                                data.cellRef,
                                data.sourceText,
                                data.targetLang,
                            ),
                        );
                    });
            } else if (
                engine === "ai" &&
                settings.aiEndpoint &&
                settings.aiModel
            ) {
                AiTranslator.aiTranslate({
                    endpoint: settings.aiEndpoint,
                    apiKey: settings.aiApiKey,
                    model: settings.aiModel,
                    sourceText: data.sourceText,
                    sourceLang: data.sourceLang,
                    targetLang: data.targetLang,
                    signal: null,
                })
                    .then((translatedText) => {
                        const hash = Checksum.hash(data.sourceText);
                        // Probe so a checksum collision with an unrelated source
                        // cannot overwrite the wrong entry.
                        let ledgerRow;
                        const probe = probeLedger(
                            ledger,
                            hash,
                            data.sourceText,
                        );
                        if (probe.entry) {
                            ledgerRow = probe.entry.row;
                            probe.entry.translation = translatedText;
                        } else {
                            ledgerRow = ledger.nextRow++;
                            ledger.entries[probe.key] = {
                                row: ledgerRow,
                                source: data.sourceText,
                                translation: translatedText,
                            };
                        }
                        const refKey = Sidecar.rowKey(
                            data.sheetName,
                            data.cellRef,
                        );
                        if (!cellRefs.refs[refKey]) {
                            const refRow = cellRefs.nextRow++;
                            cellRefs.refs[refKey] = {
                                refRow: refRow,
                                ledgerRow: ledgerRow,
                            };
                        }
                        if (settings.autoCommit) {
                            Sidecar.writeBatch(
                                [
                                    {
                                        row: ledgerRow,
                                        checksum: probe.key,
                                        source: data.sourceText,
                                        translation: translatedText,
                                    },
                                ],
                                [],
                                [],
                                (ok) => {
                                    if (!ok)
                                        log(
                                            "writeBatch failed for AI retranslate",
                                        );
                                },
                            );
                        }
                        const panelData = buildCellPanelData(
                            data.sheetName,
                            data.cellRef,
                            ledger.entries[probe.key],
                        );
                        panelData.sourceLang = data.sourceLang;
                        panelData.targetLang = data.targetLang;
                        sendCellResultIfCurrent(
                            data.sheetName,
                            data.cellRef,
                            "onCellSelected",
                            panelData,
                        );
                    })
                    .catch((err) => {
                        log("AI retranslate error: " + err.message);
                        sendCellResultIfCurrent(
                            data.sheetName,
                            data.cellRef,
                            "onCellSelected",
                            buildPassthroughData(
                                data.sheetName,
                                data.cellRef,
                                data.sourceText,
                                data.targetLang,
                            ),
                        );
                    });
            } else {
                // LibreTranslate or misconfigured — show passthrough
                sendToTranslationPanel(
                    "onCellSelected",
                    buildPassthroughData(
                        data.sheetName,
                        data.cellRef,
                        data.sourceText,
                        data.targetLang,
                    ),
                );
            }
        });

        translationWindow.attachEvent("onLoadHistory", (data) => {
            if (!data?.sheetName || !data.cellRef || !historyData) {
                sendToTranslationPanel("onHistoryLoaded", {
                    cellRef: data ? data.cellRef : "",
                    entries: [],
                });
                return;
            }
            const refKey = Sidecar.rowKey(data.sheetName, data.cellRef);
            const ref = cellRefs ? cellRefs.refs[refKey] : null;
            if (!ref) {
                sendToTranslationPanel("onHistoryLoaded", {
                    cellRef: data.cellRef,
                    entries: [],
                });
                return;
            }
            // Find history entries matching this cell ref row
            const entries = [];
            for (let i = 0; i < historyData.entries.length; i++) {
                if (historyData.entries[i].cellRefRow === ref.refRow) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(historyData.entries[i].changes);
                    } catch (_e) {}
                    if (parsed) entries.push(parsed);
                }
            }
            sendToTranslationPanel("onHistoryLoaded", {
                cellRef: data.cellRef,
                sheetName: data.sheetName,
                entries: entries,
            });
        });

        translationWindow.attachEvent("onRequestTranslations", (data) => {
            if (!cellRefs || !ledger) {
                sendToTranslationPanel("onTranslationsLoaded", {
                    entries: [],
                });
                return;
            }

            // Collect entries applying scope + status filters
            function collectEntries(scopeFilter) {
                const entries = [];
                const reqSettings = readSettingsFromStorage();
                const reqTargetLang = reqSettings.targetLangs?.[0] || "en";
                const refKeys = Object.keys(cellRefs.refs);

                for (let i = 0; i < refKeys.length; i++) {
                    const parts = refKeys[i].split("!");
                    const sn = parts[0];
                    const cr = parts.slice(1).join("!");
                    const ref = cellRefs.refs[refKeys[i]];

                    // Apply scope filter
                    if (scopeFilter && !scopeFilter(sn, cr)) continue;

                    const le = findLedgerEntryByRow(ref.ledgerRow);
                    if (!le) continue;

                    const entryStatus = "active"; // V3 ledger doesn't track per-entry status

                    // Apply status filter
                    if (data?.status && entryStatus !== data.status) continue;

                    const reqTranslations = {};
                    if (le.translation) {
                        reqTranslations[reqTargetLang] = le.translation;
                    }
                    entries.push({
                        sheetName: sn,
                        cellRef: cr,
                        sourceText: le.source,
                        translations: reqTranslations,
                        status: entryStatus,
                    });
                }
                sendToTranslationPanel("onTranslationsLoaded", {
                    entries: entries,
                });
            }

            if (data?.scope === "selection") {
                // Get the actual selection range from the spreadsheet
                getSelectionInfo((info) => {
                    if (!info || info.error) {
                        collectEntries(null);
                        return;
                    }
                    const selSheet = info.sheetName;
                    const selAddress = info.address || ""; // e.g. "$A$1:$C$10" or "$A$1"

                    // Parse the selection range
                    const range = parseSelectionRange(selAddress);

                    collectEntries((sn, cr) => {
                        if (sn !== selSheet) return false;
                        return isCellInRange(cr, range);
                    });
                });
            } else if (data?.scope === "sheet") {
                collectEntries((sn) => {
                    return !data.sheetName || sn === data.sheetName;
                });
            } else {
                // "all" — no scope filter
                collectEntries(null);
            }
        });

        translationWindow.attachEvent("onFetchAlternatives", (data) => {
            if (!data?.sheetName || !data.cellRef) {
                sendToTranslationPanel("onAlternativesLoaded", {
                    cellRef: "",
                    current: "",
                    alternatives: [],
                });
                return;
            }
            const refKey = Sidecar.rowKey(data.sheetName, data.cellRef);
            const ref = cellRefs ? cellRefs.refs[refKey] : null;
            if (!ref) {
                sendToTranslationPanel("onAlternativesLoaded", {
                    cellRef: data.cellRef,
                    current: "",
                    alternatives: [],
                });
                return;
            }
            const entry = findLedgerEntryByRow(ref.ledgerRow);
            if (!entry?.source) {
                sendToTranslationPanel("onAlternativesLoaded", {
                    cellRef: data.cellRef,
                    current: "",
                    alternatives: [],
                });
                return;
            }

            const settings = readSettingsFromStorage();
            const targetLang = settings.targetLangs?.[0] || "en";
            const currentTranslation = entry.translation || "";

            log(
                "fetching alternatives for " +
                    data.cellRef +
                    " (source: " +
                    entry.source.substring(0, 30) +
                    "...)",
            );

            const altEngine = settings.translationEngine || "bergamot";

            // Only LibreTranslate can produce real alternatives. Say so plainly
            // rather than echoing the current translation back as if it were a
            // list of choices.
            if (altEngine !== "libre") {
                log(
                    altEngine +
                        " engine has no alternatives API — reporting unsupported",
                );
                sendToTranslationPanel("onAlternativesLoaded", {
                    cellRef: data.cellRef,
                    current: currentTranslation,
                    alternatives: [],
                    unsupported: true,
                    reason: "Alternatives are only available with the LibreTranslate engine.",
                });
                return;
            }

            // Auto-detect source language for alternatives
            const altDetection = LanguageDetect.detect(entry.source);
            const altSourceLang = altDetection.language || "en";

            Translator.translateWithAlternatives(
                settings.libreTranslateUrl,
                entry.source,
                altSourceLang,
                targetLang,
                3,
                null,
            )
                .then((result) => {
                    log(
                        "alternatives fetched: " +
                            result.alternatives.length +
                            " alternatives",
                    );
                    sendToTranslationPanel("onAlternativesLoaded", {
                        cellRef: data.cellRef,
                        current: result.translatedText,
                        alternatives: result.alternatives,
                    });
                })
                .catch((err) => {
                    log("alternatives fetch error: " + err.message);
                    sendToTranslationPanel("onAlternativesLoaded", {
                        cellRef: data.cellRef,
                        current: currentTranslation,
                        alternatives: [],
                    });
                    sendToTranslationPanel("onStatus", {
                        message: "Failed to fetch alternatives: " + err.message,
                        type: "error",
                    });
                });
        });

        translationWindow.attachEvent("onSaveAlternative", (data) => {
            if (!data?.sheetName || !data.cellRef || !data.selectedText) {
                sendToTranslationPanel("onAlternativeSaved", {
                    success: false,
                    message: "Missing data",
                });
                return;
            }
            const refKey = Sidecar.rowKey(data.sheetName, data.cellRef);
            const ref = cellRefs ? cellRefs.refs[refKey] : null;
            if (!ref) {
                sendToTranslationPanel("onAlternativeSaved", {
                    success: false,
                    message: "No ref found",
                });
                return;
            }

            const entry = findLedgerEntryByRow(ref.ledgerRow);
            const entryChecksum = entry ? entry._checksum : null;
            if (!entry) {
                sendToTranslationPanel("onAlternativeSaved", {
                    success: false,
                    message: "No ledger entry",
                });
                return;
            }

            const settings = readSettingsFromStorage();
            const targetLang = settings.targetLangs?.[0] || "en";
            const oldTranslation = entry.translation || "";

            // Skip no-op save (user selected current translation)
            if (data.selectedText === oldTranslation) {
                sendToTranslationPanel("onAlternativeSaved", { success: true });
                return;
            }

            // Update ledger in memory
            entry.translation = data.selectedText;
            entry._alternativeIndex = data.isUserInput
                ? null
                : data.selectedIndex; // display-only: which alternative was picked
            if (data.isUserInput) {
                entry._userInput = true;
            }
            log(
                (data.isUserInput ? "user input" : "alternative") +
                    " saved for " +
                    data.cellRef +
                    (data.isUserInput ? "" : ": index=" + data.selectedIndex),
            );

            // Write history entry
            const oldTranslations = {};
            const newTranslations = {};
            oldTranslations[targetLang] = oldTranslation;
            newTranslations[targetLang] = data.selectedText;

            const histRow = historyData.nextRow++;
            const changes = JSON.stringify({
                ts: new Date().toISOString(),
                type: data.isUserInput ? "user_input" : "alternative_selected",
                oldTranslations: oldTranslations,
                newTranslations: newTranslations,
            });
            historyData.entries.push({
                row: histRow,
                cellRefRow: ref.refRow,
                changes: changes,
            });

            // Write to sidecar if autoCommit
            if (settings.autoCommit) {
                const pendingLedgerRows = [
                    {
                        row: entry.row,
                        checksum: entryChecksum,
                        source: entry.source,
                        translation: data.selectedText,
                        altIndex: data.selectedIndex,
                    },
                ];
                const pendingHistoryRows = [
                    {
                        row: histRow,
                        cellRefRow: ref.refRow,
                        changesJson: changes,
                    },
                ];
                Sidecar.writeBatch(
                    pendingLedgerRows,
                    [],
                    pendingHistoryRows,
                    (ok) => {
                        if (!ok) log("writeBatch failed for alternative save");
                    },
                );
            }

            // If displayMode is replace, write to cell
            if (settings.displayMode === "replace") {
                replaceCellWithTranslation(
                    data.sheetName,
                    data.cellRef,
                    data.selectedText,
                    () => {},
                );
            }

            // Send success + refresh panel
            sendToTranslationPanel("onAlternativeSaved", { success: true });
            sendToTranslationPanel(
                "onCellSelected",
                buildCellPanelData(data.sheetName, data.cellRef, entry),
            );
        });

        translationWindow.attachEvent("onImproveWithAI", (data) => {
            if (!data?.sheetName || !data.cellRef) {
                sendToTranslationPanel("onAiImproveResult", {
                    success: false,
                    message: "Missing data",
                });
                return;
            }
            const refKey = Sidecar.rowKey(data.sheetName, data.cellRef);
            const ref = cellRefs ? cellRefs.refs[refKey] : null;
            if (!ref) {
                sendToTranslationPanel("onAiImproveResult", {
                    success: false,
                    message: "No translation found for this cell",
                });
                return;
            }
            const entry = findLedgerEntryByRow(ref.ledgerRow);
            const entryChecksum = entry ? entry._checksum : null;
            if (!entry?.source) {
                sendToTranslationPanel("onAiImproveResult", {
                    success: false,
                    message: "No source text found",
                });
                return;
            }

            const settings = readSettingsFromStorage();
            if (!settings.aiEndpoint || !settings.aiModel) {
                sendToTranslationPanel("onAiImproveResult", {
                    success: false,
                    message:
                        "AI settings not configured. Go to Settings to set endpoint and model.",
                });
                return;
            }

            const targetLang = settings.targetLangs?.[0] || "en";
            const oldTranslation = entry.translation || "";

            // Auto-detect source language for AI improvement
            const aiImpDetection = LanguageDetect.detect(entry.source);
            const aiImpSourceLang = aiImpDetection.language || "en";

            log(
                "AI improving translation for " +
                    data.cellRef +
                    " (detected: " +
                    aiImpSourceLang +
                    ", source: " +
                    entry.source.substring(0, 30) +
                    "...)",
            );

            AiTranslator.aiTranslate({
                endpoint: settings.aiEndpoint,
                apiKey: settings.aiApiKey,
                model: settings.aiModel,
                sourceText: entry.source,
                sourceLang: aiImpSourceLang,
                targetLang: targetLang,
                signal: null,
            })
                .then((improvedText) => {
                    entry.translation = improvedText;
                    entry._userInput = true;
                    entry._alternativeIndex = null;
                    log("AI improvement saved for " + data.cellRef);

                    const oldTranslations = {};
                    const newTranslations = {};
                    oldTranslations[targetLang] = oldTranslation;
                    newTranslations[targetLang] = improvedText;

                    const histRow = historyData.nextRow++;
                    const changes = JSON.stringify({
                        ts: new Date().toISOString(),
                        type: "user_input",
                        oldTranslations: oldTranslations,
                        newTranslations: newTranslations,
                    });
                    historyData.entries.push({
                        row: histRow,
                        cellRefRow: ref.refRow,
                        changes: changes,
                    });

                    if (settings.autoCommit) {
                        Sidecar.writeBatch(
                            [
                                {
                                    row: entry.row,
                                    checksum: entryChecksum,
                                    source: entry.source,
                                    translation: improvedText,
                                },
                            ],
                            [],
                            [
                                {
                                    row: histRow,
                                    cellRefRow: ref.refRow,
                                    changesJson: changes,
                                },
                            ],
                            (ok) => {
                                if (!ok)
                                    log("writeBatch failed for AI improvement");
                            },
                        );
                    }

                    if (settings.displayMode === "replace") {
                        replaceCellWithTranslation(
                            data.sheetName,
                            data.cellRef,
                            improvedText,
                            () => {},
                        );
                    }

                    sendToTranslationPanel("onAiImproveResult", {
                        success: true,
                    });
                    sendToTranslationPanel(
                        "onCellSelected",
                        buildCellPanelData(data.sheetName, data.cellRef, entry),
                    );
                })
                .catch((err) => {
                    log("AI improvement error: " + err.message);
                    sendToTranslationPanel("onAiImproveResult", {
                        success: false,
                        message: "AI error: " + err.message,
                    });
                });
        });

        // Relay events (callCommand not allowed in PluginWindow iframes)
        translationWindow.attachEvent("onDoWriteToSheet", () => {
            syncAllToDoc((ok) => {
                sendToTranslationPanel("onStatus", {
                    message: ok
                        ? "Cache saved to document"
                        : "Cache save failed",
                    type: ok ? "success" : "error",
                });
            });
        });

        translationWindow.attachEvent("onCloseTranslationPanel", () => {
            log("translation panel closed via ESC");
            if (translationWindow) {
                translationWindow.close();
                stopSelectionPolling();
                translationWindow = null;
            }
        });

        translationWindow.attachEvent("onClose", () => {
            log("translation panel closed");
            stopSelectionPolling();
            translationWindow = null;
        });

        translationWindow.show({
            url: "translation-view.html",
            description: "Translation",
            isVisual: true,
            isModal: false,
            buttons: [],
            EditorsSupport: ["cell"],
            size: [360, 400],
        });
    } catch (e) {
        log("openTranslationPanel ERROR: " + e.message);
    }
}

function sendToSyncPanel(event, data) {
    if (!syncWindow) return;
    syncWindow.command(event, data);
}

function openSyncPanel() {
    try {
        if (syncWindow) {
            syncWindow.show({
                url: "sync.html",
                description: "Sync Cache",
                isVisual: true,
                isModal: false,
                buttons: [],
                EditorsSupport: ["cell"],
                size: [300, 220],
            });
            return;
        }
        syncWindow = new window.Asc.PluginWindow();

        syncWindow.attachEvent("onSyncPanelReady", () => {
            log("sync panel ready");
        });

        syncWindow.attachEvent("onSyncSaveToDoc", () => {
            log("sync panel: save to doc");
            if (!ledger || Object.keys(ledger.entries).length === 0) {
                sendToSyncPanel("onSyncResult", {
                    message: "No cache to save",
                    type: "error",
                });
                return;
            }
            syncAllToDoc((ok) => {
                sendToSyncPanel("onSyncResult", {
                    message: ok ? "Cache saved to document" : "Save failed",
                    type: ok ? "success" : "error",
                });
            });
        });

        syncWindow.attachEvent("onSyncLoadFromDoc", () => {
            log("sync panel: load from doc");
            ledgerLoaded = false;
            loadLedger(() => {
                const entryCount = ledger
                    ? Object.keys(ledger.entries).length
                    : 0;
                log("sync load ok: " + entryCount + " ledger entries");
                sendToSyncPanel("onSyncResult", {
                    message: entryCount + " entries loaded from document",
                    type: "success",
                });
            });
        });

        syncWindow.attachEvent("onClose", () => {
            log("sync panel closed");
            syncWindow = null;
        });

        syncWindow.attachEvent("onCloseSyncPanel", () => {
            log("sync panel: auto-close after success");
            if (syncWindow) {
                syncWindow.close();
                syncWindow = null;
            }
        });

        syncWindow.show({
            url: "sync.html",
            description: "Sync Cache",
            isVisual: true,
            isModal: false,
            buttons: [],
            EditorsSupport: ["cell"],
            size: [300, 220],
        });
    } catch (e) {
        log("openSyncPanel ERROR: " + e.message);
    }
}

function openPanel() {
    try {
        panelMode = "main";
        ensurePanelWindow();
        pluginWindow.show({
            url: "panel.html",
            description: "Cell Translator",
            isVisual: true,
            isModal: false,
            buttons: [],
            EditorsSupport: ["cell"],
            size: [400, 600],
        });
    } catch (e) {
        log("openPanel ERROR: " + e.message);
    }
}

function openSettingsPanel() {
    try {
        panelMode = "settings";
        ensurePanelWindow();
        pluginWindow.show({
            url: "settings.html",
            description: "Cell Translator Settings",
            isVisual: true,
            isModal: false,
            buttons: [],
            EditorsSupport: ["cell"],
            size: [400, 500],
        });
    } catch (e) {
        log("openSettingsPanel ERROR: " + e.message);
    }
}

// --- One-time setup (runs at module load, before init) ---

let toolbarRegistered = false;

function registerToolbarOnce() {
    if (toolbarRegistered) return;
    toolbarRegistered = true;

    const mainBtn = new Asc.ButtonToolbar();
    mainBtn.text = "Cell Translator";

    const executeTranslationBtn = new Asc.ButtonToolbar(mainBtn);
    executeTranslationBtn.text = "Execute Translation";
    executeTranslationBtn.attachOnClick(() => {
        log("toolbar: execute translation");
        openPanel();
    });

    const syncBtn = new Asc.ButtonToolbar(mainBtn);
    syncBtn.text = "Sync";
    syncBtn.attachOnClick(() => {
        log("toolbar: sync");
        openSyncPanel();
    });

    const settingsBtn = new Asc.ButtonToolbar(mainBtn);
    settingsBtn.text = "Settings";
    settingsBtn.attachOnClick(() => {
        log("toolbar: settings");
        openSettingsPanel();
    });

    const historyBtn = new Asc.ButtonToolbar(mainBtn);
    historyBtn.text = "History";
    historyBtn.attachOnClick(() => {
        log("toolbar: history");
        openTranslationPanel();
        setTimeout(() => {
            sendToTranslationPanel("onShowHistory", { view: "document" });
        }, 500);
    });

    window.Asc.Buttons.registerToolbarMenu();

    Asc.plugin.attachEvent("onContextMenuShow", (_options) => {
        const items = {
            guid: window.Asc.plugin.guid,
            items: [
                {
                    id: "showTranslation",
                    text: "Translation",
                    data: "",
                    disabled: false,
                },
            ],
        };
        window.Asc.plugin.executeMethod("AddContextMenuItem", [items]);
    });

    Asc.plugin.attachContextMenuClickEvent("showTranslation", () => {
        log("context menu: show translation panel");
        openTranslationPanel();
    });

    Asc.plugin.attachEditorEvent("onDocumentContentReady", () => {
        log("event: onDocumentContentReady");
        onTrigger();
    });

    Asc.plugin.attachEditorEvent("onChangeCurrentSheet", () => {
        log("event: onChangeCurrentSheet");
        // Don't trigger background scan when Execute Translation panel is open.
        // The user is configuring settings — wait for them to click Execute.
        if (pluginWindow) {
            log("skipping scan — Execute Translation panel is open");
            return;
        }
        onTrigger();
    });

    log("toolbar and events registered");
}

// --- Plugin lifecycle ---

window.Asc.plugin.init = (_text) => {
    log("background watcher init");

    // Register toolbar/events only once (init may be called repeatedly)
    registerToolbarOnce();

    resolveDocId((docId) => {
        applyDocId(docId, () => {
            if (currentDocId) {
                loadLedger(() => {
                    log("ledger pre-loaded on init");
                });
            }
        });
    });
};

window.Asc.plugin.button = (id, windowId) => {
    if (windowId) {
        if (pluginWindow && windowId === pluginWindow.id && id < 0) {
            pluginWindow.close();
            pluginWindow = null;
            log("panel window closed via X");
        }
        if (translationWindow && windowId === translationWindow.id) {
            translationWindow.close();
            stopSelectionPolling();
            translationWindow = null;
            log("translation panel closed via X");
        }
        if (syncWindow && windowId === syncWindow.id) {
            syncWindow.close();
            syncWindow = null;
            log("sync panel closed via X");
        }
    }
};

export const Watcher = {
    onTrigger,
    openPanel,
    openSettingsPanel,
    openTranslationPanel,
    openSyncPanel,
    syncAllToDoc,
};
