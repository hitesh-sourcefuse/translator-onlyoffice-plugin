import { PluginLog } from "../shared/pluginlog.js";
import { createStatusSetter } from "../shared/status.js";

let autoCloseTimer = null;

const setStatus = createStatusSetter("sync-status", { className: "" });

function setLoading(active) {
    const spinner = document.getElementById("sync-spinner");
    const buttons = document.getElementById("sync-buttons-wrap");
    if (active) {
        spinner.className = "spinner active";
        buttons.style.display = "none";
    } else {
        spinner.className = "spinner";
        buttons.style.display = "flex";
    }
}

function cancelAutoClose() {
    if (autoCloseTimer) {
        clearTimeout(autoCloseTimer);
        autoCloseTimer = null;
    }
}

window.Asc.plugin.attachEvent("onSyncResult", (data) => {
    cancelAutoClose();
    if (data.type === "success") {
        // Keep buttons hidden during countdown — setLoading(false) NOT called here
        setStatus(data.message || "", data.type || "");
        autoCloseTimer = setTimeout(() => {
            autoCloseTimer = null;
            window.Asc.plugin.sendToPlugin("onCloseSyncPanel", {});
        }, 1500);
    } else {
        // Error/other: show result and re-enable buttons immediately
        setLoading(false);
        setStatus(data.message || "", data.type || "");
    }
});

window.Asc.plugin.init = () => {
    PluginLog.log("SYNC", "sync panel init");

    document.getElementById("btn-save-to-doc").addEventListener("click", () => {
        cancelAutoClose();
        setLoading(true);
        setStatus("Saving to document...", "");
        window.Asc.plugin.sendToPlugin("onSyncSaveToDoc", {});
    });

    document
        .getElementById("btn-load-from-doc")
        .addEventListener("click", () => {
            cancelAutoClose();
            setLoading(true);
            setStatus("Loading from document...", "");
            window.Asc.plugin.sendToPlugin("onSyncLoadFromDoc", {});
        });

    window.Asc.plugin.sendToPlugin("onSyncPanelReady", {});
};

window.Asc.plugin.button = (id) => {
    void id;
};
