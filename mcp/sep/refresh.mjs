#!/usr/bin/env node
/**
 * SEP 데이터 갱신 — Supabase의 최신 내용을 data/ 로 다시 받아온다.
 *
 *   node refresh.mjs            갱신한다
 *   node refresh.mjs --check    받아만 보고 무엇이 달라졌는지 알려준다(파일은 안 건드림)
 *
 * 접속 정보는 **저장소에 두지 않는다.** 아래 둘 중 하나로 준다:
 *   1) 환경변수 SEP_SUPABASE_URL / SEP_SUPABASE_KEY
 *   2) ~/.claude/philosophy-oracle/supabase.json  →  { "url": "...", "key": "..." }
 * 2번을 권한다 — 홈 폴더라 저장소에 딸려 올라갈 일이 아예 없고, 매번 붙여넣지 않아도 된다.
 *
 * 안전장치: 새 파일을 임시 이름으로 다 쓴 뒤 마지막에 한꺼번에 바꿔치기한다.
 * 중간에 실패해도 기존 데이터는 그대로 남는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const DIM = 384;
const CHECK_ONLY = process.argv.includes('--check');
const say = (...a) => console.log(...a);

// ── 접속 정보 ──────────────────────────────────────────
function credentials() {
  const envUrl = process.env.SEP_SUPABASE_URL, envKey = process.env.SEP_SUPABASE_KEY;
  if (envUrl && envKey) return { url: envUrl.replace(/\/$/, ''), key: envKey, from: '환경변수' };

  const f = path.join(os.homedir(), '.claude', 'philosophy-oracle', 'supabase.json');
  if (fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.url && j.key) return { url: String(j.url).replace(/\/$/, ''), key: j.key, from: f };
  }
  console.error(
    '접속 정보가 없다. 둘 중 하나로 주면 된다.\n\n' +
    `  1) 파일 (권장 — 한 번만 만들어 두면 다음부터 그냥 실행하면 된다)\n` +
    `     mkdir -p ~/.claude/philosophy-oracle\n` +
    `     echo '{"url":"https://<프로젝트>.supabase.co","key":"<키>"}' > ${f}\n\n` +
    '  2) 환경변수\n' +
    '     SEP_SUPABASE_URL=... SEP_SUPABASE_KEY=... node refresh.mjs\n');
  process.exit(1);
}

const { url: SB, key: KEY, from } = credentials();
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── 내려받기 ───────────────────────────────────────────
async function fetchAll(table, select, order) {
  const rows = [];
  const N = 1000;
  for (let offset = 0; ; offset += N) {
    const u = `${SB}/rest/v1/${table}?select=${select}&order=${order}&limit=${N}&offset=${offset}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) {
      throw new Error(
        `${table} 조회 실패 ${r.status}: ${(await r.text()).slice(0, 200)}` +
        (r.status === 401 ? '\n→ 키가 틀렸거나 만료됐다.' : '') +
        (r.status === 404 ? '\n→ 테이블 이름이나 URL을 확인하라.' : ''));
    }
    const b = await r.json();
    rows.push(...b);
    process.stdout.write(`\r  ${table}: ${rows.length}건`);
    if (b.length < N) break;
  }
  say('');
  return rows;
}

say(`접속 정보: ${from}`);
say(`대상: ${SB}\n`);

const entries = await fetchAll('sep_entries', '*', 'slug.asc');
const edges = await fetchAll('sep_edges', 'source,target,ls,lt,ms,mt,note', 'source.asc,target.asc');

if (!entries.length) throw new Error('항목이 0건이다 — 뭔가 잘못됐다. 기존 데이터를 유지한다.');

// ── 지금 데이터와 비교 ─────────────────────────────────
function currentEntries() {
  const f = path.join(DATA, 'entries.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}
const before = currentEntries();
const beforeMap = new Map(before.map((e) => [e.slug, e]));
const afterMap = new Map(entries.map((e) => [e.slug, e]));

const added = entries.filter((e) => !beforeMap.has(e.slug)).map((e) => e.slug);
const removed = before.filter((e) => !afterMap.has(e.slug)).map((e) => e.slug);
const changed = entries.filter((e) => {
  const b = beforeMap.get(e.slug);
  if (!b) return false;
  return b.title !== e.title || (b.ko_desc || '') !== (e.ko_desc || '');
}).map((e) => e.slug);

say('\n── 무엇이 달라졌나 ──');
say(`  항목  ${before.length} → ${entries.length}`);
say(`    새로 생김 ${added.length}${added.length ? ': ' + added.slice(0, 8).join(', ') + (added.length > 8 ? ` 외 ${added.length - 8}개` : '') : ''}`);
say(`    없어짐   ${removed.length}${removed.length ? ': ' + removed.slice(0, 8).join(', ') + (removed.length > 8 ? ` 외 ${removed.length - 8}개` : '') : ''}`);
say(`    내용 수정 ${changed.length}${changed.length ? ': ' + changed.slice(0, 8).join(', ') + (changed.length > 8 ? ` 외 ${changed.length - 8}개` : '') : ''}`);
say(`  관계  ${edges.length}건`);

if (CHECK_ONLY) {
  say('\n--check 모드다. 파일은 건드리지 않았다.');
  process.exit(0);
}

// ── 새 파일을 임시 이름으로 쓴다 ───────────────────────
fs.mkdirSync(DATA, { recursive: true });
const tmp = (n) => path.join(DATA, `.new-${n}`);

// 임베딩 — entries.json과 같은 순서의 float32 배열
const buf = Buffer.alloc(entries.length * DIM * 4);
let missing = 0;
entries.forEach((e, i) => {
  const v = typeof e.embedding === 'string' ? JSON.parse(e.embedding) : e.embedding;
  if (!v || v.length !== DIM) { missing++; return; } // 0으로 남는다 = 의미검색에서 안 걸림
  for (let d = 0; d < DIM; d++) buf.writeFloatLE(v[d], (i * DIM + d) * 4);
});
if (missing) say(`\n⚠ 임베딩 없는 항목 ${missing}건 — 이 항목들은 의미검색에 안 잡힌다.`);
fs.writeFileSync(tmp('embeddings.bin'), buf);

// 항목 — 임베딩과 전부-빈 컬럼은 뺀다
const cols = Object.keys(entries[0]);
const empty = cols.filter((c) => !entries.some((e) => e[c] !== null && e[c] !== undefined && e[c] !== ''));
const drop = new Set(['embedding', ...empty]);
if (empty.length) say(`  (전부 비어 있어 제외한 컬럼: ${empty.join(', ')})`);
const slim = entries.map((e) => {
  const o = {};
  for (const c of cols) if (!drop.has(c) && e[c] !== null && e[c] !== '') o[c] = e[c];
  return o;
});
fs.writeFileSync(tmp('entries.json'), JSON.stringify(slim));

// 관계 — 키 반복을 없애려고 배열로 저장한다
fs.writeFileSync(tmp('edges.json'), JSON.stringify({
  f: ['source', 'target', 'ls', 'lt', 'ms', 'mt', 'note'],
  rows: edges.map((e) => [e.source, e.target, e.ls || 0, e.lt || 0, e.ms || 0, e.mt || 0, e.note || '']),
}));

// ── 검사한 뒤 한꺼번에 바꿔치기 ────────────────────────
const size = (f) => fs.statSync(f).size;
if (size(tmp('embeddings.bin')) !== entries.length * DIM * 4) throw new Error('임베딩 크기가 안 맞는다 — 교체를 중단한다.');
JSON.parse(fs.readFileSync(tmp('entries.json'), 'utf8'));
JSON.parse(fs.readFileSync(tmp('edges.json'), 'utf8'));

for (const n of ['entries.json', 'embeddings.bin', 'edges.json']) {
  fs.renameSync(tmp(n), path.join(DATA, n));
}

say('\n── 갱신 완료 ──');
for (const n of ['entries.json', 'embeddings.bin', 'edges.json', 'atlas.json']) {
  const f = path.join(DATA, n);
  if (fs.existsSync(f)) say(`  ${n.padEnd(16)} ${(size(f) / 1048576).toFixed(2)} MB`);
}
say('\nATLAS(atlas.json)는 이 스크립트가 건드리지 않는다 — DB가 아니라 atlas.html에서 온 큐레이션본이다.');
say('바뀐 내용은 Claude Code를 재시작해야 반영된다.');
