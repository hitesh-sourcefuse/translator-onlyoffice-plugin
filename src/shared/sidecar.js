import { PluginLog } from "./pluginlog.js";

const HIDDEN_SHEET_NAME = "_CellTranslator";

// ── Utility helpers ──────────────────────────────────────────────────────

function resolveDocPath(fullName) {
    if (!fullName) return "temp";
    const lower = fullName.toLowerCase().replace(/\\/g, "/");
    if (
        lower.indexOf("/tmp/") !== -1 ||
        lower.indexOf("/temp/") !== -1 ||
        lower.indexOf("appdata/local/temp") !== -1 ||
        lower.indexOf("var/folders") !== -1
    ) {
        return "temp";
    }
    return fullName;
}

// Strip common OS version suffixes to get base name for comparison
// e.g. "report (1).xlsx" → "report.xlsx"
//      "report_1.xlsx"   → "report.xlsx"
function stripVersionSuffix(filename) {
    const dotIdx = filename.lastIndexOf(".");
    const ext = dotIdx !== -1 ? filename.slice(dotIdx) : "";
    let base = dotIdx !== -1 ? filename.slice(0, dotIdx) : filename;
    base = base.replace(/\s*[([]\d+[)\]]\s*$/, "");
    base = base.replace(/_\d+$/, "");
    base = base.replace(/\s*-\s*(copy|backup|new)\s*$/i, "");
    return base.trim() + ext;
}

// Returns: "same" | "renamed" | "versioned" | "unrelated"
function detectFileRename(currentPath, storedPath) {
    if (!currentPath || !storedPath) return "unrelated";
    if (currentPath === storedPath) return "same";
    const currentFile = currentPath.replace(/\\/g, "/").split("/").pop();
    const storedFile = storedPath.replace(/\\/g, "/").split("/").pop();
    if (stripVersionSuffix(currentFile) === stripVersionSuffix(storedFile)) {
        return "versioned";
    }
    if (currentFile === storedFile) return "renamed";
    return "unrelated";
}

// Generates "Sheet1!$A$1" style keys
function rowKey(sheetName, cellRef) {
    return sheetName + "!" + cellRef;
}

// ── Sheet management ─────────────────────────────────────────────────────

// Check if _CellTranslator sheet exists (read-only, no creation). callback(true/false)
function checkSheetExists(callback) {
    PluginLog.log("SIDECAR", "checkSheetExists");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    return true;
                }
            }
            return false;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "checkSheetExists: " + (result ? "found" : "not found"),
            );
            callback(!!result);
        },
    );
}

// Find _CellTranslator sheet; create if missing. Set invisible. callback(ok)
function ensureSheet(callback) {
    PluginLog.log("SIDECAR", "ensureSheet");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) {
                Api.AddSheet(Asc.scope.hiddenSheetName);
                target = Api.GetActiveSheet();
                if (!target) return false;
            }
            target.SetVisible(false);
            return true;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "ensureSheet: " + (result ? "ok" : "failed"),
            );
            callback(!!result);
        },
    );
}

// Read A1: "{" → "legacy", "Checksum" → "v3", empty → "empty". callback(status)
function detectVersion(callback) {
    PluginLog.log("SIDECAR", "detectVersion");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return "empty";
            const val = target.GetRange("A1").GetValue();
            if (!val || val === "") return "empty";
            if (val.charAt(0) === "{") return "legacy";
            if (val === "Checksum") return "v3";
            return "empty";
        },
        false,
        false,
        (status) => {
            PluginLog.log("SIDECAR", "detectVersion: " + status);
            callback(status || "empty");
        },
    );
}

// Write V3 headers to row 1. callback(ok)
function writeHeaders(callback) {
    PluginLog.log("SIDECAR", "writeHeaders");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return false;
            // Ledger section (A–D)
            target.GetRange("A1").SetValue("Checksum");
            target.GetRange("B1").SetValue("Source");
            target.GetRange("C1").SetValue("Translation");
            target.GetRange("D1").SetValue("AltIndex");
            // Cell Refs section (E–G)
            target.GetRange("E1").SetValue("Sheet");
            target.GetRange("F1").SetValue("CellRef");
            target.GetRange("G1").SetValue("Ledger Row");
            // H: empty separator
            // History section (I–J)
            target.GetRange("I1").SetValue("Cell Ref Row");
            target.GetRange("J1").SetValue("Changes");
            return true;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "writeHeaders: " + (result ? "ok" : "failed"),
            );
            callback(!!result);
        },
    );
}

