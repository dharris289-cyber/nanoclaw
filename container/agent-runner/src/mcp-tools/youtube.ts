/**
 * YouTube Research MCP tools.
 * Provides search, video details, channel browsing, and transcript tools
 * via the YouTube Data API v3 plus public transcript extraction.
 *
 * API key is read from /workspace/global/youtube-config.json (mounted at
 * runtime by all containers), falling back to YOUTUBE_API_KEY env var.
 */
import fs from 'fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const CONFIG_PATH = '/workspace/global/youtube-config.json';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

function loadApiKey(): string {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as { youtubeApiKey?: string };
    return config.youtubeApiKey || '';
  } catch {
    return process.env.YOUTUBE_API_KEY || '';
  }
}

const API_KEY = loadApiKey();

function parseDuration(iso: string): string {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const parts = [m[1] && `${m[1]}h`, m[2] && `${m[2]}m`, m[3] && `${m[3]}s`].filter(Boolean);
  return parts.join(' ') || '0s';
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TranscriptItem {
  start: number;
  duration: number;
  text: string;
}

async function fetchTranscript(videoId: string, lang: string): Promise<TranscriptItem[] | null> {
  try {
    const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }).then((r) => r.text());

    const captionsIdx = html.indexOf('"captions":');
    if (captionsIdx === -1) return null;
    const braceStart = html.indexOf('{', captionsIdx + 11);
    if (braceStart === -1) return null;

    let depth = 0;
    let braceEnd = braceStart;
    for (let i = braceStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          braceEnd = i + 1;
          break;
        }
      }
    }

    const captionsJson = JSON.parse(html.slice(braceStart, braceEnd)) as {
      playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ languageCode: string; baseUrl?: string }> };
    };
    const tracks = captionsJson?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) return null;

    const track =
      tracks.find((t) => t.languageCode === lang) ??
      tracks.find((t) => t.languageCode.startsWith(lang.split('-')[0])) ??
      tracks[0];
    if (!track?.baseUrl) return null;

    const xmlText = await fetch(track.baseUrl).then((r) => r.text());
    const items: TranscriptItem[] = [];
    const regex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(xmlText)) !== null) {
      const text = decodeHtml(m[3]);
      if (text) items.push({ start: parseFloat(m[1]), duration: parseFloat(m[2]), text });
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function apiError(data: { error?: { message?: string; code?: number } }): string {
  return data.error?.message
    ? `YouTube API error ${data.error.code}: ${data.error.message}`
    : 'YouTube API returned an unexpected error.';
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

const tools: McpToolDefinition[] = [
  {
    tool: {
      name: 'youtube_search',
      description:
        'Search YouTube for videos. Returns videoId, title, channel, published date, description snippet, and URL.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search terms' },
          maxResults: { type: 'number', description: 'Number of results (1–25, default 5)' },
          order: {
            type: 'string',
            enum: ['relevance', 'date', 'viewCount', 'rating'],
            description: 'Sort order (default: relevance)',
          },
        },
        required: ['query'],
      },
    },
    async handler(args) {
      if (!API_KEY) return text('YouTube API key not configured.');
      const query = args.query as string;
      const maxResults = Math.min(25, Math.max(1, (args.maxResults as number) || 5));
      const order = (args.order as string) || 'relevance';
      const url = new URL(`${YOUTUBE_API_BASE}/search`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', String(maxResults));
      url.searchParams.set('order', order);
      url.searchParams.set('type', 'video');
      url.searchParams.set('key', API_KEY);
      const res = await fetch(url.toString());
      const data = (await res.json()) as {
        error?: { message?: string; code?: number };
        items?: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string; description: string } }>;
      };
      if (!res.ok) return text(apiError(data));
      const results = (data.items ?? []).map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        published: item.snippet.publishedAt.slice(0, 10),
        description: item.snippet.description.slice(0, 300),
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      }));
      return text(JSON.stringify(results, null, 2));
    },
  },
  {
    tool: {
      name: 'youtube_video_details',
      description:
        'Get detailed information about a YouTube video: title, channel, duration, view/like counts, tags, full description.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          videoId: { type: 'string', description: 'YouTube video ID, e.g. dQw4w9WgXcQ' },
        },
        required: ['videoId'],
      },
    },
    async handler(args) {
      if (!API_KEY) return text('YouTube API key not configured.');
      const videoId = args.videoId as string;
      const url = new URL(`${YOUTUBE_API_BASE}/videos`);
      url.searchParams.set('part', 'snippet,statistics,contentDetails');
      url.searchParams.set('id', videoId);
      url.searchParams.set('key', API_KEY);
      const res = await fetch(url.toString());
      const data = (await res.json()) as {
        error?: { message?: string; code?: number };
        items?: Array<{
          snippet: { title: string; channelTitle: string; channelId: string; publishedAt: string; tags?: string[]; description: string };
          statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
          contentDetails: { duration: string };
        }>;
      };
      if (!res.ok) return text(apiError(data));
      if (!data.items?.length) return text(`Video not found: ${videoId}`);
      const v = data.items[0];
      const result = {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        channelId: v.snippet.channelId,
        published: v.snippet.publishedAt.slice(0, 10),
        duration: parseDuration(v.contentDetails.duration),
        views: Number(v.statistics.viewCount ?? 0).toLocaleString(),
        likes: Number(v.statistics.likeCount ?? 0).toLocaleString(),
        comments: Number(v.statistics.commentCount ?? 0).toLocaleString(),
        tags: v.snippet.tags ?? [],
        description: v.snippet.description,
      };
      return text(JSON.stringify(result, null, 2));
    },
  },
  {
    tool: {
      name: 'youtube_transcript',
      description:
        'Fetch the full transcript/captions of a YouTube video as plain text or timestamped segments.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          videoId: { type: 'string', description: 'YouTube video ID' },
          language: { type: 'string', description: 'Language code, e.g. "en", "es", "fr" (default: "en")' },
          includeTimestamps: {
            type: 'boolean',
            description: 'Include [mm:ss] timestamps (default: false)',
          },
        },
        required: ['videoId'],
      },
    },
    async handler(args) {
      const videoId = args.videoId as string;
      const language = (args.language as string) || 'en';
      const includeTimestamps = Boolean(args.includeTimestamps);
      const items = await fetchTranscript(videoId, language);
      if (!items) {
        return text(
          `No transcript available for video ${videoId}. The video may have captions disabled or no captions in language "${language}".`,
        );
      }
      let transcript: string;
      if (includeTimestamps) {
        transcript = items
          .map((item) => {
            const mins = Math.floor(item.start / 60).toString().padStart(2, '0');
            const secs = Math.floor(item.start % 60).toString().padStart(2, '0');
            return `[${mins}:${secs}] ${item.text}`;
          })
          .join('\n');
      } else {
        transcript = items.map((i) => i.text).join(' ');
      }
      return text(transcript);
    },
  },
  {
    tool: {
      name: 'youtube_channel_videos',
      description:
        'List the most recent videos uploaded to a YouTube channel. Accepts channel ID (UCxxxx) or @handle.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: {
            type: 'string',
            description: 'Channel ID (UCxxxx) or @handle (e.g. @veritasium)',
          },
          maxResults: { type: 'number', description: 'Number of videos to return (1–25, default 10)' },
        },
        required: ['channel'],
      },
    },
    async handler(args) {
      if (!API_KEY) return text('YouTube API key not configured.');
      let channelId = args.channel as string;
      const maxResults = Math.min(25, Math.max(1, (args.maxResults as number) || 10));

      if (channelId.startsWith('@') || !channelId.startsWith('UC')) {
        const searchUrl = new URL(`${YOUTUBE_API_BASE}/search`);
        searchUrl.searchParams.set('part', 'snippet');
        searchUrl.searchParams.set('q', channelId);
        searchUrl.searchParams.set('type', 'channel');
        searchUrl.searchParams.set('maxResults', '1');
        searchUrl.searchParams.set('key', API_KEY);
        const searchRes = await fetch(searchUrl.toString());
        const searchData = (await searchRes.json()) as {
          error?: { message?: string; code?: number };
          items?: Array<{ id: { channelId: string } }>;
        };
        if (!searchRes.ok) return text(apiError(searchData));
        if (!searchData.items?.length) return text(`Channel not found: ${channelId}`);
        channelId = searchData.items[0].id.channelId;
      }

      const url = new URL(`${YOUTUBE_API_BASE}/search`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('channelId', channelId);
      url.searchParams.set('order', 'date');
      url.searchParams.set('type', 'video');
      url.searchParams.set('maxResults', String(maxResults));
      url.searchParams.set('key', API_KEY);
      const res = await fetch(url.toString());
      const data = (await res.json()) as {
        error?: { message?: string; code?: number };
        items?: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string } }>;
      };
      if (!res.ok) return text(apiError(data));
      const videos = (data.items ?? []).map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        published: item.snippet.publishedAt.slice(0, 10),
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      }));
      return text(JSON.stringify(videos, null, 2));
    },
  },
];

registerTools(tools);
