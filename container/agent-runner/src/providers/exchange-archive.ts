import fs from 'fs';
import path from 'path';

/**
 * Per-thread conversation archive for providers with no on-disk transcript —
 * payload code, shipped with the provider that needs it. The provider's
 * `onExchangeComplete` hook (see types.ts) calls this with each completed
 * exchange; the runner never archives on a provider's behalf.
 *
 * One file per thread (keyed on the continuation id), appended to as exchanges
 * complete — mirroring the Claude path's one-file-per-session granularity,
 * since the Codex app-server keeps history server-side with no transcript to
 * roll up at a compaction boundary.
 */

const DEFAULT_CONVERSATIONS_DIR = '/workspace/agent/conversations';

export interface ProviderExchangeArchiveOptions {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp?: Date;
  conversationsDir?: string;
}

/**
 * Append a single prompt/result exchange to its thread's conversation file,
 * writing the thread-level header once when the file is first created. Returns
 * the (thread-stable) filename, or null when there is nothing to archive
 * (empty result).
 */
export function archiveProviderExchange(options: ProviderExchangeArchiveOptions): string | null {
  const result = options.result?.trim();
  if (!result) return null;

  const timestamp = options.timestamp ?? new Date();
  const conversationsDir =
    options.conversationsDir || process.env.NANOCLAW_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR;
  fs.mkdirSync(conversationsDir, { recursive: true });

  const filename = threadArchiveFilename(options.provider, options.continuation);
  const filePath = path.join(conversationsDir, filename);

  // Thread-level metadata (provider, thread id) belongs in the header, written
  // once. Per-exchange metadata (timestamp, status) rides in each appended
  // block. Each block leads with a blank line + `---` so the separator renders
  // as a thematic break, not a setext heading underline on the prior line.
  const parts: string[] = [];
  if (!fs.existsSync(filePath)) {
    parts.push(
      `# ${titleCase(options.provider)} Conversation`,
      '',
      `Provider: ${options.provider}`,
      `Continuation/thread id: ${options.continuation || '(none)'}`,
    );
  }
  parts.push(
    '',
    '---',
    '',
    `Archived: ${timestamp.toISOString()} · Status: ${options.status}`,
    '',
    `**User**: ${truncate(options.prompt)}`,
    '',
    `**Assistant**: ${truncate(result)}`,
    '',
  );
  fs.appendFileSync(filePath, parts.join('\n'));
  return filename;
}

function threadArchiveFilename(provider: string, continuation: string | undefined): string {
  const thread = sanitizeSlug(continuation || 'no-thread').slice(0, 48) || 'no-thread';
  return `${sanitizeSlug(provider)}-${thread}.md`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : 'Provider';
}

function truncate(value: string): string {
  return value.length > 2000 ? value.slice(0, 2000) + '...' : value;
}
