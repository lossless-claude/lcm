#!/usr/bin/env bash
# evaluate.sh — Gate runner for autoimprove
# Usage: evaluate.sh <config.json> <baseline.json>
# Outputs a JSON verdict to stdout. Exit code is always 0 (verdict is in JSON).
# Requires: bash 4+, jq, python3 (for ms timing on macOS)

set -uo pipefail

CONFIG="${1:-}"
BASELINE="${2:-/dev/null}"

if [ -z "$CONFIG" ]; then
  echo '{"verdict":"error","reason":"usage: evaluate.sh <config.json> [baseline.json]"}' >&2
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  echo "{\"verdict\":\"error\",\"reason\":\"config not found: $CONFIG\"}" >&2
  exit 1
fi

# Determine mode: init if baseline is /dev/null or missing
INIT_MODE=false
if [ "$BASELINE" = "/dev/null" ] || [ ! -f "$BASELINE" ]; then
  INIT_MODE=true
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

now_ms() {
  local t
  t=$(date +%s%3N 2>/dev/null)
  # macOS date returns e.g. "17744763243N" — fall back to python3 if not pure digits
  if [[ "$t" =~ ^[0-9]+$ ]]; then
    echo "$t"
  else
    python3 -c 'import time; print(int(time.time()*1000))'
  fi
}

# ── Gate runner ───────────────────────────────────────────────────────────────
# Returns: sets GATE_RESULTS (JSON array) and GATE_PASSED (bool)

run_gates() {
  local gate_count
  gate_count=$(jq '.gates | length' "$CONFIG")

  GATE_RESULTS='[]'
  GATE_PASSED=true

  for (( i=0; i<gate_count; i++ )); do
    local name cmd
    name=$(jq -r ".gates[$i].name" "$CONFIG")
    cmd=$(jq -r ".gates[$i].command" "$CONFIG")

    local start_ms end_ms duration_ms exit_code
    start_ms=$(now_ms)

    set +e
    eval "$cmd" >/dev/null 2>&1
    exit_code=$?
    set -e

    end_ms=$(now_ms)
    duration_ms=$(( end_ms - start_ms ))

    local passed
    if [ "$exit_code" -eq 0 ]; then
      passed=true
    else
      passed=false
    fi

    local gate_json
    gate_json=$(jq -n \
      --arg name "$name" \
      --argjson passed "$passed" \
      --argjson exit_code "$exit_code" \
      --argjson duration_ms "$duration_ms" \
      '{name: $name, passed: $passed, exit_code: $exit_code, duration_ms: $duration_ms}')

    GATE_RESULTS=$(echo "$GATE_RESULTS" | jq ". + [$gate_json]")

    if [ "$passed" = "false" ]; then
      GATE_PASSED=false
      # Fast-fail: stop after first failure
      return
    fi
  done
}

# ── Metric extractor ──────────────────────────────────────────────────────────
# Usage: extract_metric <pattern> <output>
# Returns the extracted value to stdout, or empty string on failure.

extract_metric() {
  local pattern="$1"
  local output="$2"

  if [[ "$pattern" == json:* ]]; then
    local jq_path="${pattern#json:}"
    echo "$output" | jq -r "$jq_path" 2>/dev/null
  else
    # Treat pattern as a shell command; pipe output through it
    echo "$output" | eval "$pattern" 2>/dev/null
  fi
}

# ── Benchmark runner ───────────────────────────────────────────────────────────
# Returns: sets BENCH_METRICS (JSON object of name→value)