// ── Read functions ───────────────────────────────────────────────────────

// Read ledger section (A–C, rows 2+).
// Returns: { entries: { checksum: { row, source, translation } }, nextRow, gaps }
function readLedger(callback) {
    PluginLog.log("SIDECAR", "readLedger");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { entries: {}, nextRow: 2 };

            const usedRange = target.GetUsedRange();
            if (!usedRange) return { entries: {}, nextRow: 2 };

            const addr = usedRange.GetAddress(true, true, "xlA1", false);
            const lastMatch = addr.match(/\$[A-Z]+\$(\d+)$/);
            const lastRow = lastMatch ? parseInt(lastMatch[1], 10) : 1;
            if (lastRow < 2) return { entries: {}, nextRow: 2 };

            // Collect A–D cell values by row number
            const rowData = {};
            target.GetRange("A2:D" + lastRow).ForEach((cell) => {
                const cellAddr = cell.GetAddress(true, true, "xlA1", false);
                const m = cellAddr.match(/\$([A-Z]+)\$(\d+)/);
                if (!m) return;
                const col = m[1];
                const row = parseInt(m[2], 10);
                if (!rowData[row]) rowData[row] = {};
                rowData[row][col] = cell.GetValue();
            });

            // A blank row is a gap left by a failed write, not the end of the
            // data. Scanning the whole used range keeps rows after a gap
            // reachable; nextRow comes from the last populated row.
            const entries = {};
            let lastLedgerRow = 1;
            let filled = 0;
            for (let r = 2; r <= lastRow; r++) {
                const aVal = rowData[r] ? rowData[r].A : null;
                if (!aVal || aVal === "") continue;
                const entryObj = {
                    row: r,
                    source: rowData[r].B || "",
                    translation: rowData[r].C || "",
                };
                const dVal = rowData[r].D;
                if (dVal && dVal !== "" && dVal !== "0") {
                    entryObj._alternativeIndex = parseInt(dVal, 10);
                }
                entries[aVal] = entryObj;
                lastLedgerRow = r;
                filled++;
            }
            const gaps = lastLedgerRow > 1 ? lastLedgerRow - 1 - filled : 0;

            return {
                entries: entries,
                nextRow: lastLedgerRow + 1,
                gaps: gaps,
            };
        },
        false,
        false,
        (result) => {
            const count = result ? Object.keys(result.entries).length : 0;
            const gaps = result ? result.gaps || 0 : 0;
            PluginLog.log(
                "SIDECAR",
                "readLedger: " +
                    count +
                    " entries, nextRow=" +
                    (result ? result.nextRow : "?") +
                    (gaps > 0 ? ", " + gaps + " gap row(s) skipped" : ""),
            );
            callback(result || { entries: {}, nextRow: 2, gaps: 0 });
        },
    );
}

