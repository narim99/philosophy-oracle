#!/usr/bin/env bash
# SEP MCP 런처
#
# SEP 데이터는 data/ 에 동봉돼 있어 외부 DB도 API 키도 필요 없다.
# 어휘검색·발췌·관계·모듈뷰는 의존성 0으로 동작하므로, 아래 설치가 실패해도 서버는 뜬다.
# 의미검색(sep_semantic)에 필요한 @xenova/transformers만 최초 1회 설치한다.
#
# 설치 위치를 플러그인 캐시가 아니라 홈 아래 고정 경로로 두는 이유:
#   플러그인은 버전마다 새 폴더로 복사되므로, 캐시에 설치하면 버전을 올릴 때마다
#   수백 MB(onnxruntime + 모델)를 다시 받게 된다. 고정 경로에 두고 심볼릭 링크만 건다.
#
# stdout은 MCP 프로토콜 전용이다 — 설치 로그가 섞이면 핸드셰이크가 깨지므로 전부 stderr로 보낸다.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS="${HOME}/.claude/philosophy-oracle/mcp-sep"

if [ ! -d "${DEPS}/node_modules/@xenova/transformers" ]; then
  echo "[sep-mcp] 의미검색 의존성 최초 설치 (${DEPS}) — 수 분 걸릴 수 있다…" >&2
  mkdir -p "${DEPS}"
  cp "${HERE}/package.json" "${DEPS}/package.json" 2>/dev/null || true
  ( cd "${DEPS}" && npm install --no-audit --no-fund --loglevel=error ) >&2 \
    || echo "[sep-mcp] 설치 실패 — 어휘검색은 정상 동작하고 sep_semantic만 비활성이다." >&2
fi

# ESM은 NODE_PATH를 무시하므로, 서버 옆에 node_modules 심볼릭 링크를 걸어 bare import가 풀리게 한다.
if [ ! -e "${HERE}/node_modules" ] && [ -d "${DEPS}/node_modules" ]; then
  ln -s "${DEPS}/node_modules" "${HERE}/node_modules" 2>/dev/null || true
fi

exec node "${HERE}/server.mjs"
