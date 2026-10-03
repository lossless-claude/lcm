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
sqlite3 "file:${db}?immutable=1" \
  "select json_group_array(json_object(
     'seq', m.seq, 'role', m.role, 'content', m.content,
     'tokenCount', m.token_count, 'createdAt', m.created_at,
     'toolCalls', json((select json_group_array(json_object(
       'callId', t.call_id, 'name', t.name, 'input', t.input,
       'outcome', t.outcome, 'blockReason', t.block_reason,
       'truncated', json(case when t.truncated <> 0 then 'true' else 'false' end)
     )) from (select * from transcript_tool_calls where message_id = m.message_id order by rowid) t))
   )) from (select * from messages where conversation_id = ${cid} order by seq) m
   having count(*) > 0" > "$out"
# The query prints nothing (not []) for zero rows; leaving the empty file
# behind would break loadCorpusDir later with an opaque JSON parse error.
if ! [[ -s "$out" ]]; then
  echo "no messages for conversation_id $cid" >&2
  rm -f "$out"
  exit 1
fi
echo "$out: $(python3 -c "import json,sys;m=json.load(open(sys.argv[1]));print(len(m),'messages',sum(x['tokenCount'] or 0 for x in m),'tokens')" "$out")"
