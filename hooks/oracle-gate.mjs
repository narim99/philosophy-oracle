#!/usr/bin/env node
/**
 * ⑧ 확장 경로 게이트 강제 — Stop 훅.
 *
 * 왜 이게 있나: ⑦ 답변을 내놓은 뒤 ⑧ 게이트를 띄우라는 지시를 스킬 문서에 넣고,
 * 경고를 진하게 쓰고, 실측 근거까지 붙이고, 급기야 `sep_answer`가 응답으로
 * "⑧을 지금 띄워라"를 돌려주게까지 만들었다. **그래도 네 번 연속 생략됐다.**
 * 답변을 내놓는 순간 "끝"으로 판단해 버리기 때문이다.
 *
 * 프롬프트로 안 고쳐지는 것은 하네스로 막아야 한다. 이 훅은 턴이 끝나려 할 때
 * 끼어들어, 답변 파일은 만들어졌는데 로그에 ⑧이 없으면 **종료를 막는다.**
 *
 * 오작동하지 않게 좁게 건다:
 *  - 최근에 만들어진 answer 파일이 있을 때만 본다(기본 30분)
 *  - 같은 run_id로는 **한 번만** 막는다(표시 파일을 남긴다) — 무한 루프 방지
 *  - `stop_hook_active`면 즉시 통과 — 이미 훅 때문에 재개된 턴이다
 *  - 오라클을 안 돌린 세션에는 아무 영향이 없다
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PASS = () => process.exit(0); // 아무 말 없이 통과

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  PASS();
}

let ev = {};
try {
  ev = JSON.parse(input || '{}');
} catch {
  PASS();
}

// 훅이 이미 한 번 막아서 재개된 턴이면 다시 막지 않는다.
if (ev.stop_hook_active) PASS();

const HOME = os.homedir();
const BASE = process.env.ORACLE_LOG_DIR || path.join(HOME, '.claude', 'philosophy-oracle', 'logs');
if (!fs.existsSync(BASE)) PASS();

const FRESH_MS = Number(process.env.ORACLE_GATE_WINDOW_MIN || 30) * 60 * 1000;
const now = Date.now();

// 가장 최근에 쓰인 answer 파일을 찾는다.
let latest = null;
try {
  for (const f of fs.readdirSync(BASE)) {
    const m = /^answer-(.+)\.md$/.exec(f);
    if (!m) continue;
    const st = fs.statSync(path.join(BASE, f));
    if (now - st.mtimeMs > FRESH_MS) continue;
    if (!latest || st.mtimeMs > latest.mtime) latest = { run_id: m[1], mtime: st.mtimeMs };
  }
} catch {
  PASS();
}
if (!latest) PASS();

// 같은 실행을 두 번 막지 않는다.
const mark = path.join(path.dirname(BASE), `.gate-nudged-${latest.run_id}`);
if (fs.existsSync(mark)) PASS();

// 과정 기록에 ⑧이 있으면 게이트를 이미 거친 것이다("종료" 선택도 여기 기록된다).
const log = path.join(BASE, `oracle-${latest.run_id}.md`);
let text = '';
try {
  text = fs.readFileSync(log, 'utf8');
} catch {
  // 로그 자체가 없으면 오라클 실행이 아니거나 아직 시작 전이다 — 건드리지 않는다.
  PASS();
}
if (text.includes('⑧')) PASS();

// 여기까지 왔으면 ⑦은 끝났는데 ⑧을 안 거쳤다. 막는다.
try {
  fs.writeFileSync(mark, new Date(now).toISOString());
} catch {
  /* 표시를 못 남겨도 막는 것 자체는 한다 — 다만 stop_hook_active가 재발을 걸러 준다 */
}

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `⚠ 아직 실행이 안 끝났다 (run_id: ${latest.run_id}).\n\n` +
      `⑦ 답변은 파일로 남았는데 **⑧ 확장 경로 게이트를 거치지 않았다.** ` +
      `과정 기록 \`oracle-${latest.run_id}.md\`에 ⑧ 항목이 없다.\n\n` +
      `**지금 할 일:**\n` +
      `1. 준비하지 말고 곧바로 \`AskUserQuestion\`을 불러라 — 선택지는 네 개다: ` +
      `「간극 파고들기」·「철학 내 타 분과」·「철학 외 분과」·「여기서 종료」(multiSelect).\n` +
      `2. 사용자가 고른 **그 경로의 후보만** 표로 만들어 2단을 물어라. 안 고른 경로는 만들지 마라.\n` +
      `3. 「여기서 종료」를 고르면 \`sep_log\`에 ⑧을 기록하고 **두 파일을 \`SendUserFile\`로 함께** 보내라.\n\n` +
      `멈출지 말지는 **사용자가 정한다.** 답변만 내놓고 끝내면 그 선택권을 뺏는 것이다.`,
  })
);
process.exit(0);