// Read cell refs section (E–G, rows 2+).
// Returns: { refs: { "Sheet1!$A$1": { refRow, ledgerRow } }, nextRow, gaps }
function readRefs(callback) {
    PluginLog.log("SIDECAR", "readRefs");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { refs: {}, nextRow: 2 };

            const usedRange = target.GetUsedRange();
            if (!usedRange) return { refs: {}, nextRow: 2 };

            const addr = usedRange.GetAddress(true, true, "xlA1", false);
            const lastMatch = addr.match(/\$[A-Z]+\$(\d+)$/);
            const lastRow = lastMatch ? parseInt(lastMatch[1], 10) : 1;
            if (lastRow < 2) return { refs: {}, nextRow: 2 };

            // Collect E–G cell values by row number
            const rowData = {};
            target.GetRange("E2:G" + lastRow).ForEach((cell) => {
                const cellAddr = cell.GetAddress(true, true, "xlA1", false);
                const m = cellAddr.match(/\$([A-Z]+)\$(\d+)/);
                if (!m) return;
                const col = m[1];
                const row = parseInt(m[2], 10);
                if (!rowData[row]) rowData[row] = {};
                rowData[row][col] = cell.GetValue();
            });

            // Gap-tolerant for the same reason as readLedger.
            const refs = {};
            let lastRefRow = 1;
            let filled = 0;
            for (let r = 2; r <= lastRow; r++) {
                const eVal = rowData[r] ? rowData[r].E : null;
                if (!eVal || eVal === "") continue;
                const fVal = rowData[r].F || "";
                const key = eVal + "!" + fVal;
                refs[key] = {
                    refRow: r,
                    ledgerRow: parseInt(rowData[r].G || "0", 10),
                };
                lastRefRow = r;
                filled++;
            }
            const gaps = lastRefRow > 1 ? lastRefRow - 1 - filled : 0;

            return { refs: refs, nextRow: lastRefRow + 1, gaps: gaps };
        },
        false,
        false,
        (result) => {
            const count = result ? Object.keys(result.refs).length : 0;
            const gaps = result ? result.gaps || 0 : 0;
            PluginLog.log(
                "SIDECAR",
                "readRefs: " +
                    count +
                    " refs, nextRow=" +
                    (result ? result.nextRow : "?") +
                    (gaps > 0 ? ", " + gaps + " gap row(s) skipped" : ""),
            );
            callback(result || { refs: {}, nextRow: 2, gaps: 0 });
        },
    );
}

// Read history section (I–J, rows 2+).
// Returns: { entries: [{ row, cellRefRow, changes }], nextRow }
function readHistory(callback) {
    PluginLog.log("SIDECAR", "readHistory");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { entries: [], nextRow: 2 };

            const usedRange = target.GetUsedRange();
            if (!usedRange) return { entries: [], nextRow: 2 };

            const addr = usedRange.GetAddress(true, true, "xlA1", false);
            const lastMatch = addr.match(/\$[A-Z]+\$(\d+)$/);
            const lastRow = lastMatch ? parseInt(lastMatch[1], 10) : 1;
            if (lastRow < 2) return { entries: [], nextRow: 2 };

            // Collect I–J cell values by row number
            const rowData = {};
            target.GetRange("I2:J" + lastRow).ForEach((cell) => {
                const cellAddr = cell.GetAddress(true, true, "xlA1", false);
                const m = cellAddr.match(/\$([A-Z]+)\$(\d+)/);
                if (!m) return;
                const col = m[1];
                const row = parseInt(m[2], 10);
                if (!rowData[row]) rowData[row] = {};
                rowData[row][col] = cell.GetValue();
            });

            // History may be sparse — collect all rows that have an I value
            const entries = [];
            let lastHistoryRow = 1;
            for (let r = 2; r <= lastRow; r++) {
                const iVal = rowData[r] ? rowData[r].I : null;
                if (iVal && iVal !== "") {
                    entries.push({
                        row: r,
                        cellRefRow: parseInt(iVal, 10),
                        changes: rowData[r].J || "",
                    });
                    lastHistoryRow = r;
                }
            }

            return { entries: entries, nextRow: lastHistoryRow + 1 };
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "readHistory: " +
                    (result ? result.entries.length : 0) +
                    " entries",
            );
            callback(result || { entries: [], nextRow: 2 });
        },
    );
}

// ── Write functions ──────────────────────────────────────────────────────

