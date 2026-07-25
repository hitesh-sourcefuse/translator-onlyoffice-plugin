/**
 * Language detection wrapper using the `eld` (Efficient Language Detector) library.
 * Detects the source language of text so we don't need a manual Source dropdown.
 */

import { eld } from "../../vendors/eld/src/entries/static.small.js";

const LANG_NAMES = {
    ar: "Arabic",
    az: "Azerbaijani",
    be: "Belarusian",
    bg: "Bulgarian",
    bn: "Bengali",
    bs: "Bosnian",
    ca: "Catalan",
    cs: "Czech",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    et: "Estonian",
    fa: "Persian",
    fi: "Finnish",
    fr: "French",
    gu: "Gujarati",
    he: "Hebrew",
    hi: "Hindi",
    hr: "Croatian",
    hu: "Hungarian",
    id: "Indonesian",
    is: "Icelandic",
    it: "Italian",
    ja: "Japanese",
    kn: "Kannada",
    ko: "Korean",
    lt: "Lithuanian",
    lv: "Latvian",
    ml: "Malayalam",
    ms: "Malay",
    nb: "Norwegian",
    nl: "Dutch",
    nn: "Nynorsk",
    no: "Norwegian",
    pl: "Polish",
    pt: "Portuguese",
    ro: "Romanian",
    ru: "Russian",
    sk: "Slovak",
    sl: "Slovenian",
    sq: "Albanian",
    sr: "Serbian",
    sv: "Swedish",
    ta: "Tamil",
    te: "Telugu",
    th: "Thai",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
    zh: "Chinese",
    zh_hant: "Chinese (Trad)",
    hbs: "Serbo-Croatian",
};

/**
 * Detect the language of a text string.
 *
 * @param {string} text - The text to detect
 * @returns {{ language: string, isReliable: boolean }}
 *   language: ISO 639-1 code (e.g. "ja", "en") or "" if undetectable
 *   isReliable: whether the detection is confident
 */
function detect(text) {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
        return { language: "", isReliable: false };
    }

    const result = eld.detect(text);
    if (result.language && result.isReliable()) {
        return { language: result.language, isReliable: true };
    }

    // eld needs a run of text to be confident and returns nothing at all for
    // short strings like "準備". The Unicode block is unambiguous in those
    // cases, so fall back to it — reporting "unknown" here makes callers
    // substitute a default source language, which is silently wrong.
    const scriptLang = detectScript(text);
    if (scriptLang) {
        return { language: scriptLang, isReliable: false };
    }

    return { language: result.language || "", isReliable: false };
}

/**
 * Guess language from Unicode script when eld can't detect (short text, etc.).
 * Returns an ISO 639-1 code or "" if the script isn't recognisable.
 */
function detectScript(text) {
    // Japanese-specific kana → definitely Japanese
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "ja";
    // Hangul → Korean
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return "ko";
    // CJK ideographs only (no kana/hangul) → default to Japanese
    // (shared kanji — could be zh, but ja is the safer bet for mixed docs)
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return "ja";
    // Arabic / Persian
    if (/[\u0600-\u06FF]/.test(text)) return "ar";
    // Devanagari (Hindi)
    if (/[\u0900-\u097F]/.test(text)) return "hi";
    // Thai
    if (/[\u0E00-\u0E7F]/.test(text)) return "th";
    // Cyrillic
    if (/[\u0400-\u04FF]/.test(text)) return "ru";
    // Bengali
    if (/[\u0980-\u09FF]/.test(text)) return "bn";
    // Tamil
    if (/[\u0B80-\u0BFF]/.test(text)) return "ta";
    // Telugu
    if (/[\u0C00-\u0C7F]/.test(text)) return "te";
    return "";
}

/**
 * Check if text is in a language different from the target language.
 * Replaces the old hardcoded `containsJapanese` check.
 *
 * @param {string} text - The text to check
 * @param {string} targetLang - The target language code (e.g. "en")
 * @returns {{ needsTranslation: boolean, detectedLang: string }}
 */
function needsTranslation(text, targetLang) {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
        return { needsTranslation: false, detectedLang: "" };
    }

    // Very short text (< 5 chars) — eld is unreliable, use script heuristic
    if (text.trim().length < 5) {
        const scriptLang = detectScript(text);
        if (scriptLang) {
            const sNorm = scriptLang.replace(/_/g, "-").toLowerCase();
            const tNorm = targetLang.replace(/_/g, "-").toLowerCase();
            if (sNorm === tNorm) {
                return { needsTranslation: false, detectedLang: scriptLang };
            }
            return { needsTranslation: true, detectedLang: scriptLang };
        }
        // Strip ASCII, then look for any remaining letter: that means real
        // foreign-script content rather than digits, symbols or punctuation.
        const hasNonLatinLetters = /\p{L}/u.test(
            text.replace(/\p{ASCII}/gu, ""),
        );
        if (hasNonLatinLetters) {
            return { needsTranslation: true, detectedLang: "" };
        }
        // Pure ASCII, symbols only, or very short — doesn't need translation
        return { needsTranslation: false, detectedLang: "" };
    }

    const result = detect(text);

    if (!result.language) {
        // Can't detect — try script heuristic, then character-range fallback
        const scriptLang = detectScript(text);
        if (scriptLang) {
            const sNorm = scriptLang.replace(/_/g, "-").toLowerCase();
            const tNorm = targetLang.replace(/_/g, "-").toLowerCase();
            if (sNorm === tNorm) {
                return { needsTranslation: false, detectedLang: scriptLang };
            }
            return { needsTranslation: true, detectedLang: scriptLang };
        }
        const hasNonLatinLetters = /\p{L}/u.test(
            text.replace(/\p{ASCII}/gu, ""),
        );
        return { needsTranslation: hasNonLatinLetters, detectedLang: "" };
    }

    // If detected language matches target, no translation needed
    // Handle zh / zh_hant equivalence
    const detNorm = result.language.replace(/_/g, "-").toLowerCase();
    const tgtNorm = targetLang.replace(/_/g, "-").toLowerCase();
    if (detNorm === tgtNorm) {
        return { needsTranslation: false, detectedLang: result.language };
    }

    return { needsTranslation: true, detectedLang: result.language };
}

/**
 * Get the full language name for a code.
 * @param {string} code
 * @returns {string}
 */
function langName(code) {
    if (!code) return "";
    return LANG_NAMES[code] || code.toUpperCase();
}

export const LanguageDetect = {
    detect,
    needsTranslation,
    langName,
};
