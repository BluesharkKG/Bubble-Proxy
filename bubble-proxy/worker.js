// ================================================================
//  Bubble Proxy — Cloudflare Worker
//  Deploy: wrangler deploy
// ================================================================

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const STRIP_REQ = new Set(["cookie", "authorization", "host"]);

const STRIP_RES = new Set(["set-cookie", "server", "x-powered-by"]);

const STRIP_FRAME = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

const TIMEOUT_MS = 10_000;

function jsonError(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function isPrivateHost(hostname) {
  const hardcoded = [
    "localhost", "127.0.0.1", "0.0.0.0",
    "169.254.169.254", "metadata.google.internal", "::1",
  ];
  if (hardcoded.includes(hostname)) return true;

  return [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^127\./,
    /^0\./,
    /^169\.254\./,
    /^fc00:/i,
    /^fe80:/i,
  ].some((re) => re.test(hostname));
}

function validateUrl(raw) {
  if (!raw) return { ok: false, error: "Missing 'url' query parameter" };

  let parsed;
  try { parsed = new URL(raw); }
  catch { return { ok: false, error: "Invalid URL" }; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Scheme '${parsed.protocol}' is not allowed` };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: "Blocked URL" };
  }
  return { ok: true, url: parsed };
}

function buildReqHeaders(incoming) {
  const out = new Headers();
  for (const [k, v] of incoming.entries()) {
    if (!STRIP_REQ.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function buildResHeaders(incoming) {
  const out = new Headers(CORS);
  for (const [k, v] of incoming.entries()) {
    const lk = k.toLowerCase();
    if (STRIP_RES.has(lk) || STRIP_FRAME.has(lk)) continue;
    out.set(k, v);
  }
  return out;
}

async function handleProxy(request) {
  const { searchParams } = new URL(request.url);
  const v = validateUrl(searchParams.get("url"));
  if (!v.ok) return jsonError(v.error);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(v.url.toString(), {
      method:   "GET",
      headers:  buildReqHeaders(request.headers),
      redirect: "follow",
      signal:   controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return jsonError("Request timed out", 504);
    return jsonError(`Fetch failed: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  return new Response(upstream.body, {
    status:  upstream.status,
    headers: buildResHeaders(upstream.headers),
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method !== "GET") return jsonError("Method not allowed", 405);

    if (pathname === "/proxy") return handleProxy(request);

    if (pathname === "/ping") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    return jsonError("Not found", 404);
  },
};
