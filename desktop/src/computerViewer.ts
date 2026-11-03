// Pure helpers for the Computer tab.
//
// Kept apart from the React component so the URL rules, the reconnect cadence
// and the state labels can be unit-tested without a live RFB endpoint — the
// viewer itself needs a real VNC server behind a websockify proxy.

/** Where the last-used viewer URL is remembered. */
export const VIEWER_URL_STORAGE_KEY = "kelp.computer.viewerUrl";

/**
 * The local test session's default. `websockify` presents the RFB stream on a
 * WebSocket, which is the only transport noVNC speaks.
 */
export const DEFAULT_VIEWER_URL = "ws://127.0.0.1:6080/websockify";

export type ViewerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

const WS_SCHEMES = new Set(["ws:", "wss:"]);

/**
 * Accept what people actually paste — a bare host, an http(s) URL, or a ws(s)
 * URL — and return the ws(s) form, or null when it cannot be used.
 *
 * http(s) is rewritten rather than rejected because tunnel providers hand out
 * https links, and a bare host defaults to plain `ws://` because the local test
 * session is the common case.
 */
export function normaliseViewerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? raw : `ws://${raw}`);
  } catch {
    return null;
  }

  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";

  if (!WS_SCHEMES.has(parsed.protocol) || !parsed.host) return null;
  return parsed.toString();
}

/** Backoff for automatic reconnects: 1s, 2s, 5s, 10s, then 15s forever. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

export function reconnectDelay(attempt: number): number {
  const index = Math.max(
    0,
    Math.min(RECONNECT_DELAYS_MS.length - 1, Math.trunc(attempt) - 1),
  );
  return RECONNECT_DELAYS_MS[index];
}

const STATUS_LABELS: Record<ViewerStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Can't connect",
};

export const statusLabel = (status: ViewerStatus): string => STATUS_LABELS[status];

/** Read the remembered URL, or null when storage is unavailable/empty. */
export function readStoredViewerUrl(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(VIEWER_URL_STORAGE_KEY);
    return value?.trim() ? value : null;
  } catch {
    return null; // private mode, or storage disabled
  }
}

/** Remember the URL. Storage failures are not worth interrupting the viewer. */
export function writeStoredViewerUrl(url: string): void {
  try {
    globalThis.localStorage?.setItem(VIEWER_URL_STORAGE_KEY, url);
  } catch {
    /* ignore */
  }
}
