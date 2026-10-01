#!/usr/bin/env bash
# Ask a model real Canvas questions using only this MCP, then show which tools it called
# and what it answered.
#   scripts/eval.sh [model]                     (default: haiku)
#   TOOL_SEARCH=off scripts/eval.sh haiku       load MCP tools up front instead of deferring them
set -euo pipefail

MODEL="${1:-haiku}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/eval-runs/$(date +%Y%m%d-%H%M%S)-$MODEL${TOOL_SEARCH:+-toolsearch-$TOOL_SEARCH}"
mkdir -p "$OUT"
# Run the model from an empty folder: inside this repo it starts reading the MCP's source
# instead of calling its tools, which a real user's session wouldn't invite.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ "${TOOL_SEARCH:-}" = "off" ] && export ENABLE_TOOL_SEARCH=false

cat > "$OUT/mcp.json" <<EOF
{"mcpServers":{"canvas":{"command":"node","args":["$ROOT/src/mcp.ts"]}}}
EOF

# Read-only tools only; canvas_download_file is left out so evals never write files.
TOOLS=(whoami courses todo assignments assignment grade_breakdown announcements modules files search syllabus read_file get)
ALLOWED=()
for t in "${TOOLS[@]}"; do ALLOWED+=("mcp__canvas__canvas_$t"); done

QUESTIONS=(
  "What do I have due on Canvas in the next 3 days? For each, give the course, the weekday, and the local time it's due."
  "How is my Research Methods in Finance grade calculated on Canvas? What's my current score, and roughly how much of my final grade is one attendance quiz worth?"
  "Find the syllabus for Research Methods in Finance and tell me the office hours and how the exams work."
  "Is there a practice midterm for Research Methods in Finance on Canvas? Where is it?"
  "Why doesn't Venture Capital Methods show a score on Canvas yet? Does Canvas weight its assignment groups?"
)

for i in "${!QUESTIONS[@]}"; do
  # Background subagents outlive a one-shot -p run, so the answer would be lost; deny them.
  # Other built-in tools stay visible (but unapproved) to mirror a normal session.
  (cd "$WORK" && claude -p "${QUESTIONS[$i]}" --model "$MODEL" --mcp-config "$OUT/mcp.json" --strict-mcp-config \
    --allowedTools "${ALLOWED[@]}" --disallowedTools Agent Task \
    --output-format stream-json --verbose < /dev/null > "$OUT/q$i.jsonl" 2> "$OUT/q$i.err") &
done
wait

node - "$OUT" "${QUESTIONS[@]}" <<'EOF'
const fs = require("fs");
const [dir, ...questions] = process.argv.slice(2);
questions.forEach((q, i) => {
  const lines = fs.readFileSync(`${dir}/q${i}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const calls = [];
  const errors = new Set();
  for (const m of lines) {
    for (const c of m.message?.content ?? []) {
      if (c.type === "tool_use") calls.push(`${c.name.replace("mcp__canvas__", "")}(${JSON.stringify(c.input)})`);
      if (c.type === "tool_result" && c.is_error) errors.add(c.tool_use_id);
    }
  }
  const result = lines.find((m) => m.type === "result") ?? {};
  console.log(`\n${"=".repeat(80)}\nQ${i + 1}: ${q}`);
  console.log(`turns=${result.num_turns} tool_calls=${calls.length} tool_errors=${errors.size} cost=$${(result.total_cost_usd ?? 0).toFixed(4)}`);
  calls.forEach((c) => console.log(`  → ${c.slice(0, 160)}`));
  console.log(`\n${result.result ?? "(no result)"}`);
});
EOF
echo -e "\nRaw transcripts: $OUT"
