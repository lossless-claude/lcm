---
"@lossless-claude/lcm": patch
---

Oh My Pi capture and `lcm import --omp` follow the session's live path. An OMP session file is an append-only tree; lcm now keeps only the entries on the `parentId` chain from the file's last entry, as OMP does when it resumes a session, so a turn abandoned by a rewind or branch switch before it was captured is no longer stored. A turn already captured before the rewind stays in memory. A recovery scan of an OMP transcript accepts stored history that holds the file's messages in order without being a prefix of them, instead of refusing a session that was rewound.