run_benchmarks() {
  local bench_count
  bench_count=$(jq '.benchmarks | length' "$CONFIG")

  BENCH_METRICS='{}'

  for (( i=0; i<bench_count; i++ )); do
    local bench_name bench_cmd
    bench_name=$(jq -r ".benchmarks[$i].name" "$CONFIG")
    bench_cmd=$(jq -r ".benchmarks[$i].command" "$CONFIG")

    local bench_output
    set +e
    bench_output=$(eval "$bench_cmd" 2>/dev/null)
    set -e

    local metric_count
    metric_count=$(jq ".benchmarks[$i].metrics | length" "$CONFIG")

    for (( j=0; j<metric_count; j++ )); do
      local metric_name extract_pattern
      metric_name=$(jq -r ".benchmarks[$i].metrics[$j].name" "$CONFIG")
      extract_pattern=$(jq -r ".benchmarks[$i].metrics[$j].extract" "$CONFIG")

      local raw_value
      raw_value=$(extract_metric "$extract_pattern" "$bench_output")

      if [ -n "$raw_value" ] && [ "$raw_value" != "null" ]; then
        # Store as number if it looks numeric, else as string
        if [[ "$raw_value" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
          BENCH_METRICS=$(echo "$BENCH_METRICS" | jq --arg k "$metric_name" --argjson v "$raw_value" '. + {($k): $v}')
        else
          BENCH_METRICS=$(echo "$BENCH_METRICS" | jq --arg k "$metric_name" --arg v "$raw_value" '. + {($k): $v}')
        fi
      fi
    done
  done
}

# ── Scoring ───────────────────────────────────────────────────────────────
# Returns: sets SCORE_VERDICT, SCORE_REASON, SCORE_METRICS_JSON,
#          SCORE_IMPROVED (JSON array), SCORE_REGRESSED (JSON array),
#          SCORE_VERDICT_LOGIC

score_results() {
  local bench_count
  bench_count=$(jq '.benchmarks | length' "$CONFIG")

  SCORE_METRICS_JSON='{}'
  SCORE_IMPROVED='[]'
  SCORE_REGRESSED='[]'

  for (( i=0; i<bench_count; i++ )); do
    local metric_count
    metric_count=$(jq ".benchmarks[$i].metrics | length" "$CONFIG")

    for (( j=0; j<metric_count; j++ )); do
      local metric_name direction tolerance significance
      metric_name=$(jq -r ".benchmarks[$i].metrics[$j].name" "$CONFIG")
      direction=$(jq -r ".benchmarks[$i].metrics[$j].direction // \"higher_is_better\"" "$CONFIG")
      tolerance=$(jq -r ".benchmarks[$i].metrics[$j].tolerance // .regression_tolerance" "$CONFIG")
      significance=$(jq -r ".benchmarks[$i].metrics[$j].significance // .significance_threshold" "$CONFIG")

      # Get baseline value
      local baseline_val
      baseline_val=$(jq -r ".metrics[\"$metric_name\"] // empty" "$BASELINE")

      # Get candidate value from BENCH_METRICS
      local candidate_val
      candidate_val=$(echo "$BENCH_METRICS" | jq -r ".[\"$metric_name\"] // empty")

      # Skip if either value is missing
      if [ -z "$baseline_val" ] || [ -z "$candidate_val" ]; then
        continue
      fi

      # Calculate delta_pct with bc -l
      # Handle zero baseline
      local delta_pct
      if [ "$baseline_val" = "0" ]; then
        if [ "$candidate_val" = "0" ]; then
          delta_pct="0"
        else
          delta_pct="1"
        fi
      else
        delta_pct=$(echo "scale=10; ($candidate_val - $baseline_val) / $baseline_val" | bc -l)
      fi

      # Normalize: if lower_is_better, negate
      local normalized_delta
      if [ "$direction" = "lower_is_better" ]; then
        normalized_delta=$(echo "scale=10; -1 * $delta_pct" | bc -l)
      else
        normalized_delta="$delta_pct"
      fi

      # Check regression: normalized_delta < -tolerance
      local is_regressed is_improved
      is_regressed=$(echo "$normalized_delta < -$tolerance" | bc -l)
      is_improved=$(echo "$normalized_delta > $significance" | bc -l)

      # Build per-metric JSON (delta_pct as percentage, e.g. 5.4 for 5.4%)
      local delta_pct_display
      delta_pct_display=$(echo "scale=4; $delta_pct * 100" | bc -l)
      local metric_json
      metric_json=$(jq -n \
        --argjson baseline "$baseline_val" \
        --argjson candidate "$candidate_val" \
        --arg delta_pct "$delta_pct_display" \
        --arg direction "$direction" \
        '{baseline: $baseline, candidate: $candidate, delta_pct: ($delta_pct | tonumber), direction: $direction}')

      SCORE_METRICS_JSON=$(echo "$SCORE_METRICS_JSON" | jq --arg k "$metric_name" --argjson v "$metric_json" '. + {($k): $v}')

      if [ "$is_regressed" = "1" ]; then
        SCORE_REGRESSED=$(echo "$SCORE_REGRESSED" | jq --arg m "$metric_name" '. + [$m]')
      elif [ "$is_improved" = "1" ]; then
        SCORE_IMPROVED=$(echo "$SCORE_IMPROVED" | jq --arg m "$metric_name" '. + [$m]')
      fi
    done
  done

  # Apply set logic
  local regressed_count improved_count
  regressed_count=$(echo "$SCORE_REGRESSED" | jq 'length')
  improved_count=$(echo "$SCORE_IMPROVED" | jq 'length')

  if [ "$regressed_count" -gt 0 ]; then
    SCORE_VERDICT="regress"
    SCORE_REASON="metric(s) regressed: $(echo "$SCORE_REGRESSED" | jq -r 'join(", ")')"
    SCORE_VERDICT_LOGIC="regression_detected"
  elif [ "$improved_count" -eq 0 ]; then
    SCORE_VERDICT="neutral"
    SCORE_REASON="no metrics improved beyond significance threshold"
    SCORE_VERDICT_LOGIC="no_improvements"
  else
    SCORE_VERDICT="keep"
    SCORE_REASON="improvement in: $(echo "$SCORE_IMPROVED" | jq -r 'join(", ")')"
    SCORE_VERDICT_LOGIC="no_regressions_and_at_least_one_improvement"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

run_gates

if [ "$GATE_PASSED" = "false" ]; then
  failed_gate=$(echo "$GATE_RESULTS" | jq -r '.[-1].name')
  jq -n \
    --arg verdict "gate_fail" \
    --arg reason "gate '$failed_gate' failed" \
    --argjson gates "$GATE_RESULTS" \
    '{verdict: $verdict, reason: $reason, gates: $gates, metrics: {}, improved: [], regressed: [], verdict_logic: "gate_fast_fail"}'
  exit 0
fi

# All gates passed — run benchmarks
run_benchmarks

if [ "$INIT_MODE" = "true" ]; then
  jq -n \
    --argjson gates "$GATE_RESULTS" \
    --argjson metrics "$BENCH_METRICS" \
    '{mode: "init", gates: $gates, metrics: $metrics}'
else
  # Check if any benchmarks are configured
  benchmark_count=$(jq '.benchmarks | length' "$CONFIG")
  if [ "$benchmark_count" -eq 0 ]; then
    jq -n \
      --argjson gates "$GATE_RESULTS" \
      '{verdict: "neutral", reason: "no benchmarks configured", gates: $gates, metrics: {}, improved: [], regressed: [], verdict_logic: "no_benchmarks"}'
  else
    # Score against baseline
    score_results
    jq -n \
      --arg verdict "$SCORE_VERDICT" \
      --arg reason "$SCORE_REASON" \
      --argjson gates "$GATE_RESULTS" \
      --argjson metrics "$SCORE_METRICS_JSON" \
      --argjson improved "$SCORE_IMPROVED" \
      --argjson regressed "$SCORE_REGRESSED" \
      --arg verdict_logic "$SCORE_VERDICT_LOGIC" \
      '{verdict: $verdict, reason: $reason, gates: $gates, metrics: $metrics, improved: $improved, regressed: $regressed, verdict_logic: $verdict_logic}'
  fi
fi
