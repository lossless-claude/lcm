export class DaemonClient {
  constructor(private baseUrl: string) {}

  async health(): Promise<{ status: string; uptime: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok ? (await res.json() as { status: string; uptime: number }) : null;
    } catch { return null; }
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return await res.json() as T;
  }
}
