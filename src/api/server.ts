/**
 * Yogi Signal API — Express server exposing keeper intelligence.
 *
 * Runs alongside the keeper in the same process.
 * Shares state via src/api/state.ts.
 *
 * Endpoints:
 *   GET /v1/regime       — Current regime (deployment_pct, leverage, mode)
 *   GET /v1/signals      — 4D anomaly detection state
 *   GET /v1/funding      — Funding rate rankings
 *   GET /v1/cross-venue  — Drift vs Binance/Bybit funding comparison
 *   GET /v1/imbalances   — Market imbalance scores
 *   GET /v1/health       — API health check (no auth)
 */

import http from "http";
import { createHash } from "crypto";
import { sharedState, getMeta, isStale } from "./state";

const FLOW_AUTH_URL = process.env.FLOW_AUTH_URL || "https://flow.fabrknt.com/api/auth/validate";

// Auth cache: keyHash -> { expiresAt, result }
const authCache = new Map<string, { expiresAt: number; result: { valid: boolean; tier: string } }>();
const AUTH_CACHE_TTL = 300_000; // 5 minutes

async function validateKey(keyHash: string): Promise<{ valid: boolean; tier: string }> {
  const cached = authCache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const url = `${FLOW_AUTH_URL}?key_hash=${keyHash}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const result = await res.json() as { valid: boolean; tier: string };
    authCache.set(keyHash, { expiresAt: Date.now() + AUTH_CACHE_TTL, result });
    return result;
  } catch {
    if (cached) return cached.result;
    return { valid: false, tier: "none" };
  }
}

function apiResponse(component: string): string {
  const data = (sharedState as any)[component] ?? null;
  const meta = getMeta(component);
  if (data === null) {
    return JSON.stringify({ data: null, meta: { ...meta, error: "No data yet" } });
  }
  return JSON.stringify({ data, meta });
}

function cors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function json(res: http.ServerResponse, body: string, status = 200): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export function startApiServer(port: number = 8082): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Health — no auth
    if (path === "/v1/health") {
      const components = ["regime", "signals", "fundingRankings", "crossVenue"];
      const status: Record<string, unknown> = {};
      for (const c of components) {
        status[c] = {
          available: (sharedState as any)[c] !== null,
          stale: isStale(c),
          updated_at: sharedState.updatedAt[c] ?? null,
        };
      }
      json(res, JSON.stringify({
        status: Object.values(status).some((s: any) => !s.stale) ? "healthy" : "degraded",
        components: status,
        timestamp: Date.now(),
      }));
      return;
    }

    // Auth check for all other endpoints
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      json(res, JSON.stringify({
        error: "API key required. Get one at https://flow.fabrknt.com/dashboard",
      }), 401);
      return;
    }

    const apiKey = auth.slice(7);
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const authResult = await validateKey(keyHash);

    if (!authResult.valid) {
      json(res, JSON.stringify({ error: "Invalid or expired API key" }), 401);
      return;
    }

    if (authResult.tier !== "pro") {
      json(res, JSON.stringify({
        error: `Signal API requires Pro tier (current: ${authResult.tier}). Upgrade at https://flow.fabrknt.com/dashboard`,
      }), 403);
      return;
    }

    // Route handlers
    switch (path) {
      case "/v1/regime":
        json(res, apiResponse("regime"));
        break;
      case "/v1/signals":
        json(res, apiResponse("signals"));
        break;
      case "/v1/funding":
        json(res, apiResponse("fundingRankings"));
        break;
      case "/v1/cross-venue":
        json(res, apiResponse("crossVenue"));
        break;
      case "/v1/imbalances":
        json(res, apiResponse("imbalances"));
        break;
      default:
        json(res, JSON.stringify({ error: "Not found" }), 404);
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Yogi Signal API started on port ${port}`);
  });

  // Don't let the API server keep the process alive if keeper exits
  server.unref();
}
