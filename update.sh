#!/usr/bin/env bash
#
# 월 1회 정기 갱신 — 이것 하나만 실행하면 된다.
#
#   bash update.sh          받아오고 · 커밋하고 · 올린다
#   bash update.sh --check  달라진 것만 보여주고 아무것도 안 바꾼다
#
# 하는 일:
#   ① Supabase에서 최신 SEP 데이터를 받아 data/ 를 갱신
#   ② 바뀐 게 있으면 커밋하고 GitHub에 올림 (없으면 건너뜀)
#   ③ 설치된 플러그인 사본을 최신으로 맞춤
#
# 접속 정보는 ~/.claude/philosophy-oracle/supabase.json 에서 읽는다(저장소에 없다).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

line() { printf '\n%s\n' "────────────────────────────────────────────"; }

# ── ① 데이터 받아오기 ─────────────────────────────────
line
echo "① SEP 데이터를 받아옵니다"
line

if [ "$CHECK" = "1" ]; then
  node mcp/sep/refresh.mjs --check
  echo ""
  echo "확인만 했습니다. 아무것도 바꾸지 않았습니다."
  exit 0
fi

OUT="$(node mcp/sep/refresh.mjs 2>&1)"
RC=$?
echo "$OUT"

if [ $RC -ne 0 ]; then
  line
  echo "✗ 데이터를 받아오지 못했습니다. 기존 데이터는 그대로 있습니다."
  echo "  위 메시지를 확인해 주세요. (인터넷 연결이나 접속 정보 문제일 수 있습니다)"
  exit 1
fi

# refresh.mjs가 알려준 변경 요약을 커밋 메시지에 쓴다
SUMMARY="$(echo "$OUT" | sed -n '/── 무엇이 달라졌나 ──/,/^  관계/p' | sed '1d')"

# ── ② 바뀐 게 있으면 올리기 ───────────────────────────
line
echo "② 저장소에 반영합니다"
line

if [ -z "$(git status --porcelain)" ]; then
  echo "달라진 내용이 없습니다. 올릴 것도 없습니다."
else
  git add -A
  git -c user.name="narim99" commit -q -F - <<EOF
SEP 데이터 정기 갱신 ($(date '+%Y-%m-%d'))

$SUMMARY

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
  echo "커밋했습니다: $(git log --oneline -1)"

  if git push -q origin main 2>/dev/null; then
    echo "GitHub에 올렸습니다."
  else
    line
    echo "⚠ GitHub에 올리지 못했습니다. 데이터와 커밋은 정상입니다."
    echo "  인터넷이 되면 이것만 다시 실행하세요:  git -C \"$HERE\" push origin main"
  fi
fi

# ── ③ 설치본 맞추기 ───────────────────────────────────
line
echo "③ 설치된 플러그인을 최신으로 맞춥니다"
line

if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace update sep-local >/dev/null 2>&1
  claude plugin update sep@sep-local 2>&1 | tail -1
else
  echo "claude 명령을 찾지 못했습니다 — 건너뜁니다."
fi

line
echo "끝났습니다."
echo ""
echo "⚠ Claude Code를 재시작해야 새 데이터가 반영됩니다."
line
