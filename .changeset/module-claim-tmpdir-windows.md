---
"@lossless-claude/lcm": patch
---

On Windows, the function-hooks module now writes its session claim and hook snapshots to the temp dir Node's `os.tmpdir()` names (`TEMP`), read from the Claude Code environment, instead of the `/tmp` a Git Bash shell reports, which landed in `C:\tmp`. The command hooks never found the claim there, so both paths captured every event: two `/ingest` per Stop and two `/prompt-search` per prompt, and the duplicate ingest made the module's own ingest queue behind it and report "daemon busy".
