---
"@lossless-claude/lcm": patch
---

fix: stale daemon-activity markers no longer accumulate without bound

Every hook and CLI entry that touches the daemon writes a startup marker and
removes it when its work settles; a process that dies first (a killed hook,
a crashed CLI) left the marker behind forever, so the directory could grow to
hundreds of files. Markers now live in `tmpDir` instead of the storage root,
and a marker whose pid is no longer alive — or that has aged past one hour,
so pid reuse cannot resurrect it — is pruned whenever markers are scanned or
a new one is registered. A marker owned by a live, young process is never touched, and it is refreshed while its
work runs so a long operation cannot age out under its own owner. The directory versions
before this change wrote to is still swept, so an upgrade leaves nothing behind there.
