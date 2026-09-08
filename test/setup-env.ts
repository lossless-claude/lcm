// Runs before every test file. The tests exercise the command hooks directly, and those
// hooks go silent when the function-hooks module owns capture (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
// A developer's own Claude Code session sets that variable, and vitest inherits it, so the
// suite must not see it.
delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
