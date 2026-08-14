# Paper Pilot Rag for Obsidian

This plugin sends Markdown notes to a local Dify knowledge base through
`POST /v1/datasets/{dataset_id}/document/create-by-text`.

1. Install the built `main.js` and `manifest.json` into the plugin folder.
2. Configure the Dify API URL and dataset API key in Obsidian settings. The
   plugin loads available knowledge bases from Dify; choose one from the
   **Dify knowledge base** dropdown or press **Refresh**.
3. Enable **Automatic sync**, or use **Send current note to Paper Pilot Rag** and
   **Send all non-ignored notes to Paper Pilot Rag**.

## Local installation script

Pass the path to an existing Obsidian vault. The script builds the plugin,
clears only that vault's `paperpilot-rag` plugin directory, and installs the
fresh `main.js` and `manifest.json` files:

```bash
npm run install-plugin -- "/path/to/your/Obsidian vault"
```

The target directory is:

```text
/path/to/your/Obsidian vault/.obsidian/plugins/paperpilot-rag/
```

Automatic sync listens for Markdown note creation, edits, and renames. It waits
for the configured sync delay after the last edit, then skips ignored paths
before uploading the note.

## Ignored paths

Add one vault-relative path or glob per line in **Ignored paths**. A folder
entry ignores the folder and all descendants. For example:

```text
Private/
Templates/
*.excalidraw.md
```

The settings page deliberately uses Obsidian's normal single-column `Setting`
layout; it does not create a CSS grid or duplicate setting columns.
