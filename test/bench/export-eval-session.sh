#!/usr/bin/env bash
# Export one conversation from a per-project lcm database as a bench corpus file.
#
#   test/bench/export-eval-session.sh <db.sqlite> <conversation_id> <out-dir/label.json>
#
# The database is opened read-only through the immutable URI, which is the only
# form that opens these WAL databases without a lock.
set -euo pipefail

db="$1"; cid="$2"; out="$3"
if ! [[ "$cid" =~ ^[0-9]+$ ]]; then
  echo "conversation_id must be a plain integer, got: $cid" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
sqlite3 -json "file:${db}?immutable=1" \
  "select seq, role, content, token_count as tokenCount, created_at as createdAt
   from messages where conversation_id = ${cid} order by seq" > "$out"
# sqlite3 -json prints nothing (not []) for zero rows; leaving the empty file
# behind would break loadCorpusDir later with an opaque JSON parse error.
if ! [[ -s "$out" ]]; then
  echo "no messages for conversation_id $cid" >&2
  rm -f "$out"
  exit 1
fi
echo "$out: $(python3 -c "import json,sys;m=json.load(open(sys.argv[1]));print(len(m),'messages',sum(x['tokenCount'] or 0 for x in m),'tokens')" "$out")"
