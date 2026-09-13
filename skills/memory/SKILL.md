---
name: memory
description: Run one lcm CLI command and show its output verbatim. Usage: /memory <command> [options]
disable-model-invocation: true
allowed-tools: Bash(lcm *) Bash(node *bundle/lcm.js*)
---

# memory

The CLI documents itself: `lcm help <command>` is the reference for every command and
option. Resolve the binary once: `lcm` when it is on PATH, otherwise
`node "${CLAUDE_PLUGIN_ROOT}/bundle/lcm.js"` (marketplace install).

1. Without arguments, or when `$0` is not a command: run `lcm help`, show it verbatim, stop.
2. Run `lcm help $0`. Done when you can say in one line what `lcm $ARGUMENTS` will do.
3. Run `lcm $ARGUMENTS`. Show stdout and stderr verbatim, with the exit code when it is not
   zero. Done when the unedited output is in front of the user.
4. On a non-zero exit, name the option or precondition that failed, using what `lcm help $0`
   said (a daemon that is down starts with `lcm daemon start --detach`). Ask before running a
   different command.
