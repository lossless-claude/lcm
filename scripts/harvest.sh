#!/bin/bash
# harvest.sh — Signal harvester for autoimprove optimization loop.
#
# Reads signals from JSONL files, aggregates per-source stats,
# detects anomalies against baseline, outputs ranked theme queue.
#
# Usage:
#   harvest.sh --signal-dir DIR --baseline FILE [--output FILE] [--window-days N]
#   harvest.sh --signal-dir DIR --baseline FILE --init
#
# Modes:
#   Normal: read signals, compare to baseline, detect anomalies, write output
#   Init:   read signals, create baseline from current data (no anomaly detection)

set -uo pipefail

# Defaults
SIGNAL_DIR="$HOME/.claude/signals"
BASELINE_FILE=""
OUTPUT_FILE="/dev/stdout"
WINDOW_DAYS=7
INIT_MODE=0

# Anomaly thresholds
FAILURE_RATE_MULT=2.0
DURATION_MULT=2.0
SEVERITY_CRITICAL=5.0
SEVERITY_HIGH=3.0
SEVERITY_MEDIUM=2.0

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --signal-dir)   SIGNAL_DIR="$2"; shift 2 ;;
    --baseline)     BASELINE_FILE="$2"; shift 2 ;;
    --output)       OUTPUT_FILE="$2"; shift 2 ;;
    --window-days)  WINDOW_DAYS="$2"; shift 2 ;;
    --init)         INIT_MODE=1; shift ;;
    *)              shift ;;
  esac
done

if [[ -z "$BASELINE_FILE" ]]; then
  echo "Usage: harvest.sh --signal-dir DIR --baseline FILE [--output FILE] [--init]" >&2
  exit 1
fi

# Calculate cutoff date
if command -v gdate >/dev/null 2>&1; then
  # [F7 FIX] Add 2>/dev/null to fallback branch to suppress error on wrong OS
  CUTOFF=$(gdate -u -d "$WINDOW_DAYS days ago" +%Y-%m-%d 2>/dev/null || date -u -v-${WINDOW_DAYS}d +%Y-%m-%d 2>/dev/null)
else
  CUTOFF=$(date -u -v-${WINDOW_DAYS}d +%Y-%m-%d 2>/dev/null || date -u -d "$WINDOW_DAYS days ago" +%Y-%m-%d 2>/dev/null)
fi

# Collect all JSONL files within window
COMBINED=$(mktemp)