// Batch write multiple rows in ONE callCommand for efficiency.
// ledgerRows:  [{ row, checksum, source, translation }]
// refRows:     [{ row, sheetName, cellRef, ledgerRow }]
// historyRows: [{ row, cellRefRow, changesJson }]
// callback(ok)
function writeBatch(ledgerRows, refRows, historyRows, callback) {
    PluginLog.log(
        "SIDECAR",
        "writeBatch ledger=" +
            ledgerRows.length +
            " refs=" +
            refRows.length +
            " history=" +
            historyRows.length,
    );
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;
    Asc.scope.bLedgerRows = ledgerRows;
    Asc.scope.bRefRows = refRows;
    Asc.scope.bHistoryRows = historyRows;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let si = 0; si < sheets.length; si++) {
                if (sheets[si].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[si];
                    break;
                }
            }
            if (!target) return false;

            const lr = Asc.scope.bLedgerRows;
            for (let li = 0; li < lr.length; li++) {
                const l = lr[li];
                target.GetRange("A" + l.row).SetValue(l.checksum);
                target.GetRange("B" + l.row).SetValue(l.source);
                target.GetRange("C" + l.row).SetValue(l.translation);
                target
                    .GetRange("D" + l.row)
                    .SetValue(l.altIndex != null ? String(l.altIndex) : "");
            }

            const rr = Asc.scope.bRefRows;
            for (let ri = 0; ri < rr.length; ri++) {
                const r = rr[ri];
                target.GetRange("E" + r.row).SetValue(r.sheetName);
                target.GetRange("F" + r.row).SetValue(r.cellRef);
                target.GetRange("G" + r.row).SetValue(String(r.ledgerRow));
            }

            const hr = Asc.scope.bHistoryRows;
            for (let hi = 0; hi < hr.length; hi++) {
                const h = hr[hi];
                target.GetRange("I" + h.row).SetValue(String(h.cellRefRow));
                target.GetRange("J" + h.row).SetValue(h.changesJson);
            }

            return true;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "writeBatch: " + (result ? "ok" : "failed"),
            );
            if (callback) callback(!!result);
        },
    );
}

// Clear all data from _CellTranslator sheet. callback(ok)
function clearSheet(callback) {
    PluginLog.log("SIDECAR", "clearSheet");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return false;
            const usedRange = target.GetUsedRange();
            if (usedRange) {
                usedRange.ClearAll();
            }
            return true;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "clearSheet: " + (result ? "ok" : "failed"),
            );
            if (callback) callback(!!result);
        },
    );
}

// Clear each section's rows below the last row that was just written, so a
// rewrite that shrank a section leaves no stale tail behind. Unlike clearSheet
// this never touches rows that still hold live data. callback(ok)
function clearTrailingRows(ledgerFrom, refsFrom, historyFrom, callback) {
    PluginLog.log(
        "SIDECAR",
        "clearTrailingRows ledger=" +
            ledgerFrom +
            " refs=" +
            refsFrom +
            " history=" +
            historyFrom,
    );
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;
    Asc.scope.tLedgerFrom = ledgerFrom;
    Asc.scope.tRefsFrom = refsFrom;
    Asc.scope.tHistoryFrom = historyFrom;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.hiddenSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return false;

            const usedRange = target.GetUsedRange();
            if (!usedRange) return true;
            const addr = usedRange.GetAddress(true, true, "xlA1", false);
            const lastMatch = addr.match(/\$[A-Z]+\$(\d+)$/);
            const lastRow = lastMatch ? parseInt(lastMatch[1], 10) : 1;

            const sections = [
                { cols: "A", cole: "D", from: Asc.scope.tLedgerFrom },
                { cols: "E", cole: "G", from: Asc.scope.tRefsFrom },
                { cols: "I", cole: "J", from: Asc.scope.tHistoryFrom },
            ];
            for (let s = 0; s < sections.length; s++) {
                const sec = sections[s];
                if (sec.from < 2 || sec.from > lastRow) continue;
                target
                    .GetRange(sec.cols + sec.from + ":" + sec.cole + lastRow)
                    .ClearAll();
            }
            return true;
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "clearTrailingRows: " + (result ? "ok" : "failed"),
            );
            if (callback) callback(!!result);
        },
    );
}

// ── Sheet introspection ──────────────────────────────────────────────────

// Get all sheet names, excluding _CellTranslator. callback(["Sheet1", ...])
function getAllSheetNames(callback) {
    PluginLog.log("SIDECAR", "getAllSheetNames");
    Asc.scope.hiddenSheetName = HIDDEN_SHEET_NAME;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            const names = [];
            for (let i = 0; i < sheets.length; i++) {
                const name = sheets[i].GetName();
                if (name !== Asc.scope.hiddenSheetName) {
                    names.push(name);
                }
            }
            return names;
        },
        false,
        false,
        (names) => {
            PluginLog.log(
                "SIDECAR",
                "getAllSheetNames: " + (names ? names.length : 0) + " sheets",
            );
            callback(names || []);
        },
    );
}

