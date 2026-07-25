const QUOTED_PATTERN = /「([^」]*)」|"([^"]*)"/g;

/**
 * Extract quoted/bracketed tokens, replace with placeholders.
 * Returns { cleaned: string, tokens: string[] }
 */
function extractQuotedTokens(text) {
    const tokens = [];
    const cleaned = text.replace(QUOTED_PATTERN, (_match, p1, p2) => {
        const token = p1 !== undefined ? p1 : p2;
        tokens.push(token);
        return "{{Q" + (tokens.length - 1) + "}}";
    });
    return { cleaned: cleaned, tokens: tokens };
}

/**
 * Restore quoted tokens into translated text as parenthesized originals.
 */
function restoreQuotedTokens(translatedText, tokens) {
    return translatedText.replace(/\{\{Q(\d+)\}\}/g, (_match, idx) => {
        const token = tokens[parseInt(idx, 10)];
        return '("' + token + '")';
    });
}

/**
 * Translate text via LibreTranslate, preserving structure and quoted strings.
 * Translates line-by-line to preserve structural layout.
 *
 * @param {string} url - LibreTranslate base URL
 * @param {string} text - Source text
 * @param {string} sourceLang - Source language code (e.g., "ja")
 * @param {string} targetLang - Target language code (e.g., "en")
 * @returns {Promise<string>} Translated text
 */
function translate(url, text, sourceLang, targetLang, signal) {
    const lines = text.split("\n");
    const promises = lines.map((line) => {
        if (line.trim() === "") {
            return Promise.resolve("");
        }

        const extracted = extractQuotedTokens(line);

        const fetchOpts = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                q: extracted.cleaned,
                source: sourceLang,
                target: targetLang,
                format: "text",
            }),
        };
        if (signal) fetchOpts.signal = signal;

        return fetch(url + "/translate", fetchOpts)
            .then((response) => {
                if (!response.ok) {
                    throw new Error("LibreTranslate HTTP " + response.status);
                }
                return response.json();
            })
            .then((data) => {
                if (typeof data.translatedText !== "string") {
                    throw new Error(
                        "LibreTranslate response missing translatedText",
                    );
                }
                const translated = data.translatedText;
                return restoreQuotedTokens(translated, extracted.tokens);
            });
    });

    return Promise.all(promises).then((translatedLines) =>
        translatedLines.join("\n"),
    );
}

/**
 * Check if LibreTranslate is reachable.
 */
function healthCheck(url, signal) {
    const fetchOpts = {};
    if (signal) fetchOpts.signal = signal;
    return fetch(url + "/languages", fetchOpts)
        .then((response) => response.ok)
        .catch(() => false);
}

// translatePool lived here; watcher.js now drives all three engines through one
// shared pool so they share concurrency, abort and failure-isolation behaviour.

/**
 * Translate text via LibreTranslate and return alternative translations.
 * Translates the full text (not line-by-line) to get coherent alternatives.
 *
 * @param {string} url - LibreTranslate base URL
 * @param {string} text - Source text
 * @param {string} sourceLang - Source language code (e.g., "ja")
 * @param {string} targetLang - Target language code (e.g., "en")
 * @param {number} numAlternatives - Number of alternatives to request (default 3)
 * @param {AbortSignal} signal - Optional abort signal
 * @returns {Promise<{translatedText: string, alternatives: string[]}>}
 */
function translateWithAlternatives(
    url,
    text,
    sourceLang,
    targetLang,
    numAlternatives,
    signal,
) {
    numAlternatives = numAlternatives || 3;

    const extracted = extractQuotedTokens(text);

    const fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            q: extracted.cleaned,
            source: sourceLang,
            target: targetLang,
            format: "text",
            alternatives: numAlternatives,
        }),
    };
    if (signal) fetchOpts.signal = signal;

    return fetch(url + "/translate", fetchOpts)
        .then((response) => {
            if (!response.ok) {
                throw new Error("LibreTranslate HTTP " + response.status);
            }
            return response.json();
        })
        .then((data) => {
            if (typeof data.translatedText !== "string") {
                throw new Error(
                    "LibreTranslate response missing translatedText",
                );
            }
            const mainTranslation = restoreQuotedTokens(
                data.translatedText,
                extracted.tokens,
            );
            const alternatives = [];
            if (data.alternatives && Array.isArray(data.alternatives)) {
                for (let i = 0; i < data.alternatives.length; i++) {
                    alternatives.push(
                        restoreQuotedTokens(
                            data.alternatives[i],
                            extracted.tokens,
                        ),
                    );
                }
            }
            return {
                translatedText: mainTranslation,
                alternatives: alternatives,
            };
        });
}

export const Translator = {
    translate,
    healthCheck,
    extractQuotedTokens,
    restoreQuotedTokens,
    translateWithAlternatives,
};
