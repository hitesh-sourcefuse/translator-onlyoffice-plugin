/**
 * Compute FNV-1a 32-bit hash of a string.
 * Returns hex string (synchronous — no Promise overhead).
 *
 * @param {string} text - Input text
 * @returns {string} 8-character hex hash
 */
function fnv1a32(text) {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // FNV prime, keep 32-bit unsigned
    }
    return hash.toString(16).padStart(8, "0");
}

export const Checksum = {
    hash: fnv1a32,
};