// Get used-range dimensions for a sheet.
// If sheetName is null, uses active sheet.
// callback({ sheetName, lastRow, startRow, startCol, endCol, startColLetter, endColLetter })
function getSheetDimensions(sheetName, callback) {
    PluginLog.log("SIDECAR", "getSheetDimensions: " + sheetName);
    Asc.scope.targetSheetName = sheetName;

    window.Asc.plugin.callCommand(
        () => {
            let sheet;
            if (!Asc.scope.targetSheetName) {
                sheet = Api.GetActiveSheet();
            } else {
                const sheets = Api.GetSheets();
                for (let i = 0; i < sheets.length; i++) {
                    if (sheets[i].GetName() === Asc.scope.targetSheetName) {
                        sheet = sheets[i];
                        break;
                    }
                }
            }
            if (!sheet) return null;

            const usedRange = sheet.GetUsedRange();
            if (!usedRange) return null;

            // addr like "$A$1:$Z$500"
            const addr = usedRange.GetAddress(true, true, "xlA1", false);
            const m = addr.match(/\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+)/);
            if (!m) return null;

            const startColLetter = m[1];
            const startRow = parseInt(m[2], 10);
            const endColLetter = m[3];
            const lastRow = parseInt(m[4], 10);

            // Convert column letter(s) to 0-based index
            function letterToIndex(s) {
                let idx = 0;
                for (let ci = 0; ci < s.length; ci++) {
                    idx = idx * 26 + (s.charCodeAt(ci) - 64);
                }
                return idx - 1;
            }

            return {
                sheetName: sheet.GetName(),
                lastRow: lastRow,
                startRow: startRow,
                startCol: letterToIndex(startColLetter),
                endCol: letterToIndex(endColLetter),
                startColLetter: startColLetter,
                endColLetter: endColLetter,
            };
        },
        false,
        false,
        (dims) => {
            PluginLog.log(
                "SIDECAR",
                "getSheetDimensions: " + JSON.stringify(dims),
            );
            callback(dims);
        },
    );
}

// Read a batch of cells from a sheet range.
// Returns raw non-empty cells: { cells: [{ cellRef, value }], readCount: N }
function readCellBatch(
    sheetName,
    startRow,
    endRow,
    startColLetter,
    endColLetter,
    callback,
) {
    PluginLog.log(
        "SIDECAR",
        "readCellBatch: " +
            sheetName +
            " rows " +
            startRow +
            "-" +
            endRow +
            " cols " +
            startColLetter +
            "-" +
            endColLetter,
    );
    Asc.scope.rcbSheetName = sheetName;
    Asc.scope.rcbStartRow = startRow;
    Asc.scope.rcbEndRow = endRow;
    Asc.scope.rcbStartCol = startColLetter;
    Asc.scope.rcbEndCol = endColLetter;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.rcbSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { cells: [], readCount: 0 };

            // Range notation: e.g. "A$2:Z$101"
            const rangeAddr =
                Asc.scope.rcbStartCol +
                "$" +
                Asc.scope.rcbStartRow +
                ":" +
                Asc.scope.rcbEndCol +
                "$" +
                Asc.scope.rcbEndRow;
            const range = target.GetRange(rangeAddr);
            const cells = [];
            range.ForEach((cell) => {
                const val = cell.GetValue();
                if (val !== null && val !== undefined && val !== "") {
                    const cellRef = cell.GetAddress(true, true, "xlA1", false);
                    cells.push({ cellRef: cellRef, value: val });
                }
            });
            return { cells: cells, readCount: cells.length };
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "readCellBatch: " + (result ? result.readCount : 0) + " cells",
            );
            callback(result || { cells: [], readCount: 0 });
        },
    );
}

// ── Drawn shapes ─────────────────────────────────────────────────────────
//
// Shape text is addressed as "shape:<id>#p<paragraphIndex>", where <id> is
// "n:<name>" when the shape carries a name and "i:<index>" otherwise. Shapes
// get an editor-assigned name ("Line Callout 1 1") by default, so the index
// fallback is rare; naming an unnamed shape ourselves would write into the
// user's document, so index stays the honest fallback.
//
// Each paragraph is a separate translatable unit so its own formatting can be
// preserved when the translation is written back.
//
// The callCommand body is serialised and eval'd inside the editor: it captures
// nothing from this module and has no Function constructor. The shape locator
// is therefore duplicated inline in both functions below — keep the two copies
// identical or a shape will be written under a different id than it was read
// with.

