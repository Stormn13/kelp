// Contract test for the rules the Rust bridge must honour (bridge.rs).
//
// The bridge is not a browser: it supplies the `Origin` and the CSRF
// double-submit half itself, keeps the cookie jar, and forwards SSE frames as
// `chat-event`. None of that is covered by the unit tests for the transcript
// projection, so this replays the exact HTTP sequence against the mock server
// and fails if the bridge's assumptions about the server stop holding.
//
// Node's fetch has no cookie jar, so the jar is replicated by hand — the same
// job reqwest does in Rust.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startMockServer } from "./support/mock_server.mjs";

const cookies = new Map();
let mock;
let base;

const cookieHeader = () =>
  [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

/** Capture Set-Cookie the way reqwest's cookie store does. */
function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq !== -1) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function call(method, path, { body, headers = {} } = {}) {
  const request = { ...headers };
  if (cookieHeader()) request.cookie = cookieHeader();
  if (body !== undefined) request["content-type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers: request,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(response);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is itself worth asserting on; callers read `text` */
  }
  return { status: response.status, json, text };
}

/** The headers bridge.rs adds to every mutation. */
const mutationHeaders = () => ({
  origin: base,
  "x-csrf-token": cookies.get("csrf") ?? "",
});

/** Collect SSE frames for a thread until `predicate` says stop. */
async function collectFrames(threadId, send, predicate, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/threads/${threadId}/stream?after=0`, {
    headers: { accept: "text/event-stream", cookie: cookieHeader() },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);

  const frames = [];
  let buffer = "";
  const pump = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index + 2);
        buffer = buffer.slice(index + 2);
        const id = /^id:\s*(.+)$/m.exec(frame)?.[1];
        const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (data) frames.push({ seq: Number(id), ...JSON.parse(data) });
      }
    }
  })();

  await send();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !frames.some(predicate)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  controller.abort();
  await pump.catch(() => {});
  return frames;
}

before(async () => {
  mock = await startMockServer();
  base = mock.url;
});

after(async () => {
  await mock.close();
});

describe("bridge contract", () => {
  it("refuses an unauthenticated read with 401", async () => {
    const { status, json } = await call("GET", "/api/threads?limit=50");
    assert.equal(status, 401);
    assert.equal(json.error.code, "unauthorized");
  });

  it("exchanges the bearer for cookies and answers 201", async () => {
    const { status, json } = await call("POST", "/api/auth/session", {
      headers: { authorization: "Bearer dev-root-token" },
      body: { device_label: "Kelp desktop" },
    });
    // The server returns 201, not 200 — the bridge must not assume `ok`.
    assert.equal(status, 201);
    assert.equal(json.session.device.label, "Kelp desktop");
    assert.equal(cookies.get("session"), "mock-session");
    assert.equal(cookies.get("csrf"), "mock-csrf");

    const sent = mock.requests.at(-1);
    assert.equal(sent.authorization, "Bearer dev-root-token");
    assert.equal(sent.origin, undefined, "sign-in must not carry Origin");
  });

  it("lists threads once the jar holds the session", async () => {
    const { status, json } = await call("GET", "/api/threads?limit=50");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.threads));
    assert.equal(json.next_cursor, null);
  });

  it("reads a thread snapshot with the fields the client expects", async () => {
    const { status, json } = await call("GET", "/api/threads/thr_1");
    assert.equal(status, 200);
    assert.ok(json.thread.id);
    assert.ok(Array.isArray(json.messages));
    assert.equal(typeof json.last_seq, "number");
    assert.equal(typeof json.has_more, "boolean");
  });

  it("rejects a mutation that omits the CSRF half", async () => {
    // Exactly what bridge.rs would send if it forgot `X-CSRF-Token`.
    const { status, json } = await call("POST", "/api/threads", {
      headers: { origin: base },
      body: {},
    });
    assert.equal(status, 403);
    assert.equal(json.error.code, "csrf_failed");
  });

  it("rejects a mutation whose Origin is not the server", async () => {
    const { status } = await call("POST", "/api/threads", {
      headers: { origin: "tauri://localhost", "x-csrf-token": cookies.get("csrf") },
      body: {},
    });
    assert.equal(status, 403);
  });

  it("accepts a mutation carrying Origin and the matching CSRF half", async () => {
    const { status, json } = await call("POST", "/api/threads", {
      headers: mutationHeaders(),
      body: { title: "From the bridge" },
    });
    assert.equal(status, 201);
    assert.equal(json.thread.title, "From the bridge");

    const sent = mock.requests.at(-1);
    assert.equal(sent.origin, base);
    assert.equal(sent.csrf, cookies.get("csrf"));
  });

  it("streams the tool-call and approval sequence", async () => {
    const frames = await collectFrames(
      "thr_1",
      async () => {
        const { status } = await call("POST", "/api/threads/thr_1/turns", {
          headers: mutationHeaders(),
          body: { client_turn_id: "ct-contract-1", text: "run a tool please" },
        });
        assert.equal(status, 202);
      },
      (frame) => frame.type === "turn_finished",
    );

    const types = frames.map((frame) => frame.type);
    assert.ok(types.includes("message_created"));
    assert.ok(types.includes("turn_started"));
    assert.ok(types.includes("tool_call_started"));
    assert.ok(types.includes("tool_call_finished"));
    assert.ok(types.includes("approval_requested"));
    assert.ok(types.includes("turn_finished"));

    const card = frames.find((frame) => frame.type === "approval_requested").approval;
    assert.equal(card.id, "apr_1");
    assert.equal(card.call_id, "call_1");
    assert.equal(card.status, "pending");

    // `id:` is the SSE seq the client dedupes on; it must strictly increase.
    const seqs = frames.map((frame) => frame.seq).filter(Boolean);
    assert.ok(seqs.length > 1);
    assert.ok(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), seqs.join(","));
  });

  it("settles the approval and streams the resolution", async () => {
    const frames = await collectFrames(
      "thr_1",
      async () => {
        const { status, json } = await call("POST", "/api/approvals/apr_1/decision", {
          headers: mutationHeaders(),
          body: { decision: "deny" },
        });
        assert.equal(status, 200);
        assert.equal(json.status, "denied");
      },
      (frame) => frame.type === "approval_resolved",
    );

    const resolved = frames.find((frame) => frame.type === "approval_resolved");
    assert.equal(resolved.approval_id, "apr_1");
    assert.equal(resolved.status, "denied");

    const sent = mock.requests.at(-1);
    assert.equal(sent.origin, base);
    assert.equal(sent.csrf, cookies.get("csrf"));
  });
});
