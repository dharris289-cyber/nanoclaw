/**
 * Structural guard for the mcp-remote install the Quiver tool depends on.
 *
 * The Quiver MCP is Quiver's official remote endpoint (https://mcp.quiverquant.com/),
 * reached from the container through the `mcp-remote` stdio->HTTP bridge. That bridge
 * is a global Node CLI installed into the image from container/cli-tools.json. It is
 * not importable or typed from this tree, so neither the build leg nor a runtime test
 * sees its removal. This asserts the manifest still carries an `mcp-remote` entry pinned
 * to an exact version. Drop it and this goes red, signalling the agent would boot without
 * the `mcp-remote` binary on PATH and the `quiver` MCP server would fail to start.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

type CliTool = { name: string; version: string; onlyBuilt?: boolean };

function cliTools(): CliTool[] {
  // container/agent-runner/src/providers/ -> ../../../cli-tools.json == container/cli-tools.json
  const p = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CliTool[];
}

describe('container/cli-tools.json installs the mcp-remote bridge', () => {
  const entry = cliTools().find((t) => t.name === 'mcp-remote');

  it('includes an mcp-remote entry', () => {
    expect(entry).toBeDefined();
  });

  it('pins mcp-remote to an exact version (no ranges, no "latest")', () => {
    expect(entry?.version).toBeDefined();
    // Exact semver only — reject ^, ~, x-ranges, and "latest".
    expect(/^\d+\.\d+\.\d+/.test(entry!.version)).toBe(true);
  });
});