// Returns { shapes: [{ cellRef, value }], readCount, api, drawings, skipped }.
// Each entry is one paragraph of one shape; images and charts are skipped.
function readShapeTexts(sheetName, callback) {
    PluginLog.log("SIDECAR", "readShapeTexts: " + sheetName);
    Asc.scope.shpSheetName = sheetName;

    window.Asc.plugin.callCommand(
        () => {
            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.shpSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) {
                return { shapes: [], readCount: 0, api: "no sheet" };
            }

            let all = [];
            let api = "none";
            try {
                if (target.GetAllShapes) {
                    all = target.GetAllShapes() || [];
                    api = "GetAllShapes";
                } else if (target.GetAllDrawings) {
                    all = target.GetAllDrawings() || [];
                    api = "GetAllDrawings";
                }
            } catch (e) {
                return {
                    shapes: [],
                    readCount: 0,
                    api: api,
                    error: String(e),
                };
            }

            const out = [];
            let skipped = 0;
            for (let s = 0; s < all.length; s++) {
                const shape = all[s];
                try {
                    if (
                        shape.GetClassType &&
                        shape.GetClassType() !== "shape"
                    ) {
                        skipped++;
                        continue;
                    }
                    if (!shape.GetContent) {
                        skipped++;
                        continue;
                    }
                    const content = shape.GetContent();
                    if (!content?.GetElementsCount) {
                        skipped++;
                        continue;
                    }

                    let name = "";
                    try {
                        if (shape.GetName) name = shape.GetName() || "";
                    } catch (_e) {
                        name = "";
                    }
                    const id = name ? "n:" + name : "i:" + s;

                    const count = content.GetElementsCount();
                    for (let p = 0; p < count; p++) {
                        const para = content.GetElement(p);
                        if (!para?.GetText) continue;
                        // GetText returns the paragraph mark too ("text\r\n").
                        // That is structure, not content — translating it would
                        // send trailing whitespace to the engine and write it
                        // back into the shape.
                        const text = (para.GetText() || "").replace(
                            /[\r\n]+$/,
                            "",
                        );
                        if (text === "") continue;
                        out.push({
                            cellRef: "shape:" + id + "#p" + p,
                            value: text,
                        });
                    }
                } catch (_e) {
                    // A drawing that is not a text shape — skip it rather than
                    // aborting the whole sheet.
                    skipped++;
                }
            }
            return {
                shapes: out,
                readCount: out.length,
                api: api,
                drawings: all.length,
                skipped: skipped,
            };
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "readShapeTexts: " +
                    (result ? result.readCount : 0) +
                    " paragraph(s) via " +
                    (result?.api || "callCommand failed") +
                    ", drawings=" +
                    (result?.drawings ?? "?") +
                    ", skipped=" +
                    (result?.skipped ?? "?") +
                    (result?.error ? " error=" + result.error : ""),
            );
            callback(result || { shapes: [], readCount: 0 });
        },
    );
}

// Read the text of one shape paragraph addressed as "shape:<id>#p<n>".
// callback(text|null)
function readShapeParagraph(sheetName, shapeRef, callback) {
    Asc.scope.rspSheetName = sheetName;
    Asc.scope.rspRef = shapeRef;

    window.Asc.plugin.callCommand(
        () => {
            const parsed = /^shape:(.+)#p(\d+)$/.exec(Asc.scope.rspRef);
            if (!parsed) return { text: null };
            const wantId = parsed[1];
            const paraIndex = parseInt(parsed[2], 10);

            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.rspSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { text: null };

            let all = [];
            try {
                if (target.GetAllShapes) {
                    all = target.GetAllShapes() || [];
                } else if (target.GetAllDrawings) {
                    all = target.GetAllDrawings() || [];
                }
            } catch (_e) {
                return { text: null };
            }

            // Same locator as readShapeTexts — see the note above.
            for (let s = 0; s < all.length; s++) {
                try {
                    let name = "";
                    try {
                        if (all[s].GetName) name = all[s].GetName() || "";
                    } catch (_e) {
                        name = "";
                    }
                    if ((name ? "n:" + name : "i:" + s) !== wantId) continue;

                    const content = all[s].GetContent();
                    if (!content || paraIndex >= content.GetElementsCount()) {
                        return { text: null };
                    }
                    const para = content.GetElement(paraIndex);
                    const text = (para?.GetText() || "").replace(
                        /[\r\n]+$/,
                        "",
                    );
                    return { text: text };
                } catch (_e) {
                    /* skip undrawable entries */
                }
            }
            return { text: null };
        },
        false,
        false,
        (result) => {
            callback(result?.text || null);
        },
    );
}

