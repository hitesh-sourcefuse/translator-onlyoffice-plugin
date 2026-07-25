/**
 * Shared status-message helper. Each panel has its own status element id
 * and (for sync-panel) a different class-name scheme, so this returns a
 * setStatus(msg, type) closure bound to that panel's DOM.
 */
export function createStatusSetter(elementId, options = {}) {
    const prefix =
        options.className !== undefined ? options.className : "status";
    return function setStatus(msg, type) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = msg || "";
        el.className = prefix ? prefix + (type ? " " + type : "") : type || "";
    };
}
