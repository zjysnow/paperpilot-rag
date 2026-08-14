#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
	echo "Usage: $0 /path/to/obsidian-vault" >&2
	exit 2
fi

vault_path="${1%/}"
if [[ ! -d "$vault_path" ]]; then
	echo "Obsidian vault does not exist: $1" >&2
	exit 1
fi

plugin_path="$vault_path/.obsidian/plugins/paperpilot-rag"
if [[ "$plugin_path" == "/" || "$plugin_path" == "$vault_path" || "$plugin_path" == "$vault_path/.obsidian/plugins" ]]; then
	echo "Refusing to clear an unsafe installation path: $plugin_path" >&2
	exit 1
fi

npm run build
mkdir -p "$vault_path/.obsidian/plugins"
rm -rf "$plugin_path"
mkdir -p "$plugin_path"
cp main.js manifest.json "$plugin_path/"

printf 'Installed Paper Pilot Rag into %s\n' "$plugin_path"
