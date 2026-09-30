---
"@lossless-claude/lcm": patch
---

Use a buffered Node HTTP transport for OpenAI and Anthropic summarizers so response headers and bodies can take longer than 300 seconds, bounded by the configured request deadline. Preserve Node's default HTTPS certificate trust, including private CAs supplied through NODE_EXTRA_CA_CERTS. Proxy routing is not supported by this transport.
