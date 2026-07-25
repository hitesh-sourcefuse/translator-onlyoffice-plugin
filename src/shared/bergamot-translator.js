/**
 * Bergamot offline translation engine.
 *
 * - Registry JSON:  fetched at runtime via AscSimpleRequest (no CORS)
 * - Model binaries:  cached in IndexedDB (compressed gzip)
 *                    → first load: DownloadFiles from GCS CDN → store in IDB
 *                    → subsequent: read from IDB, skip network
 * - Decompression:   always done at runtime from the cached compressed data
 */

import { PluginLog } from "./pluginlog.js";

const TRANSLATOR_MODULE_URL = "../vendor/bergamot/translator.js";
const MODELS_REGISTRY_URL =
    "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";

const IDB_NAME = "BergamotModelCache";
const IDB_STORE = "models";
const IDB_VERSION = 1;

// 2GB keeps a handful of model pairs cached without unbounded growth
const IDB_CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

const TAG = "BERGAMOT";
let instance = null;

function log(msg) {
    PluginLog.log(TAG, msg);
}

// ---------------------------------------------------------------------------
// IndexedDB cache — stores compressed (gzip) ArrayBuffers keyed by URL
// ---------------------------------------------------------------------------

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

/** Get a cached ArrayBuffer by key. Returns null on miss. */
async function cacheGet(key) {
    try {
        const db = await openDB();
        const entry = await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = (e) => {
                log("cacheGet error: " + e.target.error);
                resolve(null);
            };
            tx.oncomplete = () => db.close();
        });
        if (entry) touchLastUsed(key, entry);
        return entry ? entry.data : null;
    } catch (e) {
        log("cacheGet error: " + e.message);
        return null;
    }
}

/** Fire-and-forget update of an entry's lastUsed timestamp on read. */
function touchLastUsed(key, entry) {
    openDB()
        .then((db) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(
                { data: entry.data, lastUsed: Date.now(), size: entry.size },
                key,
            );
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
        })
        .catch(() => {});
}

/** Store an ArrayBuffer in cache, then evict LRU entries if over cap. */
async function cachePut(key, buffer) {
    try {
        const db = await openDB();
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(
                { data: buffer, lastUsed: Date.now(), size: buffer.byteLength },
                key,
            );
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = (e) => {
                log("cachePut error: " + e.target.error);
                db.close();
                resolve();
            };
        });
        await evictIfOverCap();
    } catch (e) {
        log("cachePut error: " + e.message);
    }
}

/** Read {key, size, lastUsed} for every cached entry. */
async function getAllCacheEntries() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const results = [];
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    results.push({
                        key: cursor.key,
                        size: cursor.value.size || cursor.value.byteLength || 0,
                        lastUsed: cursor.value.lastUsed || 0,
                    });
                    cursor.continue();
                }
            };
            req.onerror = () => resolve([]);
            tx.oncomplete = () => {
                db.close();
                resolve(results);
            };
        });
    } catch (e) {
        log("getAllCacheEntries error: " + e.message);
        return [];
    }
}

/** Evict least-recently-used entries until total cache size is under cap. */
async function evictIfOverCap() {
    const entries = await getAllCacheEntries();
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= IDB_CACHE_CAP_BYTES) return;
    const sorted = entries.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of sorted) {
        if (total <= IDB_CACHE_CAP_BYTES) break;
        await deleteCachedModel(entry.key);
        total -= entry.size;
        log("evicted (LRU cache cap): " + entry.key.split("/").pop());
    }
}

/** Report current cache usage vs cap, for UI display. */
async function getCacheUsage() {
    const entries = await getAllCacheEntries();
    const usedBytes = entries.reduce((sum, e) => sum + e.size, 0);
    return { usedBytes, capBytes: IDB_CACHE_CAP_BYTES };
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/** Fetch JSON via AscSimpleRequest (no CORS) with fetch() fallback. */
function fetchJSON(url) {
    if (window.AscSimpleRequest?.createRequest) {
        log("fetchJSON via AscSimpleRequest: " + url.split("/").pop());
        return new Promise((resolve, reject) => {
            window.AscSimpleRequest.createRequest({
                url: url,
                method: "GET",
                complete: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        log("fetchJSON OK via AscSimpleRequest");
                        resolve(data);
                    } catch (err) {
                        reject(new Error("JSON parse error: " + err.message));
                    }
                },
                error: (err) => {
                    reject(
                        new Error(
                            "AscSimpleRequest failed: HTTP " +
                                (err.statusCode || "unknown"),
                        ),
                    );
                },
            });
        });
    }

    log("fetchJSON via fetch fallback: " + url.split("/").pop());
    return fetch(url).then((r) => {
        if (!r.ok) throw new Error("fetchJSON HTTP " + r.status);
        return r.json();
    });
}

