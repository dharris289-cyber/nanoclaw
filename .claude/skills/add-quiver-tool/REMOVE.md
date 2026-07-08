# Remove Quiver Quant Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied tests

```bash
rm -f container/agent-runner/src/providers/quiver-manifest.test.ts \
      container/agent-runner/src/providers/quiver-allow-pattern.test.ts
```

## 2. Unregister the MCP server (per group)

`ncl groups list` shows the groups. For each group that had Quiver wired:

```bash
ncl groups config remove-mcp-server --id <group-id> --name quiver
```

## 3. Remove the mcp-remote manifest entry

Drop the `mcp-remote` entry from `container/cli-tools.json` (idempotent):

```bash
jq 'map(select(.name != "mcp-remote"))' container/cli-tools.json > container/cli-tools.json.tmp \
  && mv container/cli-tools.json.tmp container/cli-tools.json
```

Leave any other tools (`vercel`, `agent-browser`, `@anthropic-ai/claude-code`) in place.

## 4. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## 5. (Optional) Remove the OneCLI secret

Only if no other tool uses the Quiver key. Find and delete the secret in the OneCLI web UI (<http://127.0.0.1:10254>), or via the CLI:

```bash
onecli secrets list | grep -i quiver
onecli secrets delete --id <secret-id>
```
