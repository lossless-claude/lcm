#!/usr/bin/env bash
# Export one conversation from a per-project lcm database as a bench corpus file.
#
#   test/bench/export-eval-session.sh <db.sqlite> <conversation_id> <out-dir/label.json>
#
# The database is opened read-only through the immutable URI, which is the only
# form that opens these WAL databases without a lock.
set -euo pipefail

db="$1"; cid="$2"; out="$3"
mkdir -p "$(dirname "$out")"
sqlite3 -json "file:${db}?immutable=1" \
  "select seq, role, content, token_count as tokenCount, created_at as createdAt
   from messages where conversation_id = ${cid} order by seq" > "$out"
echo "$out: $(python3 -c "import json;m=json.load(open('$out'));print(len(m),'messages',sum(x['tokenCount'] for x in m),'tokens')")"
