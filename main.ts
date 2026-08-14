import {
	App,
	DropdownComponent,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";

interface DifySettings {
	apiUrl: string;
	apiKey: string;
	datasetId: string;
	ignoredPaths: string[];
	autoSyncEnabled: boolean;
	debounceSeconds: number;
	documentIds: Record<string, string>;
}

interface DifyDataset {
	id: string;
	name: string;
}

const DEFAULT_SETTINGS: DifySettings = {
	apiUrl: "http://localhost/v1",
	apiKey: "",
	datasetId: "",
	ignoredPaths: [],
	autoSyncEnabled: false,
	debounceSeconds: 5,
	documentIds: {},
};

/**
 * Match vault-relative paths against exact paths, folders, or simple glob patterns.
 * A folder entry ignores that folder and all of its descendants.
 */
export function isIgnoredPath(path: string, patterns: string[]): boolean {
	const normalizedPath = normalizePath(path);
	return patterns.some((rawPattern) => {
		const pattern = normalizePath(rawPattern);
		if (!pattern) return false;
		if (pattern.endsWith("/*")) {
			return normalizedPath.startsWith(`${pattern.slice(0, -2)}/`);
		}
		if (pattern.includes("*")) {
			const expression = new RegExp(
				`^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
			);
			return expression.test(normalizedPath);
		}
		return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`);
	});
}

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function apiEndpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/datasets`;
}

export default class DifyKnowledgeBasePlugin extends Plugin {
	settings: DifySettings = DEFAULT_SETTINGS;
	private pendingSyncs = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new DifySettingTab(this.app, this));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (this.settings.autoSyncEnabled && file instanceof TFile && file.extension === "md") {
				this.scheduleSync(file);
			}
		}));
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (this.settings.autoSyncEnabled && file instanceof TFile && file.extension === "md") {
				this.scheduleSync(file);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (this.settings.autoSyncEnabled && file instanceof TFile && file.extension === "md") {
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
			},
		});
		this.addCommand({
			id: "send-all-notes",
			name: "Send all non-ignored notes to Paper Pilot Rag",
			callback: () => void this.sendAllFiles(),
		});
		this.addRibbonIcon("cloud-upload", "Send current note to Paper Pilot Rag", () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== "md") {
				new Notice("Open a Markdown note before sending it to Dify.");
				return;
			}
			void this.sendFile(file);
		});
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<DifySettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			ignoredPaths: Array.isArray(saved?.ignoredPaths)
				? saved.ignoredPaths.filter((path): path is string => typeof path === "string")
				: [],
			autoSyncEnabled: saved?.autoSyncEnabled ?? DEFAULT_SETTINGS.autoSyncEnabled,
			debounceSeconds: Math.max(1, Math.min(60, saved?.debounceSeconds ?? DEFAULT_SETTINGS.debounceSeconds)),
			documentIds: saved?.documentIds && typeof saved.documentIds === "object"
				? saved.documentIds
				: {},
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async getDatasets(): Promise<DifyDataset[]> {
		if (!this.settings.apiKey.trim() || !this.settings.apiUrl.trim()) {
			throw new Error("Configure the Dify API URL and API key first.");
		}
		const response = await requestUrl({
			url: `${apiEndpoint(this.settings.apiUrl)}?page=1&limit=100`,
			method: "GET",
			headers: { Authorization: `Bearer ${this.settings.apiKey.trim()}` },
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Dify returned HTTP ${response.status}`);
		}
		const data = response.json as { data?: unknown };
		if (!Array.isArray(data.data)) {
			throw new Error("Dify returned an invalid dataset list.");
		}
		return data.data.filter((dataset): dataset is DifyDataset =>
			typeof dataset === "object" &&
			dataset !== null &&
			"id" in dataset &&
			"name" in dataset &&
			typeof dataset.id === "string" &&
			typeof dataset.name === "string",
		);
	}

	async sendAllFiles(): Promise<void> {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => !isIgnoredPath(file.path, this.settings.ignoredPaths));
		if (files.length === 0) {
			new Notice("No non-ignored Markdown notes found.");
			return;
		}
		for (const file of files) await this.sendFile(file, false);
		new Notice(`Sent ${files.length} note${files.length === 1 ? "" : "s"} to Dify.`);
	}

	private scheduleSync(file: TFile): void {
		this.cancelScheduledSync(file.path);
		const timeout = window.setTimeout(() => {
			this.pendingSyncs.delete(file.path);
			void this.sendFile(file, false);
		}, this.settings.debounceSeconds * 1000);
		this.pendingSyncs.set(file.path, timeout);
	}

	private cancelScheduledSync(path: string): void {
		const timeout = this.pendingSyncs.get(path);
		if (timeout !== undefined) {
			window.clearTimeout(timeout);
			this.pendingSyncs.delete(path);
		}
	}

	private async sendFile(file: TFile, showSuccess = true): Promise<void> {
		if (isIgnoredPath(file.path, this.settings.ignoredPaths)) {
			new Notice(`Ignored by settings: ${file.path}`);
			return;
		}
		if (!this.settings.apiKey.trim() || !this.settings.datasetId.trim()) {
			new Notice("Configure the Dify API key and dataset ID in settings.");
			return;
		}

		try {
			const content = await this.app.vault.read(file);
			const documentId = this.settings.documentIds[file.path];
			const endpoint = documentId
				? `${apiEndpoint(this.settings.apiUrl)}/${encodeURIComponent(this.settings.datasetId)}/documents/${encodeURIComponent(documentId)}/update-by-text`
				: `${apiEndpoint(this.settings.apiUrl)}/${encodeURIComponent(this.settings.datasetId)}/document/create-by-text`;
			const response = await requestUrl({
				url: endpoint,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.settings.apiKey.trim()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: file.path,
					text: content,
					indexing_technique: "high_quality",
					process_rule: { mode: "automatic" },
				}),
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`Dify returned HTTP ${response.status}`);
			}
			if (!documentId) {
				const responseData = response.json as { document?: { id?: string } };
				const createdDocumentId = responseData.document?.id;
				if (createdDocumentId) {
					this.settings.documentIds[file.path] = createdDocumentId;
					await this.saveSettings();
				}
			}
			if (showSuccess) new Notice(`Sent to Paper Pilot Rag: ${file.path}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Could not send ${file.path}: ${message}`);
			console.error("Dify upload failed", { path: file.path, error });
		}
	}
}

