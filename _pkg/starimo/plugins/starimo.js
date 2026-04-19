// plugins/starimo.ts
import { beginBatch, effect, endBatch, getPath, mergePatch } from "datastar";
var CONNECTED_FLASH_MS = 1500;
var EXCLUDED_SIGNAL_PREFIXES = ["ui_"];
var SIGNAL_HOIST_RE = /data-signals[-:]([a-z_][a-z0-9_]*?)(__ifmissing)?=(?:'([^']*)'|"([^"]*)")/gi;
var SIGNAL_DEBOUNCE_RE = /data-signal-debounce-([a-z_][a-z0-9_]*)=(?:'(\d+)'|"(\d+)")/gi;
var MD_UNWRAP_RE = /^(?:mo|marimo)\.md\(\s*(?:[rfRFbBuU]{0,2}"""([\s\S]*?)"""|[rfRFbBuU]{0,2}"([^"]*)")\s*\)$/;
var MD_DETECT_RE = /^\s*(?:mo|marimo)\.md\(/;
var STARIMO_ARG_NAMES = [
  "ui_starimo_status",
  "ui_starimo_ready",
  "ui_starimo_error"
];
var config = {
  signal: "starimo",
  baseUrl: "",
  debounceMs: 300
};
var sseInitialized = false;
var sseConnection = null;
var sseCleanup = null;
var watchedSignals = /* @__PURE__ */ new Set();
var previousValues = /* @__PURE__ */ new Map();
var serverSetSignals = /* @__PURE__ */ new Set();
var pendingSync = {};
var signalTimers = /* @__PURE__ */ new Map();
var signalDebounceMs = /* @__PURE__ */ new Map();
var effectDisposers = /* @__PURE__ */ new Map();
var connectedFlashTimer;
var pendingHoistHtml = [];
var hoistRafScheduled = false;
function scheduleDeferredHoist(html) {
  pendingHoistHtml.push(html);
  if (hoistRafScheduled)
    return;
  hoistRafScheduled = true;
  requestAnimationFrame(() => {
    hoistRafScheduled = false;
    const batch = pendingHoistHtml;
    pendingHoistHtml = [];
    beginBatch();
    for (const chunk of batch)
      hoistSignals(chunk);
    endBatch();
  });
}
function parseSSEData(data) {
  const result = {};
  for (const line of data.split("\n")) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1)
      continue;
    const key = line.slice(0, spaceIdx);
    const value = line.slice(spaceIdx + 1);
    result[key] = key in result ? `${result[key]}
${value}` : value;
  }
  return result;
}
function shouldSyncSignal(name) {
  return !EXCLUDED_SIGNAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
function cancelAllTimers() {
  for (const timerId of signalTimers.values()) {
    clearTimeout(timerId);
  }
  signalTimers.clear();
}
function queueSignalSync(name, value) {
  pendingSync[name] = value;
  const existing = signalTimers.get(name);
  if (existing !== void 0)
    clearTimeout(existing);
  const delay = signalDebounceMs.get(name) ?? config.debounceMs;
  signalTimers.set(name, window.setTimeout(() => {
    signalTimers.delete(name);
    flushAllPending();
  }, delay));
}
function flushAllPending() {
  cancelAllTimers();
  void flushPendingSync();
}
async function flushPendingSync() {
  if (Object.keys(pendingSync).length === 0)
    return;
  const signals = { ...pendingSync };
  pendingSync = {};
  try {
    const response = await fetch(`${config.baseUrl}/starimo/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signals })
    });
    if (!response.ok) {
      console.error("[starimo] Sync failed:", response.status, signals);
    }
  } catch (e) {
    console.error("[starimo] Sync error:", e);
  }
}
function setupSignalWatcher(signalName) {
  if (watchedSignals.has(signalName) || !shouldSyncSignal(signalName))
    return;
  watchedSignals.add(signalName);
  try {
    previousValues.set(signalName, JSON.stringify(getPath(signalName)));
  } catch {
    previousValues.set(signalName, void 0);
  }
  const dispose = effect(() => {
    let value;
    try {
      value = getPath(signalName);
    } catch {
      return;
    }
    if (serverSetSignals.delete(signalName))
      return;
    const serialized = JSON.stringify(value);
    const prev = previousValues.get(signalName);
    if (serialized !== prev) {
      previousValues.set(signalName, serialized);
      if (prev !== void 0) {
        queueSignalSync(signalName, value);
      }
    }
  });
  effectDisposers.set(signalName, dispose);
}
async function toggleHideCode(cellId) {
  const cellElement = document.getElementById(`cell-${cellId}`);
  if (!cellElement) {
    console.warn(`[starimo] toggleHideCode: cell not found: ${cellId}`);
    return;
  }
  const currentValue = cellElement.getAttribute("data-hide-code") || "auto";
  const globalHide = document.querySelector(".notebook.hide-all-code") !== null;
  let newValue;
  if (globalHide) {
    newValue = currentValue === "false" ? "auto" : "false";
  } else {
    newValue = currentValue === "true" ? "auto" : "true";
  }
  cellElement.setAttribute("data-hide-code", newValue);
  try {
    const response = await fetch(`${config.baseUrl}/starimo/cell/${cellId}/hide-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hide_code: newValue === "true" })
    });
    if (!response.ok) {
      cellElement.setAttribute("data-hide-code", currentValue);
      console.error(`[starimo] toggleHideCode failed: ${response.status}`);
    }
  } catch (e) {
    cellElement.setAttribute("data-hide-code", currentValue);
    console.error("[starimo] toggleHideCode error:", e);
  }
}
function hoistSignals(html) {
  SIGNAL_HOIST_RE.lastIndex = 0;
  const patch = {};
  const discovered = [];
  let m;
  while ((m = SIGNAL_HOIST_RE.exec(html)) !== null) {
    const name = m[1];
    discovered.push(name);
    const ifMissing = !!m[2];
    const raw = m[3] !== void 0 ? m[3] : m[4];
    if (ifMissing) {
      let exists = false;
      try {
        exists = getPath(name) !== void 0;
      } catch {
      }
      if (exists)
        continue;
    }
    try {
      patch[name] = JSON.parse(raw);
    } catch {
      patch[name] = raw;
    }
  }
  SIGNAL_DEBOUNCE_RE.lastIndex = 0;
  let dm;
  while ((dm = SIGNAL_DEBOUNCE_RE.exec(html)) !== null) {
    const dMs = parseInt(dm[2] !== void 0 ? dm[2] : dm[3], 10);
    if (Number.isInteger(dMs) && dMs >= 0) {
      signalDebounceMs.set(dm[1], dMs);
    }
  }
  if (Object.keys(patch).length > 0) {
    for (const name of Object.keys(patch)) {
      if (watchedSignals.has(name)) {
        serverSetSignals.add(name);
      }
    }
    mergePatch(patch);
  }
  for (const name of discovered) {
    setupSignalWatcher(name);
  }
}
function initializeSSE() {
  if (sseInitialized)
    return;
  sseInitialized = true;
  mergePatch({
    _starimo_status: "connecting",
    _starimo_ready: false,
    _starimo_error: ""
  });
  sseConnection = new EventSource(`${config.baseUrl}/starimo/sse`);
  sseConnection.addEventListener("datastar-patch-signals", (event) => {
    const argsRaw = parseSSEData(String(event.data));
    if (!argsRaw.signals)
      return;
    try {
      const signals = JSON.parse(argsRaw.signals);
      if (Array.isArray(signals.starimo_signals)) {
        for (const name of signals.starimo_signals) {
          setupSignalWatcher(name);
        }
      }
      if (signals.starimo_signal_debounce && typeof signals.starimo_signal_debounce === "object") {
        for (const [dName, dMs] of Object.entries(signals.starimo_signal_debounce)) {
          signalDebounceMs.set(dName, dMs);
        }
      }
      beginBatch();
      for (const [key, value] of Object.entries(signals)) {
        if (watchedSignals.has(key)) {
          serverSetSignals.add(key);
          previousValues.set(key, JSON.stringify(value));
        }
      }
      mergePatch(signals);
      endBatch();
    } catch (e) {
      console.error("[starimo] Failed to parse SSE signals:", e);
    }
  });
  sseConnection.addEventListener("datastar-patch-elements", (event) => {
    const argsRaw = parseSSEData(String(event.data));
    if (argsRaw.selector) {
      const target = document.querySelector(argsRaw.selector);
      if (!target)
        return;
    }
    document.dispatchEvent(new CustomEvent("datastar-fetch", {
      detail: {
        type: "datastar-patch-elements",
        el: document.documentElement,
        argsRaw
      }
    }));
    if (argsRaw.elements)
      scheduleDeferredHoist(argsRaw.elements);
    if (argsRaw.selector) {
      const m = argsRaw.selector.match(/^#output-content-(.+)/);
      if (m) {
        const cellId = m[1];
        requestAnimationFrame(() => {
          const outputEl = document.querySelector(argsRaw.selector);
          const setters = outputEl?.querySelectorAll(".signal-setter[data-signal-name]");
          const contentEl = document.querySelector(`#cell-${cellId} > .content`);
          if (!contentEl)
            return;
          if (setters && setters.length > 0) {
            const names = Array.from(setters).map(
              (s) => s.dataset.signalName || ""
            ).filter(Boolean);
            const noteInput = contentEl.querySelector(".cell-note-input");
            if (!noteInput?.value?.trim()) {
              contentEl.dataset.note = `\u2192 ${names.join(", ")}`;
              contentEl.dataset.autoNote = "true";
            }
          } else if (contentEl.dataset.autoNote) {
            delete contentEl.dataset.note;
            delete contentEl.dataset.autoNote;
          }
        });
      }
    }
  });
  sseConnection.onerror = () => {
    console.error("[starimo] SSE connection error");
    mergePatch({ _starimo_status: "error", _starimo_error: "SSE connection lost" });
  };
  sseConnection.onopen = () => {
    console.log("[starimo] SSE connected");
    const patch = { _starimo_status: "connected", ui_show_connected: true };
    if (Object.keys(pendingSync).length === 0 && signalTimers.size === 0) {
      patch.ui_save_state = "saved";
    }
    mergePatch(patch);
    if (connectedFlashTimer !== void 0)
      clearTimeout(connectedFlashTimer);
    connectedFlashTimer = window.setTimeout(() => {
      connectedFlashTimer = void 0;
      mergePatch({ ui_show_connected: false });
    }, CONNECTED_FLASH_MS);
  };
  const handleKeyDown = async (evt) => {
    if (!evt.altKey || evt.key !== "ArrowUp" && evt.key !== "ArrowDown")
      return;
    const target = evt.target;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA")
      return;
    if (target?.closest?.("code-editor, .cm-editor"))
      return;
    let activeCell;
    try {
      activeCell = getPath("ui_active_cell");
    } catch {
    }
    if (!activeCell)
      return;
    evt.preventDefault();
    const cells = [...document.querySelectorAll("#starimo-cells > .cell")];
    const idx = cells.findIndex((c) => c.id === `cell-${activeCell}`);
    if (idx < 0)
      return;
    const newPos = evt.key === "ArrowUp" ? idx : idx + 2;
    if (newPos >= 1 && newPos <= cells.length) {
      try {
        await postJSON(`/starimo/cell/${activeCell}/move`, { position: newPos });
        mergePatch({ ui_save_state: "unsaved" });
      } catch (e) {
        console.error("[starimo] Alt+Arrow move error:", e);
      }
    }
  };
  document.addEventListener("keydown", handleKeyDown);
  sseCleanup = () => {
    cancelAllTimers();
    pendingSync = {};
    for (const dispose of effectDisposers.values())
      dispose();
    effectDisposers.clear();
    watchedSignals.clear();
    previousValues.clear();
    serverSetSignals.clear();
    signalDebounceMs.clear();
    if (connectedFlashTimer !== void 0) {
      clearTimeout(connectedFlashTimer);
      connectedFlashTimer = void 0;
    }
    document.removeEventListener("keydown", handleKeyDown);
    if (sseConnection) {
      sseConnection.close();
      sseConnection = null;
    }
    sseInitialized = false;
  };
}
var NO_OUTPUT_SELECTOR = ":has(.output-content:empty, .output-content > .output-placeholder:only-child, .output-content > pre:only-child:empty, .output-target-display:not(:empty), .output-content > .signal-output:only-child, .output-content > .signal-setter:only-child)";
function isCellCodeHidden(cellElement) {
  const hideCode = cellElement.getAttribute("data-hide-code") || "auto";
  if (hideCode === "true")
    return true;
  if (hideCode === "false")
    return false;
  return cellElement.closest(".notebook.hide-all-code") !== null;
}
async function postAction(path, options) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    ...options
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return response;
}
async function postJSON(path, body) {
  return postAction(path, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
function wrapMarkdownIfNeeded(cellId, code) {
  const cellEl = document.getElementById(`cell-${cellId}`);
  if (cellEl?.dataset.cellType === "markdown" && !MD_DETECT_RE.test(code)) {
    return `mo.md(r"""
${code}
""")`;
  }
  return code;
}
var starimoAttributePlugin = {
  name: "starimo",
  requirement: { key: "allowed", value: "allowed" },
  argNames: [...STARIMO_ARG_NAMES],
  setConfig(newConfig) {
    config = { ...config, ...newConfig };
  },
  apply(_ctx) {
    const shouldManageGlobal = !sseInitialized;
    initializeSSE();
    return () => {
      if (shouldManageGlobal && sseCleanup) {
        sseCleanup();
        sseCleanup = null;
      }
    };
  }
};
var starimoActionPlugin = {
  name: "starimo",
  async apply(ctx, operation, ...args) {
    const { error } = ctx;
    if (typeof operation !== "string") {
      throw error("starimo: operation must be a string", {});
    }
    switch (operation) {
      case "runAll": {
        try {
          await postAction("/starimo/run-all");
        } catch (e) {
          throw error(`runAll error: ${e}`, {});
        }
        break;
      }
      case "runStale": {
        try {
          await postAction("/starimo/run-stale");
        } catch (e) {
          throw error(`runStale error: ${e}`, {});
        }
        break;
      }
      case "runCell": {
        const [runCellId] = args;
        if (typeof runCellId !== "string") {
          console.warn("[starimo] runCell: no cell ID");
          break;
        }
        const editor = document.getElementById(`code-${runCellId}`);
        if (!editor) {
          console.warn(`[starimo] runCell: editor not found: code-${runCellId}`);
          break;
        }
        try {
          const code = wrapMarkdownIfNeeded(runCellId, editor.value ?? "");
          await postJSON(`/starimo/run/${runCellId}`, { code });
          mergePatch({ ui_save_state: "unsaved" });
        } catch (e) {
          throw error(`runCell error: ${e}`, {});
        }
        break;
      }
      case "addCell": {
        const [afterCellId] = args;
        try {
          await postJSON("/starimo/cell", { after_cell_id: afterCellId || null });
          mergePatch({ ui_save_state: "unsaved" });
        } catch (e) {
          throw error(`addCell error: ${e}`, {});
        }
        break;
      }
      case "deleteCell": {
        const [deleteCellId] = args;
        if (typeof deleteCellId !== "string") {
          console.warn("[starimo] deleteCell: no cell ID");
          break;
        }
        try {
          const resp = await fetch(`${config.baseUrl}/starimo/cell/${deleteCellId}`, { method: "DELETE" });
          if (!resp.ok)
            throw new Error(`DELETE failed: ${resp.status}`);
          mergePatch({ ui_save_state: "unsaved" });
        } catch (e) {
          throw error(`deleteCell error: ${e}`, {});
        }
        break;
      }
      case "clearOutput": {
        const [cellId] = args;
        if (typeof cellId !== "string")
          break;
        const outputContent = document.getElementById(`output-content-${cellId}`);
        if (outputContent)
          outputContent.innerHTML = "";
        break;
      }
      case "toggleHideCode": {
        const [toggleCellId] = args;
        if (typeof toggleCellId !== "string") {
          console.warn("[starimo] toggleHideCode: missing cellId");
          break;
        }
        await toggleHideCode(toggleCellId);
        break;
      }
      case "cellClick": {
        const [clickCellId] = args;
        if (typeof clickCellId !== "string")
          break;
        const clickCellElement = document.getElementById(`cell-${clickCellId}`);
        if (!clickCellElement)
          break;
        if (isCellCodeHidden(clickCellElement) && clickCellElement.matches(NO_OUTPUT_SELECTOR)) {
          await toggleHideCode(clickCellId);
          mergePatch({ ui_active_cell: clickCellId });
          break;
        }
        mergePatch({ ui_active_cell: clickCellId });
        break;
      }
      case "selectCell": {
        const [selectCellId] = args;
        if (selectCellId)
          mergePatch({ ui_active_cell: selectCellId });
        break;
      }
      case "deselectAll": {
        mergePatch({ ui_active_cell: "" });
        break;
      }
      case "setCellType": {
        const [typeCellId, cellType] = args;
        if (typeof typeCellId !== "string" || typeof cellType !== "string") {
          console.warn("[starimo] setCellType: missing cellId or cellType");
          break;
        }
        const typeEditor = document.getElementById(`code-${typeCellId}`);
        if (!typeEditor) {
          console.warn("[starimo] setCellType: editor not found for", typeCellId);
          break;
        }
        let code = typeEditor.value ?? "";
        const cellElement = document.getElementById(`cell-${typeCellId}`);
        if (cellType === "markdown") {
          const mdMatch = code.match(MD_UNWRAP_RE);
          if (mdMatch) {
            code = (mdMatch[1] || mdMatch[2] || "").trim();
            typeEditor.value = code;
          }
        }
        const displaySpan = cellElement?.querySelector(".cell-type-display");
        if (displaySpan)
          displaySpan.textContent = cellType === "markdown" ? "Markdown" : "Code";
        if (cellElement)
          cellElement.dataset.cellType = cellType;
        try {
          await postJSON(`/starimo/cell/${typeCellId}/type`, { cell_type: cellType, code });
        } catch (e) {
          console.error("[starimo] setCellType persist error:", e);
          const prev = cellType === "markdown" ? "code" : "markdown";
          if (displaySpan)
            displaySpan.textContent = prev === "markdown" ? "Markdown" : "Code";
          if (cellElement)
            cellElement.dataset.cellType = prev;
        }
        break;
      }
      case "installPackage": {
        const [installCellId, packageName] = args;
        if (typeof installCellId !== "string" || typeof packageName !== "string")
          break;
        const btnEl = document.getElementById(`install-btn-${installCellId}`);
        const statusEl = document.getElementById(`install-status-${installCellId}`);
        if (btnEl) {
          btnEl.disabled = true;
          btnEl.textContent = `Installing ${packageName}...`;
        }
        try {
          const response = await postJSON(`/starimo/install-package/${installCellId}`, { package: packageName });
          const result = await response.json();
          if (result.ok) {
            if (statusEl)
              statusEl.textContent = "Installed. Re-running cell...";
            if (btnEl)
              btnEl.style.display = "none";
          } else {
            if (statusEl)
              statusEl.textContent = `Failed: ${result.error}`;
            if (btnEl) {
              btnEl.disabled = false;
              btnEl.textContent = `Retry Install ${packageName}`;
            }
          }
        } catch (e) {
          if (statusEl)
            statusEl.textContent = `Error: ${e instanceof Error ? e.message : e}`;
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = `Retry Install ${packageName}`;
          }
        }
        break;
      }
      case "moveCell": {
        const [moveCellId, newPosition] = args;
        if (typeof moveCellId !== "string" || !newPosition)
          break;
        const pos = parseInt(newPosition, 10);
        if (!Number.isInteger(pos) || pos < 1)
          break;
        try {
          await postJSON(`/starimo/cell/${moveCellId}/move`, { position: pos });
          mergePatch({ ui_save_state: "unsaved" });
        } catch (e) {
          throw error(`moveCell error: ${e}`, {});
        }
        break;
      }
      case "setOutputTarget": {
        const [targetCellId, targetValue] = args;
        if (typeof targetCellId !== "string")
          break;
        try {
          await postJSON(`/starimo/cell/${targetCellId}/output-target`, {
            target: targetValue || null
          });
          mergePatch({ ui_save_state: "unsaved" });
        } catch (e) {
          throw error(`setOutputTarget error: ${e}`, {});
        }
        break;
      }
      case "setNote": {
        const [noteCellId, noteText] = args;
        if (typeof noteCellId !== "string")
          break;
        try {
          await postJSON(`/starimo/cell/${noteCellId}/note`, { note: noteText || "" });
        } catch (e) {
          console.error("[starimo] setNote error:", e);
        }
        break;
      }
      case "renameCell": {
        const [oldCellId, newCellName] = args;
        if (typeof oldCellId !== "string" || typeof newCellName !== "string")
          break;
        if (!newCellName || newCellName === oldCellId)
          break;
        try {
          const resp = await postJSON(`/starimo/cell/${oldCellId}/rename`, { name: newCellName });
          if (resp.ok) {
            mergePatch({ ui_active_cell: newCellName, ui_save_state: "unsaved" });
          }
        } catch (e) {
          console.error("[starimo] renameCell error:", e);
          const input = document.querySelector(
            `#cell-${CSS.escape(oldCellId)} .cell-name-input`
          );
          if (input)
            input.value = oldCellId;
        }
        break;
      }
      case "save": {
        try {
          cancelAllTimers();
          await flushPendingSync();
          mergePatch({ ui_save_state: "saving" });
          const codes = {};
          document.querySelectorAll('code-editor[id^="code-"]').forEach((el) => {
            const cellId = el.id.replace(/^code-/, "");
            codes[cellId] = wrapMarkdownIfNeeded(cellId, el.value ?? "");
          });
          const response = await postJSON("/starimo/save", { codes });
          if (response.ok) {
            mergePatch({ ui_save_state: "saved" });
          } else {
            mergePatch({ ui_save_state: "unsaved" });
          }
        } catch (e) {
          console.error("[starimo] save error:", e);
          mergePatch({ ui_save_state: "unsaved" });
        }
        break;
      }
      default:
        console.warn(`@starimo: Unknown operation: ${operation}`);
    }
  }
};
var starimo_default = starimoAttributePlugin;
export {
  starimo_default as default,
  starimoActionPlugin
};
