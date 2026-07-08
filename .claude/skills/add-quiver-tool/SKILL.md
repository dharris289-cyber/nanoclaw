---
name: add-quiver-tool
description: Add Quiver Quantitative alternative-data as an MCP tool (congressional & insider trades, 13F institutional changes, government contracts, corporate lobbying, dark-pool activity) via Quiver's official remote MCP. The remote endpoint is reached through the `mcp-remote` stdio→HTTP bridge; OneCLI injects the Quiver API bearer at request time so no raw key ever lands in the container. Wire per agent group. Triggers on "quiver", "quiver quant", "congressional trades", "insider trades tool".
---

# Add Quiver Quant Tool (OneCLI-native)

This skill wires Quiver Quantitative's **official remote MCP** (`https://mcp.quiverquant.com/`) into selected agent groups. NanoClaw's MCP config is stdio-only (`command`/`args`/`env`), so the remote endpoint is bridged with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) — a stdio→HTTP MCP bridge installed as a pinned global CLI in the container image. The bridge sends an `onecli-managed` stub bearer; the OneCLI gateway intercepts the outbound call to `mcp.quiverquant.com` and swaps in the real Quiver API key from its vault.

Tools exposed (surfaced to the agent as `mcp__quiver__<name>`) cover congressional trading, SEC Form 4 insider transactions, 13F institutional holdings changes, government contracts, corporate lobbying, WallStreetBets activity, and off-exchange (dark-pool) short volume. The exact tool set is defined by Quiver's server and may grow over time.

**Why this pattern:** v2's invariant is that containers never receive raw API keys — OneCLI is the sole credential path (skill-guidelines.md anti-pattern #5). The stub-bearer + gateway-injection flow satisfies it: the container sees `Bearer onecli-managed`, the gateway rewrites it in flight for the `mcp.quiverquant.com` host.

**Prerequisite:** A Quiver API key (paid; from ~$30/mo). Get one at <https://www.quiverquant.com/> → API. You never paste it into NanoClaw — it lives in the OneCLI vault (Phase 1).

## Phase 1: Pre-flight

### Store the Quiver API key in the OneCLI vault

Quiver is a custom API-key service, not a preset OneCLI OAuth app, so add it as a **custom secret with a host pattern**. Open the OneCLI web UI at <http://127.0.0.1:10254> and add a secret configured to inject an `Authorization` header on requests to Quiver:

- **Host pattern:** `mcp.quiverquant.com`
- **Injected header:** `Authorization` = `Bearer <your Quiver API key>`

This is the general custom-app credential pattern documented at <https://www.onecli.sh/docs/guides/credential-stubs/general-app>. The container never sees the key; the gateway attaches it per request to the matching host.

Confirm it landed:

```bash
onecli secrets list | grep -i quiver
```

### Check agent secret-mode

For each target agent group, OneCLI must inject the Quiver secret into its container. Find the OneCLI agent whose id matches the group's `agentGroupId`:

```bash
onecli agents list
```

If that agent's `secretMode` is `all`, you're done — the Quiver secret (matched by its `mcp.quiverquant.com` host pattern) auto-injects. If it's `selective`, assign the Quiver secret explicitly with the safe merge pattern (`set-secrets` replaces the whole list — always read first):

```bash
QUIVER_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)quiver")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$QUIVER_IDS" | tr ',' '\n' | grep -v '^$' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q '"mcp-remote"' container/cli-tools.json && echo "ALREADY APPLIED — skip to Phase 3"
```

### Add the mcp-remote bridge to the image manifest

Global Node CLIs the agent invokes at runtime live in `container/cli-tools.json`; a skill adds one by appending an entry (a JSON merge) rather than editing the Dockerfile. `install-cli-tools.sh` installs each via `pnpm install -g`, pinned. `mcp-remote` has no native postinstall, so no `onlyBuilt` flag.

Append the entry with `jq` (idempotent — dedupes on `name`):

```bash
jq '(map(.name) | index("mcp-remote")) as $i
    | if $i == null then . + [{"name":"mcp-remote","version":"0.1.38"}] else . end' \
   container/cli-tools.json > container/cli-tools.json.tmp \
  && mv container/cli-tools.json.tmp container/cli-tools.json
cat container/cli-tools.json
```

Pinned version matters — `pnpm install -g` in the image is subject to the supply-chain policy and CLAUDE.md requires an exact version for every Node CLI baked into the image. `0.1.38` (published 2026-02-05) is well clear of the 3-day `minimumReleaseAge` gate. Re-check the pin before bumping.

### Copy the skill's tests into the container tree

Both integration points live in the container (Bun) tree — the image package install and the dynamic allow-pattern derivation in `claude.ts` — so the guards go there. `cp` overwrites, so re-running is safe.

```bash
S=.claude/skills/add-quiver-tool
cp $S/quiver-manifest.test.ts      container/agent-runner/src/providers/quiver-manifest.test.ts
cp $S/quiver-allow-pattern.test.ts container/agent-runner/src/providers/quiver-allow-pattern.test.ts
```

- `quiver-manifest.test.ts` asserts `container/cli-tools.json` still carries an `mcp-remote` entry pinned to an exact version — the bridge binary is Dockerfile-installed, not importable or typed, so this structural guard is what goes red if the install is dropped.
- `quiver-allow-pattern.test.ts` asserts `claude.ts` still spreads `Object.keys(this.mcpServers).map(mcpAllowPattern)` into `allowedTools` — the derivation that makes registering `quiver` (Phase 3) enough to expose `mcp__quiver__*`.