class DifySettingTab extends PluginSettingTab {
	plugin: DifyKnowledgeBasePlugin;

	constructor(app: App, plugin: DifyKnowledgeBasePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Paper Pilot Rag" });
		containerEl.createEl("p", {
			text: "Connect this vault to a local Dify dataset. Paths are relative to the vault root.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Dify API URL")
			.setDesc("The Dify API base URL, for example http://localhost/v1.")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost/v1")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("API key")
			.setDesc("The dataset API key from Dify.")
			.addText((text) => {
				text.setPlaceholder("dataset-...").setValue(this.plugin.settings.apiKey);
				text.inputEl.setAttribute("type", "password");
				text.onChange(async (value) => {
					this.plugin.settings.apiKey = value.trim();
					await this.plugin.saveSettings();
				});
			});
		const datasetSetting = new Setting(containerEl)
			.setName("Dify knowledge base")
			.setDesc("Choose a dataset returned by the Dify API.");
		let datasetDropdown!: DropdownComponent;
		datasetSetting.addDropdown((dropdown) => {
			datasetDropdown = dropdown;
			dropdown.addOption("", "Loading datasets...");
			dropdown.setValue(this.plugin.settings.datasetId);
			dropdown.onChange(async (value) => {
				this.plugin.settings.datasetId = value;
				await this.plugin.saveSettings();
			});
		});
		datasetSetting.addButton((button) =>
			button.setButtonText("Refresh").onClick(() => void this.refreshDatasets(datasetDropdown)),
		);
		void this.refreshDatasets(datasetDropdown);

		const ignoreSetting = new Setting(containerEl)
			.setName("Ignored paths")
			.setDesc("One path or glob per line. Folders ignore all notes below them; use * as a wildcard.");
		ignoreSetting.addTextArea((text) => {
			text.setPlaceholder("Private/\nTemplates/\n*.excalidraw.md")
				.setValue(this.plugin.settings.ignoredPaths.join("\n"))
				.onChange(async (value) => {
					this.plugin.settings.ignoredPaths = value
						.split(/\r?\n/)
						.map(normalizePath)
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			text.inputEl.rows = 6;
			text.inputEl.setCssStyles({ width: "100%" });
		});

		new Setting(containerEl)
			.setName("Automatic sync")
			.setDesc("Automatically send created and modified Markdown notes after a short delay.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
					this.plugin.settings.autoSyncEnabled = value;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Sync delay")
			.setDesc("Seconds to wait after the last edit before sending the note (1-60).")
			.addSlider((slider) =>
				slider
					.setLimits(1, 60, 1)
					.setValue(this.plugin.settings.debounceSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.debounceSeconds = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Send all notes")
			.setDesc("Uploads every Markdown note except paths listed above.")
			.addButton((button) =>
				button.setButtonText("Send all").onClick(() => void this.plugin.sendAllFiles()),
			);
	}

	private async refreshDatasets(dropdown: DropdownComponent): Promise<void> {
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
			const selectedId = datasets.some((dataset) => dataset.id === this.plugin.settings.datasetId)
				? this.plugin.settings.datasetId
				: datasets[0].id;
			dropdown.setValue(selectedId);
			if (selectedId !== this.plugin.settings.datasetId) {
				this.plugin.settings.datasetId = selectedId;
				await this.plugin.saveSettings();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			dropdown.selectEl.empty();
			dropdown.addOption("", "Unable to load datasets");
			new Notice(`Could not load Dify knowledge bases: ${message}`);
		} finally {
			dropdown.selectEl.disabled = false;
		}
	}
}