// Write one translated paragraph back into a shape, keeping that paragraph's
// leading run formatting. callback(ok)
function writeShapeParagraph(sheetName, shapeRef, text, callback) {
    Asc.scope.wspSheetName = sheetName;
    Asc.scope.wspRef = shapeRef;
    Asc.scope.wspText = text;

    window.Asc.plugin.callCommand(
        () => {
            const parsed = /^shape:(.+)#p(\d+)$/.exec(Asc.scope.wspRef);
            if (!parsed) return { ok: false, reason: "bad ref" };
            const wantId = parsed[1];
            const paraIndex = parseInt(parsed[2], 10);

            const sheets = Api.GetSheets();
            let target = null;
            for (let i = 0; i < sheets.length; i++) {
                if (sheets[i].GetName() === Asc.scope.wspSheetName) {
                    target = sheets[i];
                    break;
                }
            }
            if (!target) return { ok: false, reason: "no sheet" };

            let all = [];
            try {
                if (target.GetAllShapes) {
                    all = target.GetAllShapes() || [];
                } else if (target.GetAllDrawings) {
                    all = target.GetAllDrawings() || [];
                }
            } catch (_e) {
                return { ok: false, reason: "no shapes" };
            }

            // Same locator as readShapeTexts — see the note above.
            let shape = null;
            for (let s = 0; s < all.length; s++) {
                try {
                    let name = "";
                    try {
                        if (all[s].GetName) name = all[s].GetName() || "";
                    } catch (_e) {
                        name = "";
                    }
                    if ((name ? "n:" + name : "i:" + s) === wantId) {
                        shape = all[s];
                        break;
                    }
                } catch (_e) {
                    /* skip undrawable entries */
                }
            }
            if (!shape) return { ok: false, reason: "shape not found" };

            try {
                const content = shape.GetContent();
                if (!content || paraIndex >= content.GetElementsCount()) {
                    return { ok: false, reason: "no paragraph" };
                }
                const para = content.GetElement(paraIndex);

                // Capture the paragraph's formatting before clearing so the
                // rewritten text keeps its look.
                let textPr = null;
                try {
                    if (para.GetTextPr) textPr = para.GetTextPr();
                } catch (_e) {
                    textPr = null;
                }

                para.RemoveAllElements();
                const run = para.AddText(Asc.scope.wspText);
                if (textPr) {
                    try {
                        if (run?.SetTextPr) run.SetTextPr(textPr);
                        else if (para.SetTextPr) para.SetTextPr(textPr);
                    } catch (_e) {
                        /* formatting is best-effort */
                    }
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: String(e) };
            }
        },
        false,
        false,
        (result) => {
            PluginLog.log(
                "SIDECAR",
                "writeShapeParagraph " +
                    shapeRef +
                    ": " +
                    (result?.ok ? "ok" : "failed " + (result?.reason || "")),
            );
            if (callback) callback(!!result?.ok);
        },
    );
}

// ── Public API ───────────────────────────────────────────────────────────

export const Sidecar = {
    checkSheetExists,
    ensureSheet,
    detectVersion,
    writeHeaders,
    readLedger,
    readRefs,
    readHistory,
    writeBatch,
    clearSheet,
    clearTrailingRows,
    getAllSheetNames,
    getSheetDimensions,
    readCellBatch,
    readShapeParagraph,
    readShapeTexts,
    writeShapeParagraph,
    resolveDocPath,
    detectFileRename,
    stripVersionSuffix,
    rowKey,
    HIDDEN_SHEET_NAME,
};
