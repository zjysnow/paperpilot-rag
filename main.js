"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DifyKnowledgeBasePlugin,
  isIgnoredPath: () => isIgnoredPath
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  apiUrl: "http://localhost/v1",
  apiKey: "",
  datasetId: "",
  ignoredPaths: [],
  autoSyncEnabled: false,
  debounceSeconds: 5,
  documentIds: {}
};
function isIgnoredPath(path, patterns) {
  const normalizedPath = normalizePath(path);
  return patterns.some((rawPattern) => {
    const pattern = normalizePath(rawPattern);
    if (!pattern) return false;
    if (pattern.endsWith("/*")) {
      return normalizedPath.startsWith(`${pattern.slice(0, -2)}/`);
    }
    if (pattern.includes("*")) {
      const expression = new RegExp(
        `^${pattern.split("*").map(escapeRegExp).join(".*")}$`
      );
      return expression.test(normalizedPath);
    }
    return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`);
  });
}
function normalizePath(path) {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function apiEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/datasets`;
}
var DifyKnowledgeBasePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.pendingSyncs = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DifySettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (this.settings.autoSyncEnabled && file instanceof import_obsidian.TFile && file.extension === "md") {
        this.scheduleSync(file);
      }
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.settings.autoSyncEnabled && file instanceof import_obsidian.TFile && file.extension === "md") {
        this.scheduleSync(file);
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.settings.autoSyncEnabled && file instanceof import_obsidian.TFile && file.extension === "md") {
        this.cancelScheduledSync(oldPath);
        const documentId = this.settings.documentIds[oldPath];
        if (documentId) {
          delete this.settings.documentIds[oldPath];
          this.settings.documentIds[file.path] = documentId;
          void this.saveSettings();
        }
        this.scheduleSync(file);
      }
    }));
    this.addCommand({
      id: "send-current-note",
      name: "Send current note to Paper Pilot Rag",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.sendFile(file);
        return true;
      }
    });
    this.addCommand({
      id: "send-all-notes",
      name: "Send all non-ignored notes to Paper Pilot Rag",
      callback: () => void this.sendAllFiles()
    });
    this.addRibbonIcon("cloud-upload", "Send current note to Paper Pilot Rag", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") {
        new import_obsidian.Notice("Open a Markdown note before sending it to Dify.");
        return;
      }
      void this.sendFile(file);
    });
  }
  async loadSettings() {
    var _a, _b;
    const saved = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      ignoredPaths: Array.isArray(saved == null ? void 0 : saved.ignoredPaths) ? saved.ignoredPaths.filter((path) => typeof path === "string") : [],
      autoSyncEnabled: (_a = saved == null ? void 0 : saved.autoSyncEnabled) != null ? _a : DEFAULT_SETTINGS.autoSyncEnabled,
      debounceSeconds: Math.max(1, Math.min(60, (_b = saved == null ? void 0 : saved.debounceSeconds) != null ? _b : DEFAULT_SETTINGS.debounceSeconds)),
      documentIds: (saved == null ? void 0 : saved.documentIds) && typeof saved.documentIds === "object" ? saved.documentIds : {}
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async getDatasets() {
    if (!this.settings.apiKey.trim() || !this.settings.apiUrl.trim()) {
      throw new Error("Configure the Dify API URL and API key first.");
    }
    const response = await (0, import_obsidian.requestUrl)({
      url: `${apiEndpoint(this.settings.apiUrl)}?page=1&limit=100`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.settings.apiKey.trim()}` }
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Dify returned HTTP ${response.status}`);
    }
    const data = response.json;
    if (!Array.isArray(data.data)) {
      throw new Error("Dify returned an invalid dataset list.");
    }
    return data.data.filter(
      (dataset) => typeof dataset === "object" && dataset !== null && "id" in dataset && "name" in dataset && typeof dataset.id === "string" && typeof dataset.name === "string"
    );
  }
  async sendAllFiles() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => !isIgnoredPath(file.path, this.settings.ignoredPaths));
    if (files.length === 0) {
      new import_obsidian.Notice("No non-ignored Markdown notes found.");
      return;
    }
    for (const file of files) await this.sendFile(file, false);
    new import_obsidian.Notice(`Sent ${files.length} note${files.length === 1 ? "" : "s"} to Dify.`);
  }
  scheduleSync(file) {
    this.cancelScheduledSync(file.path);
    const timeout = window.setTimeout(() => {
      this.pendingSyncs.delete(file.path);
      void this.sendFile(file, false);
    }, this.settings.debounceSeconds * 1e3);
    this.pendingSyncs.set(file.path, timeout);
  }
  cancelScheduledSync(path) {
    const timeout = this.pendingSyncs.get(path);
    if (timeout !== void 0) {
      window.clearTimeout(timeout);
      this.pendingSyncs.delete(path);
    }
  }
  async sendFile(file, showSuccess = true) {
    var _a;
    if (isIgnoredPath(file.path, this.settings.ignoredPaths)) {
      new import_obsidian.Notice(`Ignored by settings: ${file.path}`);
      return;
    }
    if (!this.settings.apiKey.trim() || !this.settings.datasetId.trim()) {
      new import_obsidian.Notice("Configure the Dify API key and dataset ID in settings.");
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      const documentId = this.settings.documentIds[file.path];
      const endpoint = documentId ? `${apiEndpoint(this.settings.apiUrl)}/${encodeURIComponent(this.settings.datasetId)}/documents/${encodeURIComponent(documentId)}/update-by-text` : `${apiEndpoint(this.settings.apiUrl)}/${encodeURIComponent(this.settings.datasetId)}/document/create-by-text`;
      const response = await (0, import_obsidian.requestUrl)({
        url: endpoint,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.apiKey.trim()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: file.path,
          text: content,
          indexing_technique: "high_quality",
          process_rule: { mode: "automatic" }
        })
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Dify returned HTTP ${response.status}`);
      }
      if (!documentId) {
        const responseData = response.json;
        const createdDocumentId = (_a = responseData.document) == null ? void 0 : _a.id;
        if (createdDocumentId) {
          this.settings.documentIds[file.path] = createdDocumentId;
          await this.saveSettings();
        }
      }
      if (showSuccess) new import_obsidian.Notice(`Sent to Paper Pilot Rag: ${file.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian.Notice(`Could not send ${file.path}: ${message}`);
      console.error("Dify upload failed", { path: file.path, error });
    }
  }
};
var DifySettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper Pilot Rag" });
    containerEl.createEl("p", {
      text: "Connect this vault to a local Dify dataset. Paths are relative to the vault root.",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("Dify API URL").setDesc("The Dify API base URL, for example http://localhost/v1.").addText(
      (text) => text.setPlaceholder("http://localhost/v1").setValue(this.plugin.settings.apiUrl).onChange(async (value) => {
        this.plugin.settings.apiUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("API key").setDesc("The dataset API key from Dify.").addText((text) => {
      text.setPlaceholder("dataset-...").setValue(this.plugin.settings.apiKey);
      text.inputEl.setAttribute("type", "password");
      text.onChange(async (value) => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      });
    });
    const datasetSetting = new import_obsidian.Setting(containerEl).setName("Dify knowledge base").setDesc("Choose a dataset returned by the Dify API.");
    let datasetDropdown;
    datasetSetting.addDropdown((dropdown) => {
      datasetDropdown = dropdown;
      dropdown.addOption("", "Loading datasets...");
      dropdown.setValue(this.plugin.settings.datasetId);
      dropdown.onChange(async (value) => {
        this.plugin.settings.datasetId = value;
        await this.plugin.saveSettings();
      });
    });
    datasetSetting.addButton(
      (button) => button.setButtonText("Refresh").onClick(() => void this.refreshDatasets(datasetDropdown))
    );
    void this.refreshDatasets(datasetDropdown);
    const ignoreSetting = new import_obsidian.Setting(containerEl).setName("Ignored paths").setDesc("One path or glob per line. Folders ignore all notes below them; use * as a wildcard.");
    ignoreSetting.addTextArea((text) => {
      text.setPlaceholder("Private/\nTemplates/\n*.excalidraw.md").setValue(this.plugin.settings.ignoredPaths.join("\n")).onChange(async (value) => {
        this.plugin.settings.ignoredPaths = value.split(/\r?\n/).map(normalizePath).filter(Boolean);
        await this.plugin.saveSettings();
      });
      text.inputEl.rows = 6;
      text.inputEl.setCssStyles({ width: "100%" });
    });
    new import_obsidian.Setting(containerEl).setName("Automatic sync").setDesc("Automatically send created and modified Markdown notes after a short delay.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
        this.plugin.settings.autoSyncEnabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Sync delay").setDesc("Seconds to wait after the last edit before sending the note (1-60).").addSlider(
      (slider) => slider.setLimits(1, 60, 1).setValue(this.plugin.settings.debounceSeconds).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.debounceSeconds = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Send all notes").setDesc("Uploads every Markdown note except paths listed above.").addButton(
      (button) => button.setButtonText("Send all").onClick(() => void this.plugin.sendAllFiles())
    );
  }
  async refreshDatasets(dropdown) {
    dropdown.selectEl.disabled = true;
    try {
      const datasets = await this.plugin.getDatasets();
      dropdown.selectEl.empty();
      if (datasets.length === 0) {
        dropdown.addOption("", "No knowledge bases found");
        this.plugin.settings.datasetId = "";
        await this.plugin.saveSettings();
        return;
      }
      for (const dataset of datasets) {
        dropdown.addOption(dataset.id, dataset.name);
      }
      const selectedId = datasets.some((dataset) => dataset.id === this.plugin.settings.datasetId) ? this.plugin.settings.datasetId : datasets[0].id;
      dropdown.setValue(selectedId);
      if (selectedId !== this.plugin.settings.datasetId) {
        this.plugin.settings.datasetId = selectedId;
        await this.plugin.saveSettings();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dropdown.selectEl.empty();
      dropdown.addOption("", "Unable to load datasets");
      new import_obsidian.Notice(`Could not load Dify knowledge bases: ${message}`);
    } finally {
      dropdown.selectEl.disabled = false;
    }
  }
};
