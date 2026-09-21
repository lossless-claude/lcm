/**
 * The client identity of a session: which harness owns it.
 *
 * Deliberately separate from the summarizer providers (src/llm/types.ts,
 * DaemonConfig["llm"]["provider"]): a provider is which CLI or API summarizes,
 * a session client is whose hooks fire and whose transcript is read. Copilot
 * is a summarizer provider but not a session client — it has no hooks and no
 * transcript of its own.
 */
export type SessionClient = "claude" | "codex";