/** Current quality preference — set from settings before getTranslator() */
let qualityPreference = "base-memory";

function pickBestVariant(variants, preferredQuality) {
    const quality = preferredQuality || qualityPreference;
    const released = variants.filter(
        (v) => v.releaseStatus && v.releaseStatus !== "Nightly",
    );
    const pool = released.length > 0 ? released : variants;
    // Try preferred quality first
    const preferred = pool.find((v) => v.architecture === quality);
    if (preferred) return preferred;
    // Fallback order
    for (const arch of ["base-memory", "base", "tiny"]) {
        const match = pool.find((v) => v.architecture === arch);
        if (match) return match;
    }
    return pool[0];
}

/**
 * Fetch and parse the Mozilla registry. Returns the raw registry object.
 * Cached after first call.
 */
let registryCache = null;
async function fetchRegistry() {
    if (registryCache) return registryCache;
    registryCache = await fetchJSON(MODELS_REGISTRY_URL);
    return registryCache;
}

/**
 * Get available language pairs with their quality variants from the registry.
 * Returns { pairs: [{from, to, variants: ["tiny","base-memory","base"]}], languages: ["ja","en",...] }
 */
async function getAvailableModels() {
    const data = await fetchRegistry();
    const pairs = [];
    const langSet = new Set();
    for (const [key, variants] of Object.entries(data.models || {})) {
        const parts = key.split("-");
        if (parts.length < 2) continue;
        const from = parts[0];
        const to = parts.slice(1).join("-");
        langSet.add(from);
        langSet.add(to);
        const archs = variants.map((v) => v.architecture).filter(Boolean);
        pairs.push({ from, to, variants: archs });
    }
    return { pairs, languages: Array.from(langSet).sort() };
}

async function decompressGzip(buffer) {
    const inKB = (buffer.byteLength / 1024).toFixed(0);
    log("decompress: " + inKB + "KB compressed");
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buffer));
    writer.close();
    const result = await new Response(ds.readable).arrayBuffer();
    log(
        "decompress: " +
            inKB +
            "KB → " +
            (result.byteLength / 1024).toFixed(0) +
            "KB",
    );
    return result;
}

/**
 * Download multiple URLs as ArrayBuffers, using IndexedDB cache.
 * Returns Map<url, ArrayBuffer> with compressed data.
 *
 * - Cache hit:  read from IndexedDB (instant)
 * - Cache miss: download via DownloadFiles (or XHR), then store in IDB
 */
async function fetchBinaryBatch(urls, signal) {
    const results = new Map();
    const misses = [];

    // Check cache for each URL
    for (const url of urls) {
        const cached = await cacheGet(url);
        if (cached) {
            const name = url.split("/").pop();
            log(
                "  cache HIT: " +
                    name +
                    " (" +
                    (cached.byteLength / 1024).toFixed(0) +
                    "KB)",
            );
            results.set(url, cached);
        } else {
            misses.push(url);
        }
    }

    if (misses.length === 0) {
        log("all " + urls.length + " files from cache");
        return results;
    }

    log(misses.length + " cache misses, downloading...");

    // Download missing files
    const downloaded = await downloadBatch(misses, signal);

    // Store in cache and merge into results
    for (const url of misses) {
        const buf = downloaded.get(url);
        if (buf) {
            results.set(url, buf);
            const name = url.split("/").pop();
            log(
                "  caching: " +
                    name +
                    " (" +
                    (buf.byteLength / 1024).toFixed(0) +
                    "KB)",
            );
            await cachePut(url, buf);
        }
    }

    return results;
}

