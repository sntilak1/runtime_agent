import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";

export type ProbeWebexResult = BaseProbeResult<string> & {
  botId?: string;
  botEmail?: string;
  displayName?: string;
  elapsedMs?: number;
};

export async function probeWebex(token: string, timeoutMs = 8000): Promise<ProbeWebexResult> {
  if (!token) {
    return { ok: false, error: "No bot token configured." };
  }
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://webexapis.com/v1/people/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, elapsedMs };
    }
    const data = (await res.json()) as {
      id?: string;
      emails?: string[];
      displayName?: string;
      type?: string;
    };
    if (data.type !== "bot") {
      return {
        ok: false,
        error: `Token belongs to a non-bot account (type=${data.type ?? "unknown"}). Use a bot token.`,
        elapsedMs,
      };
    }
    return {
      ok: true,
      elapsedMs,
      botId: data.id,
      botEmail: data.emails?.[0],
      displayName: data.displayName,
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, elapsedMs };
  }
}
