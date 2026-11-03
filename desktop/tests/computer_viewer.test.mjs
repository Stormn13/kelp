import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIEWER_URL,
  RECONNECT_DELAYS_MS,
  VIEWER_URL_STORAGE_KEY,
  normaliseViewerUrl,
  readStoredViewerUrl,
  reconnectDelay,
  statusLabel,
  writeStoredViewerUrl,
} from "../src/computerViewer.ts";

// noVNC speaks WebSocket only, so the URL rules are the difference between a
// viewer that connects and one that sits on "Connecting…" forever.

describe("normaliseViewerUrl", () => {
  it("accepts a ws:// endpoint unchanged", () => {
    assert.equal(
      normaliseViewerUrl("ws://127.0.0.1:6080/websockify"),
      "ws://127.0.0.1:6080/websockify",
    );
  });

  it("keeps wss:// (and its query) for a tunnelled endpoint", () => {
    assert.equal(
      normaliseViewerUrl("wss://vm.example.test/view?token=abc"),
      "wss://vm.example.test/view?token=abc",
    );
  });

  it("rewrites http(s) — what tunnel providers hand out — to ws(s)", () => {
    assert.equal(
      normaliseViewerUrl("http://127.0.0.1:6080/websockify"),
      "ws://127.0.0.1:6080/websockify",
    );
    assert.equal(
      normaliseViewerUrl("https://vm.example.test/vnc"),
      "wss://vm.example.test/vnc",
    );
  });

  it("treats a bare host as a local ws endpoint", () => {
    assert.equal(
      normaliseViewerUrl("127.0.0.1:6080/websockify"),
      "ws://127.0.0.1:6080/websockify",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normaliseViewerUrl("  ws://h:1/x  "), "ws://h:1/x");
  });

  it("rejects what it cannot use", () => {
    for (const bad of ["", "   ", "not a url", "ftp://host/x", "ws://"]) {
      assert.equal(normaliseViewerUrl(bad), null, JSON.stringify(bad));
    }
  });

  it("ships a usable local default", () => {
    assert.equal(normaliseViewerUrl(DEFAULT_VIEWER_URL), DEFAULT_VIEWER_URL);
  });
});

describe("reconnectDelay", () => {
  it("follows the published ladder and then caps", () => {
    assert.deepEqual(RECONNECT_DELAYS_MS, [1_000, 2_000, 5_000, 10_000, 15_000]);
    assert.equal(reconnectDelay(1), 1_000);
    assert.equal(reconnectDelay(2), 2_000);
    assert.equal(reconnectDelay(3), 5_000);
    assert.equal(reconnectDelay(4), 10_000);
    assert.equal(reconnectDelay(5), 15_000);
    assert.equal(reconnectDelay(99), 15_000);
  });

  it("never returns something silly for an odd attempt number", () => {
    assert.equal(reconnectDelay(0), 1_000);
    assert.equal(reconnectDelay(-4), 1_000);
    assert.equal(reconnectDelay(2.7), 2_000);
  });
});

describe("statusLabel", () => {
  it("labels every one of the five states", () => {
    const expected = {
      idle: "Not connected",
      connecting: "Connecting…",
      connected: "Connected",
      disconnected: "Disconnected",
      error: "Can't connect",
    };
    for (const [status, label] of Object.entries(expected)) {
      assert.equal(statusLabel(status), label);
    }
  });
});

describe("remembered viewer url", () => {
  let store;

  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        store.set(key, String(value));
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };
  });

  it("round-trips through storage", () => {
    assert.equal(readStoredViewerUrl(), null);
    writeStoredViewerUrl("wss://vm.example.test/view");
    assert.equal(readStoredViewerUrl(), "wss://vm.example.test/view");
    assert.equal(store.get(VIEWER_URL_STORAGE_KEY), "wss://vm.example.test/view");
  });

  it("treats a blank value as absent", () => {
    writeStoredViewerUrl("   ");
    assert.equal(readStoredViewerUrl(), null);
  });

  it("survives storage that throws (private mode, disabled storage)", () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    assert.equal(readStoredViewerUrl(), null);
    assert.doesNotThrow(() => writeStoredViewerUrl("ws://h:1/x"));
  });
});