/** Download files via DownloadFiles (Desktop) or XHR (fallback). No caching. */
function downloadBatch(urls, signal) {
    if (window.AscDesktopEditor?.DownloadFiles) {
        log("batch download via DownloadFiles: " + urls.length + " files");
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error("Download aborted"));
                return;
            }
            const onAbort = () => reject(new Error("Download aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            window.AscDesktopEditor.DownloadFiles(urls, [], (files) => {
                signal?.removeEventListener("abort", onAbort);
                log(
                    "DownloadFiles callback: " +
                        Object.keys(files).length +
                        " files",
                );
                const results = new Map();
                const reads = [];
                for (const url of urls) {
                    const localPath = files[url];
                    if (!localPath) {
                        log("  NO path for " + url.split("/").pop());
                        reject(
                            new Error(
                                "DownloadFiles: no path for " +
                                    url.split("/").pop(),
                            ),
                        );
                        return;
                    }
                    log(
                        "  " +
                            url.split("/").pop() +
                            " → " +
                            localPath.split("/").pop(),
                    );
                    reads.push(
                        readLocalFile(localPath, signal).then((buf) =>
                            results.set(url, buf),
                        ),
                    );
                }
                Promise.all(reads)
                    .then(() => resolve(results))
                    .catch(reject);
            });
        });
    }

    log("batch download via XHR fallback: " + urls.length + " files");
    const results = new Map();
    return Promise.all(
        urls.map((url) =>
            fetchBinaryXHR(url, signal).then((buf) => results.set(url, buf)),
        ),
    ).then(() => results);
}

function readLocalFile(localPath, signal) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", localPath, true);
        xhr.responseType = "arraybuffer";
        if (signal) {
            if (signal.aborted) {
                reject(new Error("Read aborted"));
                return;
            }
            signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.onload = () => {
            const bytes = xhr.response?.byteLength || 0;
            log("  read: " + (bytes / 1024).toFixed(0) + "KB");
            try {
                window.AscDesktopEditor.RemoveFile(localPath);
            } catch (_e) {
                /* ignore */
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
            } else {
                reject(new Error("Read temp file failed: " + xhr.status));
            }
        };
        xhr.onerror = () =>
            reject(new Error("Read temp file failed: " + localPath));
        xhr.send();
    });
}

function fetchBinaryXHR(url, signal) {
    const filename = url.split("/").pop();
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        if (signal) {
            if (signal.aborted) {
                reject(new Error("Download aborted"));
                return;
            }
            signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.onload = () => {
            log(
                "XHR: " +
                    filename +
                    " " +
                    (xhr.response?.byteLength / 1024 || 0).toFixed(0) +
                    "KB",
            );
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
            } else {
                reject(new Error("Download failed: HTTP " + xhr.status));
            }
        };
        xhr.onerror = () => reject(new Error("Download failed: " + filename));
        xhr.send();
    });
}

// ---------------------------------------------------------------------------
// IndexedDB cache management
// ---------------------------------------------------------------------------

/** List all cached models. Returns [{key, byteLength}] or [] on error. */
async function listCachedModels() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const results = [];
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    results.push({
                        key: cursor.key,
                        byteLength:
                            cursor.value.size || cursor.value.byteLength,
                    });
                    cursor.continue();
                }
            };
            req.onerror = () => resolve([]);
            tx.oncomplete = () => {
                db.close();
                resolve(results);
            };
        });
    } catch (_e) {
        return [];
    }
}

/** Delete one cached model by key. Returns true on success, false on error. */
async function deleteCachedModel(key) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => {
                db.close();
                resolve(true);
            };
            tx.onerror = () => {
                db.close();
                resolve(false);
            };
        });
    } catch (_e) {
        return false;
    }
}