### Rebuild the container image

```bash
./container/build.sh
```

Must complete cleanly. The new `pnpm install -g mcp-remote` layer is quick and cached on rebuild.

## Phase 3: Wire Per-Agent-Group

For each agent group that should have Quiver (ask the user — typically their personal DM / research agents), register the `quiver` MCP server in the **central DB** (`data/v2.db`). It flows through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### List groups, pick which ones get Quiver

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name quiver \
  --command mcp-remote \
  --args '["https://mcp.quiverquant.com/","--enable-proxy","--header","Authorization:${AUTH_HEADER}"]' \
  --env '{"AUTH_HEADER":"Bearer onecli-managed"}'
```

Three details are load-bearing:

- **`--enable-proxy`** makes `mcp-remote` honor `HTTPS_PROXY` — the OneCLI gateway. Without it the bridge connects to Quiver directly, the gateway never sees the request, no key is injected, and every call returns `401`.
- **`Authorization:${AUTH_HEADER}` with `AUTH_HEADER=Bearer onecli-managed`** is Quiver's documented header form. `mcp-remote` expands `${AUTH_HEADER}` from its own env; the no-space-after-colon form avoids `mcp-remote`'s header-parsing quirk. The value is the `onecli-managed` stub — the gateway rewrites it to the real bearer for `mcp.quiverquant.com`.
- **Server name `quiver`** is what sets the tool prefix `mcp__quiver__*` (via `mcpAllowPattern` in `claude.ts`). Keep it lowercase and simple.

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated; from a host operator shell with full scope, it executes immediately. Either way the response tells you which path it took. The change requires `ncl groups restart` (Phase 4) to take effect.

## Phase 4: Build, Validate, Restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/providers/quiver-manifest.test.ts src/providers/quiver-allow-pattern.test.ts)
```

All must be clean before proceeding. `quiver-manifest.test.ts` confirms the bridge install is wired into the image; `quiver-allow-pattern.test.ts` confirms the derivation that exposes `mcp__quiver__*`. A failure means one drifted.

Restart so the wired groups pick up the new server (run from your NanoClaw project root):

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Or, to restart a single group with an on-wake nudge:

```bash
ncl groups restart --id <group-id> --message "Quiver tools are wired — confirm mcp__quiver__* is available."
```

## Phase 5: Verify

### Test from the wired agent

Tell the user:

> In your `<agent-name>` chat, ask: **"What congressional trades happened recently?"** or **"Show me recent insider transactions for NVDA."**
>
> The agent should call an `mcp__quiver__*` tool. The first call may take a second or two while `mcp-remote` starts and OneCLI attaches the key.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'quiver|mcp-remote|mcp'
# Per-container logs — session-scoped:
ls data/v2-sessions/*/stderr.log | head
```

Common signals:

- `command not found: mcp-remote` → image wasn't rebuilt, or the manifest edit didn't land. Re-check `container/cli-tools.json` and re-run `./container/build.sh`.
- `401 Unauthorized` from `mcp.quiverquant.com` → the key isn't being injected. Most often **`--enable-proxy` is missing** from the args (the bridge is bypassing the gateway). Otherwise: the OneCLI secret's host pattern doesn't match `mcp.quiverquant.com`, or the agent's secret mode excludes it (`onecli agents secrets --id <agent-id>`).
- Agent says "I don't have Quiver tools" → the `quiver` server isn't registered in this group's `mcpServers` (re-run the Phase 3 `ncl groups config add-mcp-server` for that group and restart it), or the image is stale (rebuild with `./container/build.sh`).
- Bridge hangs on start → `mcp-remote` may be attempting an OAuth flow. Confirm the `--header` arg is present so it uses static-header auth instead.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure (delete the copied tests, unregister the server per group, drop the manifest entry, rebuild, and optionally remove the OneCLI secret).

## Notes

- **Tool-only, not a channel.** This gives the agent Quiver *tools*; it does not make Quiver data push messages to the agent. Scheduled digests are a separate piece of work (a recurring task that calls the tools).
- **Plain-env fallback (not recommended).** If you are not running OneCLI, you could put the real key directly in the server's `env` (`AUTH_HEADER=Bearer <key>`) and drop `--enable-proxy`. This violates v2's no-raw-keys invariant (the key lands in `data/v2.db` and the materialized `container.json`), so only do it on an install with no OneCLI gateway, and never commit that config.
- **Endpoint and tool set are Quiver's.** If Quiver changes the endpoint path or auth scheme, update the `--args` URL / `--header` here. Bumping `mcp-remote` is a manifest version change plus an image rebuild.

## Credits & references

- **Remote MCP:** Quiver Quantitative — <https://api.quiverquant.com/mcp-server/>, setup at <https://www.quiverquant.com/mcp-setup/>.
- **Bridge:** [`mcp-remote`](https://github.com/geelen/mcp-remote) by geelen — MIT-licensed. `--enable-proxy` enables `HTTPS_PROXY` honoring.
- **OneCLI credential stubs:** general custom-app pattern at <https://www.onecli.sh/docs/guides/credential-stubs/general-app>.
- **Skill pattern:** modeled on [`add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`add-atomic-chat-tool`](../add-atomic-chat-tool/SKILL.md).
