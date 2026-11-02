// Minimal stand-in for `chat/api.py`, used by bridge_contract.test.mjs.
//
// It mirrors just enough of the server's shape (see chat/service.py and
// chat/api.py) to exercise the Rust bridge's transport rules:
//
//   * bearer -> session cookies, once, at sign-in;
//   * cookie callers must supply `Origin` *and* the `csrf` double-submit pair
//     on every mutation, exactly as `_csrf_ok` requires;
//   * SSE frames are `id:`/`event:`/`data:` with an increasing `seq`.
//
// Unlike a throwaway mock it binds an ephemeral port, writes nothing to disk,
// and records every request so a test can assert on the headers that arrived.

import { createServer } from "node:http";

const SESSION_COOKIE = "session=mock-session";
const CSRF_TOKEN = "mock-csrf";

const reply = (res, status, body, cookies = []) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  res.end(payload);
};

const failure = (res, status, code, message) =>
  reply(res, status, { ok: false, error: { code, message } });

const parseCookies = (header = "") => {
  const jar = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

/** Start the mock on an ephemeral port. Resolves to `{ url, requests, close }`. */
export async function startMockServer({ token = "dev-root-token", ttlSeconds = 600 } = {}) {
  const requests = [];
  const streams = new Set();
  let threads = [
    {
      id: "thr_1",
      title: "Mock thread",
      title_source: "user",
      updated_at: new Date().toISOString(),
      message_count: 2,
    },
  ];
  const messages = [
    { id: "msg_1", role: "user", status: "complete", blocks: [{ type: "text", text: "Hello." }] },
    { id: "msg_2", role: "assistant", status: "complete", blocks: [{ type: "text", text: "Hi." }] },
  ];
  let seq = 3;
  let port = 0;

  const broadcast = (frame) => {
    for (const res of streams) {
      res.write(`id: ${frame.seq}\nevent: ${frame.type}\nretry: 2000\ndata: ${JSON.stringify(frame)}\n\n`);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const cookies = parseCookies(req.headers.cookie);
    const authed = cookies.session === "mock-session";

    requests.push({
      method,
      path,
      query: url.search,
      origin: req.headers.origin,
      csrf: req.headers["x-csrf-token"],
      authorization: req.headers.authorization,
      cookies,
    });

    if (path === "/api/auth/session" && method === "POST") {
      if (req.headers.authorization !== `Bearer ${token}`) {
        return failure(res, 401, "unauthorized", "Bad bearer.");
      }
      const body = await readBody(req);
      // The server answers 201 here, not 200; the bridge must tolerate it.
      return reply(
        res,
        201,
        {
          ok: true,
          session: {
            expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
            csrf_token: CSRF_TOKEN,
            device: { id: "dev_1", label: body.device_label ?? "" },
          },
        },
        [`${SESSION_COOKIE}; Path=/; HttpOnly`, `csrf=${CSRF_TOKEN}; Path=/`],
      );
    }

    if (!authed) return failure(res, 401, "unauthorized", "Sign in first.");

    // The mutation gate: same-origin plus the double-submit pair.
    if (method !== "GET") {
      if (req.headers.origin !== `http://127.0.0.1:${port}`) {
        return failure(res, 403, "csrf_failed", "Origin did not match.");
      }
      const header = req.headers["x-csrf-token"] ?? "";
      if (!header || header !== cookies.csrf) {
        return failure(res, 403, "csrf_failed", "Missing or mismatched CSRF header.");
      }
    }

    if (path === "/api/threads" && method === "GET") {
      return reply(res, 200, { ok: true, threads, next_cursor: null });
    }

    if (path === "/api/threads" && method === "POST") {
      const body = await readBody(req);
      const thread = {
        id: `thr_${threads.length + 1}`,
        title: body.title ?? "New chat",
        title_source: "auto",
        updated_at: new Date().toISOString(),
        message_count: 0,
      };
      threads = [thread, ...threads];
      return reply(res, 201, { ok: true, thread });
    }

    const snapshot = /^\/api\/threads\/([^/]+)$/.exec(path);
    if (snapshot && method === "GET") {
      return reply(res, 200, {
        ok: true,
        thread: threads.find((t) => t.id === snapshot[1]) ?? threads[0],
        messages,
        last_seq: seq,
        has_more: false,
      });
    }

    const stream = /^\/api\/threads\/([^/]+)\/stream$/.exec(path);
    if (stream && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      });
      res.write(": keep-alive\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }

    const turn = /^\/api\/threads\/([^/]+)\/turns$/.exec(path);
    if (turn && method === "POST") {
      const body = await readBody(req);
      const threadId = turn[1];
      const text = body.text ?? "";

      seq += 1;
      broadcast({
        seq,
        thread_id: threadId,
        type: "message_created",
        turn_id: "turn_1",
        message: { id: "msg_user", role: "user", status: "complete", turn_id: "turn_1", blocks: [{ type: "text", text }] },
      });
      seq += 1;
      broadcast({
        seq,
        thread_id: threadId,
        type: "message_created",
        turn_id: "turn_1",
        message: { id: "msg_mock", role: "assistant", status: "streaming", turn_id: "turn_1", blocks: [] },
      });
      seq += 1;
      broadcast({ seq, thread_id: threadId, type: "turn_started", turn_id: "turn_1", message_id: "msg_mock", model: "mock" });

      if (text.includes("tool")) {
        seq += 1;
        broadcast({
          seq,
          thread_id: threadId,
          type: "tool_call_started",
          turn_id: "turn_1",
          message_id: "msg_mock",
          call_id: "call_1",
          tool: "shell.run",
          label: "Run a command",
          summary: "echo hi",
          arguments: { command: "echo hi" },
          effects: ["exec"],
          step: 1,
        });
        seq += 1;
        broadcast({
          seq,
          thread_id: threadId,
          type: "tool_call_finished",
          turn_id: "turn_1",
          message_id: "msg_mock",
          call_id: "call_1",
          tool: "shell.run",
          ok: true,
          status: "running",
          duration_ms: 5,
          detail: { result_summary: null },
          step: 1,
        });
        seq += 1;
        broadcast({
          seq,
          thread_id: threadId,
          type: "approval_requested",
          turn_id: "turn_1",
          message_id: "msg_mock",
          approval: {
            id: "apr_1",
            source: "skill",
            thread_id: threadId,
            turn_id: "turn_1",
            call_id: "call_1",
            tool: "shell.run",
            skill: "shell.run",
            title: "Run a command",
            rationale: "Runs a shell command.",
            summary: "echo hi",
            effects: ["exec"],
            arguments: { command: "echo hi" },
            status: "pending",
            single_use: true,
            ttl_seconds: ttlSeconds,
          },
        });
        seq += 1;
        broadcast({
          seq,
          thread_id: threadId,
          type: "turn_finished",
          turn_id: "turn_1",
          message_id: "msg_mock",
          message_status: "awaiting_approval",
          reason: "waiting",
          tool_calls: 1,
        });
        return reply(res, 202, { ok: true, turn_id: "turn_1" });
      }

      for (const word of "Streaming from the bridge.".split(" ")) {
        seq += 1;
        broadcast({ seq, thread_id: threadId, type: "token_delta", turn_id: "turn_1", message_id: "msg_mock", text: `${word} ` });
      }
      seq += 1;
      broadcast({
        seq,
        thread_id: threadId,
        type: "turn_finished",
        turn_id: "turn_1",
        message_id: "msg_mock",
        message_status: "complete",
        reason: "stop",
      });
      return reply(res, 202, { ok: true, turn_id: "turn_1" });
    }

    const decision = /^\/api\/approvals\/([^/]+)\/decision$/.exec(path);
    if (decision && method === "POST") {
      const body = await readBody(req);
      const status = body.decision === "approve" ? "approved" : "denied";
      seq += 1;
      broadcast({
        seq,
        thread_id: "thr_1",
        type: "approval_resolved",
        approval_id: decision[1],
        status,
        actor: "owner",
        executed: false,
      });
      return reply(res, 200, { ok: true, approval_id: decision[1], status });
    }

    return failure(res, 404, "not_found", "No route.");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const res of streams) res.end();
      streams.clear();
      await new Promise((resolve) => server.close(resolve));
      // Keep-alive sockets would otherwise hold the test runner open.
      server.closeAllConnections?.();
    },
  };
}
