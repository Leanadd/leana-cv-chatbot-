const SYSTEM_PROMPT = require("../lib/context.js");

const MODEL = "gemini-3.8-flash";
const MAX_OUTPUT_TOKENS = 900;
const MAX_MESSAGES = 20; // last N turns kept (trims older history)
const MAX_MESSAGE_CHARS = 4000;

// Best-effort in-memory rate limit. Resets on cold start; good enough to
// blunt a burst from one IP without adding external infra.
const buckets = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    buckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  buckets.set(ip, hits);
  return false;
}

function sanitizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const trimmed = input.slice(-MAX_MESSAGES);
  const cleaned = [];
  for (const m of trimmed) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" || !m.content.trim()) return null;
    cleaned.push({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) });
  }
  if (cleaned[cleaned.length - 1].role !== "user") return null;
  // Gemini (like Anthropic) expects strict user/assistant alternation.
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].role === cleaned[i - 1].role) return null;
  }
  return cleaned;
}

function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
  }

  const messages = sanitizeMessages(body && body.messages);
  if (!messages) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const debug = req.query && req.query.debug === "1";
  const genConfig = {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: { thinkingBudget: 0 },
  };

  if (debug) {
    // Temporary inspection path: non-streaming call, raw JSON back.
    // Remove once the response shape is confirmed.
    const debugUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL +
      ":generateContent?key=" +
      process.env.GEMINI_API_KEY;
    try {
      const r = await fetch(debugUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: toGeminiContents(messages),
          generationConfig: genConfig,
        }),
      });
      const j = await r.json();
      res.status(200).json(j);
    } catch (e) {
      res.status(502).json({ error: "debug_failed", message: String(e) });
    }
    return;
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODEL +
    ":streamGenerateContent?alt=sse&key=" +
    process.env.GEMINI_API_KEY;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: toGeminiContents(messages),
        generationConfig: genConfig,
      }),
    });
  } catch (e) {
    res.status(502).json({ error: "upstream_error" });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      detail = (await upstream.text()).slice(0, 500);
    } catch (e) {
      // ignore
    }
    res.status(502).json({ error: "upstream_error", detail });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = rawEvent.split("\n").find((l) => l.indexOf("data:") === 0);
        if (!dataLine) continue;
        let parsed;
        try {
          parsed = JSON.parse(dataLine.slice(5).trim());
        } catch (e) {
          continue;
        }
        if (parsed.promptFeedback && parsed.promptFeedback.blockReason) {
          sendEvent(res, { error: { type: "blocked" } });
          continue;
        }
        const candidate = parsed.candidates && parsed.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
        if (text) sendEvent(res, { delta: text });
      }
    }
  } catch (e) {
    // connection dropped mid-stream — just end below
  }
  sendEvent(res, { done: true });
  res.end();
};