if [[ -d "$SIGNAL_DIR" ]]; then
  for f in "$SIGNAL_DIR"/*.jsonl; do
    [[ -f "$f" ]] || continue
    # Extract date from filename (YYYY-MM-DD.jsonl)
    fname=$(basename "$f" .jsonl)
    if [[ "$fname" > "$CUTOFF" ]] || [[ "$fname" == "$CUTOFF" ]]; then
      cat "$f" >> "$COMBINED"
    fi
  done
fi

# Normalize v1 signals to v2 format inline
NORMALIZED=$(mktemp)
trap 'rm -f "$COMBINED" "$NORMALIZED"' EXIT  # [F17 FIX] include NORMALIZED in trap
jq -c '
  if .signal_version then
    # v1 → v2 mapping
    {
      v: 1,
      ts: .timestamp,
      source: ("agent:" + (.agent // "unknown")),
      kind: "skill_exec",
      duration_ms: null,
      outcome: (if .outcome == "completed" then "success"
                elif .outcome == "blocked" then "partial"
                elif .outcome == "failed" then "failure"
                elif .outcome == "escalated" then "partial"
                else .outcome end),
      model: (.model_used // null | split("-") | if length > 2 then .[2] else .[0] end),
      tokens: (.tokens_consumed // null),
      metrics: (if .lcm_entries_written then {lcm_entries: .lcm_entries_written} else {} end),
      tags: ([("task_type:" + (.task_type // "other")), ("effort:" + (.effort_level // "normal"))] +
             (if .sprint_id then ["sprint:" + .sprint_id] else [] end)),
      session_id: (.session_id // null)
    }
  else
    .
  end
' "$COMBINED" > "$NORMALIZED" 2>/dev/null || cp "$COMBINED" "$NORMALIZED"

# [F3 FIX] Count signals AFTER normalization (not before) — v1 signals that fail
# normalization would be counted but absent from aggregation otherwise
TOTAL_SIGNALS=$(wc -l < "$NORMALIZED" | tr -d ' ')

# Aggregate per-source stats
STATS=$(jq -s '
  group_by(.source) | map({
    source: .[0].source,
    count: length,
    success_count: [.[] | select(.outcome == "success")] | length,
    success_rate: (([.[] | select(.outcome == "success")] | length) / (length | if . == 0 then 1 else . end)),
    durations: [.[] | .duration_ms // empty] | sort,
    p50_duration_ms: ([.[] | .duration_ms // empty] | sort | if length > 0 then .[length/2 | floor] else null end),
    p95_duration_ms: ([.[] | .duration_ms // empty] | sort | if length > 0 then .[(length * 0.95) | floor] else null end)
  }) | INDEX(.source)
' "$NORMALIZED")

# Health summary
# [F6 FIX] Compute kind distribution from NORMALIZED signals (not group_by(null))
SOURCES_BY_KIND=$(jq -s 'group_by(.kind) | map({key: .[0].kind, value: length}) | from_entries' "$NORMALIZED")
HEALTH=$(echo "$STATS" | jq --argjson total "$TOTAL_SIGNALS" --argjson by_kind "$SOURCES_BY_KIND" '{
  total_signals: $total,
  overall_success_rate: ([to_entries[].value.success_rate] | if length > 0 then add / length else 0 end),
  sources_by_kind: $by_kind
}')

if [[ "$INIT_MODE" -eq 1 ]]; then
  # Init mode: write baseline from current stats
  echo "$STATS" | jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
    created_at: $ts,
    sources: (to_entries | map({key: .key, value: {
      count: .value.count,
      success_rate: .value.success_rate,
      p50_duration_ms: .value.p50_duration_ms,
      p95_duration_ms: .value.p95_duration_ms
    }}) | from_entries)
  }' > "$BASELINE_FILE"
  exit 0
fi

# Normal mode: detect anomalies against baseline
ANOMALIES="[]"
if [[ -f "$BASELINE_FILE" ]]; then
  ANOMALIES=$(jq -n \
    --argjson stats "$STATS" \
    --slurpfile baseline "$BASELINE_FILE" \
    --argjson fr_mult "$FAILURE_RATE_MULT" \
    --argjson dur_mult "$DURATION_MULT" \
    --argjson sev_crit "$SEVERITY_CRITICAL" \
    --argjson sev_high "$SEVERITY_HIGH" \
    --argjson sev_med "$SEVERITY_MEDIUM" '
    [
      $stats | to_entries[] |
      .key as $src | .value as $cur |
      $baseline[0].sources[$src] as $base |
      if $base then
        # Check failure rate spike
        # [F5 FIX] Require minimum 5% absolute failure rate to avoid noise from 100% baselines
        # [F13 FIX] Require minimum 5 samples for statistical relevance
        (if $cur.count >= 5 and $cur.success_rate < 1 and (1 - $cur.success_rate) > 0.05 and $base.success_rate > 0 then
          ((1 - $cur.success_rate) / (1 - $base.success_rate | if . < 0.01 then 0.01 else . end)) as $ratio |
          if $ratio >= $fr_mult then
            {
              source: $src,
              type: "failure_rate_spike",
              baseline: $base.success_rate,
              current: $cur.success_rate,
              ratio: $ratio,
              severity: (if $ratio >= $sev_crit then "critical"
                        elif $ratio >= $sev_high then "high"
                        elif $ratio >= $sev_med then "medium"
                        else null end)
            }
          else empty end
        else empty end),
        # Check duration regression
        # [F13 FIX] Require minimum 5 samples for p95 reliability
        (if $cur.count >= 5 and $cur.p95_duration_ms and $base.p95_duration_ms and $base.p95_duration_ms > 0 then
          ($cur.p95_duration_ms / $base.p95_duration_ms) as $ratio |
          if $ratio >= $dur_mult then
            {
              source: $src,
              type: "duration_regression",
              baseline: $base.p95_duration_ms,
              current: $cur.p95_duration_ms,
              ratio: $ratio,
              severity: (if $ratio >= $sev_crit then "critical"
                        elif $ratio >= $sev_high then "high"
                        elif $ratio >= $sev_med then "medium"
                        else null end)
            }
          else empty end
        else empty end)
      else
        # New source — no baseline
        {source: $src, type: "new_source", severity: "info"}
      end
    ] | [.[] | select(.severity != null)]
  ')
fi

# [F14 FIX] Separate new_source entries from real anomalies
NEW_SOURCES=$(echo "$ANOMALIES" | jq '[.[] | select(.type == "new_source")]')
ANOMALIES=$(echo "$ANOMALIES" | jq '[.[] | select(.type != "new_source")] | sort_by(
  if .severity == "critical" then 0
  elif .severity == "high" then 1
  elif .severity == "medium" then 2
  else 3 end
)')

# [F19 FIX] Stage 4 — Map anomalies to autoimprove themes via source→theme mapping
# Reads source_theme_map from autoimprove.yaml if yq is available; else uses prefix defaults
AUTOIMPROVE_YAML="${AUTOIMPROVE_YAML:-$HOME/Developer/autoimprove/autoimprove.yaml}"
if [ -f "$AUTOIMPROVE_YAML" ] && command -v yq >/dev/null 2>&1; then
  THEME_MAP=$(yq -o=json '.harvester.source_theme_map // []' "$AUTOIMPROVE_YAML" 2>/dev/null || echo '[]')
else
  THEME_MAP='[
    {"pattern":"xgh:","theme":"retrieval-reliability"},
    {"pattern":"lcm:","theme":"memory-reliability"},
    {"pattern":"org:skill-","theme":"skill-quality"},
    {"pattern":"hook:","theme":"hook-performance"},
    {"pattern":"agent:","theme":"agent-efficiency"}
  ]'
fi
ANOMALIES=$(echo "$ANOMALIES" | jq --argjson map "$THEME_MAP" '
  [.[] | . as $a |
    ($map | [.[] | . as $entry | select($a.source | startswith($entry.pattern))] | first // null) as $match |
    if $match then . + {suggested_theme: $match.theme} else . end
  ]
')

# Write output
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson window "$WINDOW_DAYS" \
  --argjson sources_tracked "$(echo "$STATS" | jq 'length')" \
  --argjson anomalies "$ANOMALIES" \
  --argjson new_sources "$NEW_SOURCES" \
  --argjson health "$HEALTH" '{
  harvest_ts: $ts,
  window_days: $window,
  sources_tracked: $sources_tracked,
  anomalies: $anomalies,
  new_sources: $new_sources,
  health_summary: $health
}' > "$OUTPUT_FILE"
exit 0