/** Clear all cached models. Returns true on success, false on error. */
async function clearAllCachedModels() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => {
                db.close();
                resolve(true);
            };
            tx.onerror = () => {
                db.close();
                resolve(false);
            };
        });
    } catch (_e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Translator lifecycle
// ---------------------------------------------------------------------------

async function getTranslator() {
    if (instance) {
        log("returning cached translator instance");
        return instance;
    }

    log("step 1/5: importing translator module...");
    let mod;
    try {
        mod = await import(/* @vite-ignore */ TRANSLATOR_MODULE_URL);
        log(
            "step 1/5 done: module loaded (" +
                Object.keys(mod).join(", ") +
                ")",
        );
    } catch (err) {
        log("step 1/5 FAILED: " + err.message);
        throw err;
    }

    class MozillaBacking extends mod.TranslatorBacking {
        constructor(options) {
            super(options);
            this._baseUrl = null;
            log("step 2/5 done: MozillaBacking created");
        }

        async loadModelRegistry() {
            log("step 3/5: loading registry...");
            let data;
            try {
                data = await fetchJSON(this.registryUrl);
                log(
                    "step 3/5 done: " +
                        Object.keys(data.models || {}).length +
                        " language pairs",
                );
            } catch (err) {
                log("step 3/5 FAILED: " + err.message);
                throw err;
            }

            this._baseUrl = data.baseUrl;

            return Object.entries(data.models || {}).flatMap(
                ([key, variants]) => {
                    const parts = key.split("-");
                    if (parts.length < 2) return [];
                    const best = pickBestVariant(variants);
                    return [
                        {
                            from: parts[0],
                            to: parts.slice(1).join("-"),
                            files: best.files,
                        },
                    ];
                },
            );
        }

        async loadTranslationModel({ from, to }, options) {
            log("step 4/5: loading model " + from + "→" + to);
            const key = JSON.stringify({ from, to });
            const entry = (await this.registry).find(
                (m) => m.from === from && m.to === to,
            );
            if (!entry) {
                log("step 4/5 FAILED: no model for " + from + "→" + to);
                throw new Error("No model for " + from + "→" + to);
            }

            const files = entry.files;
            const base = this._baseUrl;

            // Collect URLs
            const urlMap = {};
            for (const [label, f] of Object.entries(files)) {
                if (f?.path) urlMap[label] = base + "/" + f.path;
            }
            const labels = Object.keys(urlMap);
            const urls = Object.values(urlMap);
            log("step 4/5: need " + labels.join(", "));

            // Fetch (cache-first, then download)
            const compressed = await fetchBinaryBatch(urls, options?.signal);
            log("step 4/5: decompressing...");

            // Decompress
            const buffers = {};
            for (const label of labels) {
                const gz = compressed.get(urlMap[label]);
                if (!gz) {
                    log("  " + label + ": MISSING");
                    continue;
                }
                buffers[label] = await decompressGzip(gz);
                log(
                    "  " +
                        label +
                        ": " +
                        (buffers[label].byteLength / 1048576).toFixed(1) +
                        "MB",
                );
            }

            let vocabs;
            if (buffers.vocab) vocabs = [buffers.vocab];
            else if (buffers.srcVocab && buffers.trgVocab)
                vocabs = [buffers.srcVocab, buffers.trgVocab];
            else {
                log("step 4/5 FAILED: no vocab files");
                throw new Error("No vocab files for " + from + "→" + to);
            }

            log("step 4/5 done: model ready for " + from + "→" + to);
            this.state.set(key, "available");
            return {
                model: buffers.model,
                shortlist: buffers.lexicalShortlist,
                vocabs,
                config: { "gemm-precision": "int8shiftAlphaAll" },
            };
        }
    }

    log("step 2/5: creating MozillaBacking...");
    const backing = new MozillaBacking({ registryUrl: MODELS_REGISTRY_URL });

    log("step 5/5: creating BatchTranslator...");
    instance = new mod.BatchTranslator({}, backing);
    log("step 5/5 done: ready (models load on first translate)");
    return instance;
}

async function destroy() {
    if (instance) {
        log("destroying translator");
        await instance.delete();
        instance = null;
    }
}

/** Set quality preference. Call before getTranslator() to affect model selection. */
function setQuality(quality) {
    qualityPreference = quality || "base-memory";
    log("quality set to: " + qualityPreference);
}

/**
 * Delete cache and destroy translator so next use re-downloads.
 * Without destroy(), WASM keeps models in memory and won't re-download.
 */
async function deleteCachedModelAndReset(key) {
    await deleteCachedModel(key);
    await destroy();
}

async function clearAllCachedModelsAndReset() {
    await clearAllCachedModels();
    await destroy();
}

export const BergamotTranslator = {
    getCacheUsage,
    getTranslator,
    destroy,
    setQuality,
    getAvailableModels,
    listCachedModels,
    deleteCachedModel: deleteCachedModelAndReset,
    clearAllCachedModels: clearAllCachedModelsAndReset,
};
