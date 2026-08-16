#!/usr/bin/env node
/**
 * SEP MCP — 스탠퍼드 철학 백과(Supabase) 전용 MCP 서버
 *
 * 설계 원칙
 *  1) 어휘검색·발췌·관계·링크 도구는 **의존성 0**(Node 내장 fetch만)으로 동작한다.
 *     → npm install이 실패해도 파이프라인 기본형은 살아 있다.
 *  2) 의미검색(sep_semantic)만 @xenova/transformers를 lazy import 한다.
 *     → 없으면 그 도구만 명확한 안내와 함께 실패하고, 나머지는 정상.
 *  3) URL 인코딩·type 풀 필터를 **코드가 강제**한다. 프롬프트가 실수할 여지를 없앤다.
 *
 * stdio JSON-RPC 2.0 (MCP). stdout은 프로토콜 전용 — 로그는 전부 stderr.
 */

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 설정 ───────────────────────────────────────────────
// 이 서버는 **자립형**이다. SEP 데이터(항목 1,719 · 엣지 31,001 · 임베딩 · ATLAS 867토픽)를
// data/ 에 동봉해 두었으므로 외부 DB도 API 키도 필요 없다.
// 네트워크를 쓰는 것은 sep_source(plato.stanford.edu 원문 조회) 하나뿐이다.
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
// 로그는 사용자별 개인 기록이다. 저장소(공유·커밋됨)나 플러그인 캐시(버전마다 갈아치워짐)가 아니라
// 홈 아래에 둔다. 프로젝트 안에 두고 싶으면 ORACLE_LOG_DIR로 덮어쓴다.
// 경로가 'philosophy-oracle'인 것은 의도적이다 — 플러그인을 'sep'으로 개명했지만
// 이 경로를 바꾸면 기존 로그·결과물이 고아가 되고 의미검색 의존성(261MB)을 다시 받게 된다.
const LOG_DIR = process.env.ORACLE_LOG_DIR ||
  path.join(process.env.HOME || '.', '.claude', 'philosophy-oracle', 'logs');
const POOLS = { person: 'person', keyword: 'keyword', discipline: 'discipline' };
const SERVER = { name: 'sep', version: '1.0.0' };

const log = (...a) => console.error('[sep-mcp]', ...a);

// ── 동봉 데이터 ────────────────────────────────────────
// 예전에는 Supabase PostgREST를 호출했다. 그때는 한국어 검색어가 or=(...) 안에서
// 인코딩되지 않아 조용히 빈 배열이 돌아오는 함정이 있었는데, 로컬 필터로 바꾸면서
// 그 함정 자체가 사라졌다.

function readData(file) {
  const f = path.join(DATA_DIR, file);
  if (!fs.existsSync(f)) {
    throw new Error(
      `동봉 데이터 ${file}이(가) 없다: ${f}. 플러그인이 온전히 설치되지 않았다 — ` +
      'mcp/sep/data/ 아래 entries.json · edges.json · embeddings.bin · atlas.json이 있어야 한다.'
    );
  }
  return f;
}

let _entries = null;
/** 항목 1,719건 — slug 색인과 함께 한 번만 읽는다 */
function entriesDB() {
  if (_entries) return _entries;
  const rows = JSON.parse(fs.readFileSync(readData('entries.json'), 'utf8'));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  log(`항목 로드: ${rows.length}건`);
  _entries = { rows, bySlug };
  return _entries;
}

let _edges = null;
/** 엣지 31,001건 — 노드별 인접 목록을 미리 만들어 둔다(이웃 조회가 O(1)) */
function edgesDB() {
  if (_edges) return _edges;
  const packed = JSON.parse(fs.readFileSync(readData('edges.json'), 'utf8'));
  // 저장은 배열 형식이다(키 반복을 없애 5MB로 줄였다): [source,target,ls,lt,ms,mt,note]
  const rows = packed.rows.map(([source, target, ls, lt, ms, mt, note]) =>
    ({ source, target, ls, lt, ms, mt, note: note || null }));
  const byNode = new Map();
  for (const e of rows) {
    if (!byNode.has(e.source)) byNode.set(e.source, []);
    if (!byNode.has(e.target)) byNode.set(e.target, []);
    byNode.get(e.source).push(e);
    byNode.get(e.target).push(e);
  }
  log(`엣지 로드: ${rows.length}건`);
  _edges = { rows, byNode };
  return _edges;
}

/** 풀 필터를 적용한 항목 목록 */
function poolRows(pool) {
  const { rows } = entriesDB();
  const type = poolFilter(pool);
  return type ? rows.filter((r) => r.type === type) : rows;
}

// 검색어에서 구분자·와일드카드로 오해될 문자를 제거한다.
const safeTerm = (t) =>
  String(t || '').replace(/[,()*"\\{}]/g, ' ').replace(/\s+/g, ' ').trim();

// ── 한→영 사전 (lexicon.json) ──────────────────────────
// 한국어 질문을 SEP 영어 표제어로 옮기는 변환을 **결정적으로** 만든다.
// LLM이 매번 즉흥 확장하면 실행마다 검색어가 달라져 재현성이 무너진다.
const HANGUL = /[가-힣]/;
let LEX = { concepts: {}, philosophers: {}, disciplines: {} };
try {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lexicon.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  LEX = { concepts: raw.concepts || {}, philosophers: raw.philosophers || {}, disciplines: raw.disciplines || {} };
  log(`사전 로드: 개념 ${Object.keys(LEX.concepts).length} · 철학자 ${Object.keys(LEX.philosophers).length} · 분과 ${Object.keys(LEX.disciplines).length}`);
} catch (e) {
  log('lexicon.json 없음 — 한국어 자동확장 비활성:', e.message);
}

/** 한국어 용어 하나를 영어 표제어 후보로. 정확일치 → 최장 부분문자열 순. */
function lookupLex(term) {
  const t = String(term).trim();
  for (const cat of ['philosophers', 'concepts', 'disciplines']) {
    if (LEX[cat][t]) return { cat, en: LEX[cat][t], matched: t };
  }
  for (const cat of ['philosophers', 'concepts', 'disciplines']) {
    for (const key of Object.keys(LEX[cat])) {   // 키는 긴 것부터 정렬돼 있다
      if (key.length >= 2 && t.includes(key)) return { cat, en: LEX[cat][key], matched: key };
    }
  }
  return null;
}

/** 검색어 배열에서 한국어를 찾아 영어를 덧붙인다(원 용어도 유지 — ko_desc에 걸릴 수 있으므로). */
function expandKorean(list) {
  const out = [...list];
  const expansions = {};
  const unmapped = [];
  for (const t of list) {
    if (!HANGUL.test(t)) continue;
    const hit = lookupLex(t);
    if (!hit) { unmapped.push(t); continue; }
    expansions[t] = { matched_key: hit.matched, category: hit.cat, en: hit.en };
    for (const e of hit.en) if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
  }
  return { terms: out, expansions, unmapped };
}

const poolFilter = (pool) => {
  if (!pool || pool === 'all') return null;
  const p = POOLS[pool];
  if (!p) throw new Error(`pool은 person|keyword|discipline|all 중 하나여야 한다 (받은 값: ${pool})`);
  return p;
};

// ── 도구 구현 ──────────────────────────────────────────
// ⚠ 데이터 실측(2026-08-15): sep_entries.intro 는 1,719행 전부 NULL이다.
//   DB에 SEP 영어 원문 텍스트는 없다 — 채워진 본문은 ko_desc(한국어 요약) 뿐.
//   따라서 어휘검색은 title·ko_desc로 하고, 영어 verbatim 근거가 필요하면
//   sep_source가 SEP 페이지를 직접 받아 온다.
const SELECT_LIST = 'slug,title,url,type,ko_desc,topics,wdeg';

/** 여러 영어/한국어 용어를 한 번에 OR 검색하고 로컬 랭킹으로 정렬 */
async function sepSearch({ terms, pool = 'all', limit = 8, fields = ['title', 'ko_desc'] }) {
  const given = (Array.isArray(terms) ? terms : [terms]).map(safeTerm).filter(Boolean);
  if (!given.length) throw new Error('terms가 비어 있다. 검색어를 1개 이상 넣어라.');

  // 한국어가 섞여 있으면 사전으로 영어 표제어를 자동 보강한다.
  const { terms: list, expansions, unmapped } = expandKorean(given);

  // 어느 필드든 어느 검색어든 하나라도 걸리면 후보 (예전 PostgREST or=(...)와 같은 의미)
  const needles = list.map((t) => t.toLowerCase());
  const hay = (r, f) => {
    const v = r[f];
    return Array.isArray(v) ? v.join(' ').toLowerCase() : String(v || '').toLowerCase();
  };
  const rows = poolRows(pool).filter((r) =>
    needles.some((n) => fields.some((f) => hay(r, f).includes(n))));

  // 랭킹: 제목 일치 > 한국어설명 일치 > 본문 일치, 동점은 wdeg
  const lc = (s) => String(s || '').toLowerCase();
  // 랭킹 — 표제어에 가까울수록 높게. 2026-08-15 실측 두 가지를 반영한다:
  //  · wdeg는 인물 484행에만 있다(키워드·분과 풀에서는 항상 null) → 주 정렬 기준이 될 수 없다.
  //  · SEP의 대표 표제어는 짧다("Realism"). 긴 제목은 파생 주제다("Political Realism in
  //    International Relations"). 같은 점수면 짧은 제목이 질문의 정면에 가깝다.
  const wordHit = (hay, needle) => {
    const i = hay.indexOf(needle);
    if (i < 0) return false;
    const before = hay[i - 1], after = hay[i + needle.length];
    const isWord = (c) => c !== undefined && /[a-z0-9]/.test(c);
    return !isWord(before) && !isWord(after);
  };

  const scored = rows.map((r) => {
    let score = 0;
    const matched = [];
    const title = lc(r.title), desc = lc(r.ko_desc), topicText = lc((r.topics || []).join(' | '));
    list.forEach((t, idx) => {
      const q = t.toLowerCase();
      let s = 0;
      if (title === q) s = 40;                    // 제목이 곧 그 개념
      else if (wordHit(title, q)) s = 18;         // 제목에 단어 단위로 등장
      else if (title.includes(q)) s = 10;         // 제목에 부분문자열로
      else if (desc.includes(q)) s = 4;
      else if (topicText.includes(q)) s = 3;
      // terms 배열의 앞쪽이 핵심어라는 규약을 반영한다(Agent 1이 core→broader→adjacent→opposing
      // 순으로 넘긴다). 핵심어 매칭이 주변어 매칭에 밀려나는 것을 막는 완만한 가산점.
      if (s) { score += s + Math.max(0, 8 - idx); matched.push(t); }
    });
    return { r, score, matched: [...new Set(matched)] };
  });
  // 마지막 동점은 slug로 끊는다 — 같은 질문이 실행마다 다른 순서를 내면
  // 파이프라인의 재현성이 깨진다(사전을 둔 이유와 같은 문제다).
  scored.sort((a, b) =>
    b.score - a.score ||
    a.r.title.length - b.r.title.length ||
    (b.r.wdeg || 0) - (a.r.wdeg || 0) ||
    a.r.slug.localeCompare(b.r.slug));

  const out = scored.slice(0, limit).map(({ r, matched }) => ({
    slug: r.slug, title: r.title, url: r.url, type: r.type,
    ko_desc: r.ko_desc,
    topics: (r.topics || []).slice(0, 8),
    wdeg: r.wdeg,
    matched_terms: matched,
  }));

  return {
    pool,
    given_terms: given,
    queried_terms: list,
    ko_expansions: Object.keys(expansions).length ? expansions : undefined,
    unmapped_korean: unmapped.length ? unmapped : undefined,
    total_candidates: rows.length, returned: out.length,
    searched_fields: 'title, ko_desc (한국어 요약) — DB에 영어 본문은 없다',
    hint: out.length === 0
      ? '0건이다. URL 인코딩 문제는 아니다(서버가 처리한다). 용어가 SEP 표제어와 다를 가능성이 크니 다른 영어 용어로 재시도하고, 그래도 없으면 sep_semantic으로 의미검색하라.'
      : '한국어 근거는 sep_excerpt(slug), 영어 원문 verbatim 근거와 딥링크는 sep_source(slug, terms)로 받아라.',
    lexicon_note: unmapped.length
      ? `사전에 없는 한국어: ${unmapped.join(', ')} — 이 용어들은 ko_desc 부분일치로만 검색됐다. 영어 표제어를 직접 넣어 재검색하는 편이 낫다.`
      : undefined,
    entries: out,
  };
}

/** 한국어 철학 용어 → SEP 영어 표제어 조회. Agent 1이 검색어를 만들기 전에 쓴다. */
async function sepLexicon({ terms }) {
  const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) throw new Error('terms가 비어 있다.');
  const found = {}, missing = [];
  for (const t of list) {
    const hit = lookupLex(t);
    if (hit) found[t] = { matched_key: hit.matched, category: hit.cat, en: hit.en, canonical: hit.en[0] };
    else missing.push(t);
  }
  return {
    size: {
      concepts: Object.keys(LEX.concepts).length,
      philosophers: Object.keys(LEX.philosophers).length,
      disciplines: Object.keys(LEX.disciplines).length,
    },
    found, missing,
    note: '`canonical`이 대표 영어어다. 검색어를 만들 때 사전에 있는 표현을 우선 쓰면 실행마다 결과가 흔들리지 않는다.',
    missing_advice: missing.length
      ? '사전에 없는 용어는 네가 직접 영어 표제어를 지어 넣되, SEP 항목 제목에 쓰일 법한 표현으로 하라. 확신이 없으면 sep_semantic으로 의미검색해 실제 표제어를 확인한 뒤 그 제목을 검색어로 삼아라.'
      : undefined,
  };
}

/** pgvector 의미검색 — 한국어 질문을 그대로 넣어도 영어 본문과 매칭된다 */
// 결과가 아니라 Promise를 캐시한다 — 동시 호출이 모델을 두 번 로드하는 경합을 막는다.
let _embedderP = null;
const getEmbedder = () => (_embedderP ??= initEmbedder());

async function initEmbedder() {
  let pipeline;
  try {
    ({ pipeline } = await import('@xenova/transformers'));
  } catch (e) {
    _embedderP = null; // 실패는 캐시하지 않는다(설치 후 재시도 가능하도록)
    throw new Error(
      '의미검색 의존성(@xenova/transformers)이 없다. 플러그인 MCP 폴더에서 `bash run.sh`가 최초 실행 시 자동 설치하지만, ' +
      '설치가 실패한 상태다. 수동 설치: cd ~/.claude/philosophy-oracle/mcp-sep && npm install. ' +
      '그동안은 sep_search(어휘검색)를 쓰면 된다. 원인: ' + e.message
    );
  }
  log('임베딩 모델 로드 중 (Xenova/multilingual-e5-small)…');
  const p = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  log('임베딩 모델 준비 완료');
  return p;
}

/**
 * 임베딩 전량을 메모리에 올린다(1,719 × 384 float ≈ 2.6MB).
 *
 * 유사도는 여기서 직접 계산한다. 예전에 서버 RPC(match_entries)를 쓰던 시절
 * 그 함수가 match_count와 무관하게 40건에서 자르고 type='person' 항목을 한 건도
 * 반환하지 않는 결함이 있었는데(2026-08-15 실측: Kant 0.8374 > Free Will 0.8234인데도 누락),
 * 로컬 계산에는 그런 절단이 없고 풀 필터도 정확하다.
 */
let _vectorsP = null;
const loadVectors = () => (_vectorsP ??= initVectors());

const EMBED_DIM = 384;

async function initVectors() {
  // embeddings.bin은 entries.json과 **같은 순서**의 float32 배열이다(항목당 384차원).
  // JSON으로 두면 9MB인데 바이너리로는 2.5MB이고 파싱도 없다.
  const { rows } = entriesDB();
  const buf = fs.readFileSync(readData('embeddings.bin'));
  const expect = rows.length * EMBED_DIM * 4;
  if (buf.length !== expect) {
    throw new Error(`embeddings.bin 크기 불일치: ${buf.length}바이트, 기대 ${expect}. 데이터가 손상됐다.`);
  }
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, rows.length * EMBED_DIM);
  const vectors = rows.map((r, i) => {
    const v = f32.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM);
    let n = 0;
    for (let d = 0; d < EMBED_DIM; d++) n += v[d] * v[d];
    return { r, v, norm: Math.sqrt(n) };
  });
  log(`임베딩 ${vectors.length}건 로드`);
  return vectors;
}

async function sepSemantic({ q, pool = 'all', limit = 8 }) {
  if (!q || !String(q).trim()) throw new Error('q가 비어 있다.');
  const type = poolFilter(pool);
  const embed = await getEmbedder();
  // 로더(load_sep.mjs)가 'passage: '로 임베딩했으므로 질의는 'query: ' 접두어를 쓴다.
  const out = await embed('query: ' + q, { pooling: 'mean', normalize: true });
  const qv = Float32Array.from(out.data);
  let qn = 0;
  for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i];
  qn = Math.sqrt(qn);

  const pool_ = await loadVectors();
  const scored = [];
  for (const { r, v, norm } of pool_) {
    if (type && r.type !== type) continue;
    let dot = 0;
    for (let i = 0; i < 384; i++) dot += qv[i] * v[i];
    scored.push({ r, similarity: dot / (qn * norm) });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.r.slug.localeCompare(b.r.slug));

  return {
    mode: 'semantic — multilingual-e5-small 384d, 코사인 로컬 계산 (배포된 match_entries RPC는 인물 누락 버그로 우회)',
    pool, query: q, searched: scored.length, returned: Math.min(limit, scored.length),
    note: 'similarity는 코사인(1=완전일치). e5는 값이 압축돼 있어 0.80 미만이면 관련성을 의심하라. ' +
          '근거 문장은 한국어면 sep_excerpt, 영어 원문이면 sep_source로 받아라.',
    entries: scored.slice(0, limit).map(({ r, similarity }) => ({
      slug: r.slug, title: r.title, url: r.url, type: r.type,
      similarity: Number(similarity.toFixed(4)),
      ko_desc: r.ko_desc, topics: (r.topics || []).slice(0, 8), wdeg: r.wdeg,
    })),
  };
}

async function sepGet({ slug }) {
  if (!slug) throw new Error('slug가 필요하다.');
  const row = entriesDB().bySlug.get(String(slug));
  if (!row) throw new Error(`slug "${slug}" 항목이 없다.`);
  return row;
}

/** 문장 분할 + 질의어 밀집도 랭킹 (한국어·영어 공용) */
function rankSentences(text, terms, n) {
  const sentences = String(text || '')
    .split(/(?<=[.!?。])\s+|(?<=다\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
  if (!sentences.length) return [];

  const list = (Array.isArray(terms) ? terms : [terms]).map(safeTerm).filter(Boolean);
  const scored = sentences.map((s) => {
    const lc = s.toLowerCase();
    let hits = 0;
    for (const t of list) if (lc.includes(t.toLowerCase())) hits++;
    return { s, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  const hit = scored.filter((x) => x.hits > 0).slice(0, n);
  return hit.length ? hit : scored.slice(0, Math.min(n, scored.length));
}

/** DB의 한국어 요약(ko_desc)에서 발췌 — 빠름(네트워크 1회). 영어 원문이 아니다. */
async function sepExcerpt({ slug, terms = [], n = 3 }) {
  const e = await sepGet({ slug });
  const chosen = rankSentences(e.ko_desc, terms, n);
  return {
    slug, title: e.title, url: e.url, type: e.type,
    source: 'sep_entries.ko_desc — 한국어 요약(SEP 원문 번역이 아니라 요약 서술)',
    warning:
      '이 text는 SEP 영어 원문이 아니다. 답변에 "SEP 원문 인용"으로 제시하지 마라. ' +
      '영어 verbatim 인용과 진짜 text-fragment 딥링크가 필요하면 sep_source를 써라.',
    excerpts: chosen.map(({ s, hits }) => ({ text: s, matched_terms: hits })),
    sep_entry_url: e.url,
  };
}

// ── SEP 원문 페이지에서 영어 verbatim 뽑기 ───────────────
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function extractMainText(html) {
  let s = html;
  const i = s.indexOf('id="main-text"');
  if (i >= 0) s = s.slice(i);
  const j = s.search(/id="(bibliography|academic-tools|other-internet-resources|related-entries)"/i);
  if (j > 0) s = s.slice(0, j);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** SEP 원문 HTML을 직접 받아 영어 문장을 verbatim으로 뽑고 text-fragment 딥링크를 만든다 */
async function sepSource({ slug, terms = [], n = 3 }) {
  const e = await sepGet({ slug });
  const res = await fetch(e.url, { headers: { 'User-Agent': 'philosophy-oracle-mcp/1.0' } });
  if (!res.ok) throw new Error(`SEP 원문 요청 실패 ${res.status}: ${e.url}`);
  const text = extractMainText(await res.text());
  if (text.length < 200) throw new Error(`SEP 원문 본문 추출 실패(${text.length}자). url=${e.url}`);

  const chosen = rankSentences(text, terms, n);
  return {
    slug, title: e.title, url: e.url, type: e.type,
    source: 'SEP 원문 HTML (plato.stanford.edu) 실시간 추출',
    note: '아래 text는 SEP 원문의 정확한 부분문자열이다. 그대로 인용하라. deeplink는 원문의 그 구절로 바로 이동한다.',
    fetched_chars: text.length,
    excerpts: chosen.map(({ s, hits }) => ({
      text: s,
      matched_terms: hits,
      deeplink: `${e.url}#:~:text=${encodeURIComponent(s.split(/\s+/).slice(0, 9).join(' '))}`,
    })),
  };
}

/** COSMOS 관계 데이터(sep_edges 31,001) — 근거를 이웃으로 넓힐 때 */
async function sepNeighbors({ slug, limit = 10 }) {
  if (!slug) throw new Error('slug가 필요하다.');
  const rows = edgesDB().byNode.get(String(slug)) || [];
  const edges = rows
    .map((r) => ({
      other: r.source === slug ? r.target : r.source,
      weight: (r.ls || 0) + (r.lt || 0) + (r.ms || 0) + (r.mt || 0),
      note: r.note,
    }))
    .sort((a, b) => b.weight - a.weight || a.other.localeCompare(b.other))
    .slice(0, limit);

  if (!edges.length) return { slug, neighbors: [], note: '연결된 항목이 없다.' };

  const { bySlug } = entriesDB();
  const byslug = Object.fromEntries(
    edges.map((e) => bySlug.get(e.other)).filter(Boolean).map((t) => [t.slug, t]));

  return {
    slug, returned: edges.length,
    note: 'weight=상호참조+언급 횟수 합. note는 사람이 쓴 한국어 관계 해설이라 그대로 인용해도 된다.',
    neighbors: edges.map((e) => ({ ...byslug[e.other], weight: e.weight, relation_note: e.note })),
  };
}


// ── 근거 집합에 대한 모듈 뷰 ───────────────────────────
/**
 * ORACLE이 확정한 근거 항목들을 받아 COSMOS·CHRONOS·ATLAS 세 관점을 한 번에 만든다.
 * 링크만 주면 브라우저를 열어야 하므로, 답변 안에서 바로 보이게 하는 것이 목적이다.
 *
 * 핵심은 **근거 항목들 사이의 관계**다(바깥 이웃 전체가 아니라).
 * 답변이 어떤 항목들 위에 서 있고 그것들이 서로 어떻게 얽혀 있는지가 드러나야 한다.
 */
async function sepEvidenceView({ slugs, atlas_topic, neighbor_limit = 3 }) {
  const list = (Array.isArray(slugs) ? slugs : [slugs]).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) throw new Error('slugs가 비어 있다. 확정된 근거 항목의 slug 배열을 넣어라.');

  const { bySlug } = entriesDB();
  const entries = list.map((s) => bySlug.get(s)).filter(Boolean);
  const known = new Set(entries.map((e) => e.slug));
  const missing = list.filter((s) => !known.has(s));
  const byslug = Object.fromEntries(entries.map((e) => [e.slug, e]));

  // ── COSMOS: 근거 항목들 사이의 엣지 ──
  // 근거 집합 **안쪽** 엣지만 — 양 끝이 모두 목록에 있어야 한다
  const inSet = new Set(list);
  const seen = new Set();
  const edges = [];
  for (const s of list) {
    for (const e of edgesDB().byNode.get(s) || []) {
      if (!inSet.has(e.source) || !inSet.has(e.target)) continue;
      const k = `${e.source}\u0000${e.target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push(e);
    }
  }
  const inner = edges
    .map((e) => ({
      source: e.source, target: e.target,
      source_title: byslug[e.source]?.title, target_title: byslug[e.target]?.title,
      weight: (e.ls || 0) + (e.lt || 0) + (e.ms || 0) + (e.mt || 0),
      relation_note: e.note,
    }))
    .sort((a, b) => b.weight - a.weight ||
      (a.source + a.target).localeCompare(b.source + b.target));

  // 근거 밖 이웃 — 대표 항목 기준 상위 몇 개만.
  //
  // 허브는 **근거 집합 안에서의 연결도**로 고른다. 전역 연결도(wdeg)로 고르면 두 가지가 깨진다:
  //  (1) wdeg는 인물 행(484개)에만 있어서 개념 중심 근거 집합에서도 늘 인물이 뽑힌다.
  //  (2) 전역으로 유명한 항목이 이 근거 집합에서는 주변적일 수 있다.
  // 2026-08-16 실측: 근거 12건(쿤 공약불가능성)에서 Davidson이 wdeg 226으로 뽑혔으나
  // 집합 내부 엣지는 단 1개(가중치 7)뿐이었고, 그 결과 이웃이 무법칙적 일원론·행위·의지박약로
  // 채워져 질문과 완전히 무관해졌다. 내부 연결도로는 Thomas Kuhn(447)이 뽑힌다.
  let outside = [];
  const innerDeg = {};
  for (const e of inner) {
    innerDeg[e.source] = (innerDeg[e.source] || 0) + e.weight;
    innerDeg[e.target] = (innerDeg[e.target] || 0) + e.weight;
  }
  const ranked = entries
    .map((e) => ({ e, deg: innerDeg[e.slug] || 0 }))
    .sort((a, b) => b.deg - a.deg || (b.e.wdeg || 0) - (a.e.wdeg || 0));
  const top = ranked[0];
  // 내부 엣지가 하나도 없으면 "이 집합이 무엇에 관한 것인가"라는 신호 자체가 없다.
  // 그럴 때만 전역 연결도로 물러서고, 그 사실을 밝힌다.
  const hubBy = top && top.deg > 0 ? 'inner_degree' : 'wdeg_fallback';
  const hub = hubBy === 'inner_degree'
    ? top.e
    : (entries.filter((x) => x.wdeg != null).sort((a, b) => b.wdeg - a.wdeg)[0] || entries[0]);
  const hubDeg = hub ? (innerDeg[hub.slug] || 0) : 0;
  if (hub && neighbor_limit > 0) {
    try {
      const n = await sepNeighbors({ slug: hub.slug, limit: neighbor_limit + list.length });
      outside = (n.neighbors || []).filter((x) => x && !known.has(x.slug)).slice(0, neighbor_limit);
    } catch { /* 이웃 조회 실패는 치명적이지 않다 */ }
  }

  // ── CHRONOS: 근거 중 인물 ──
  const persons = entries.filter((e) => e.type === 'person' && e.birth != null)
    .sort((a, b) => a.birth - b.birth)
    .map((e) => ({
      slug: e.slug, title: e.title, birth: e.birth, death: e.death, approx: e.approx,
      era: e.era, nationality: e.nationality, branch: e.branch,
    }));
  const undatedPersons = entries.filter((e) => e.type === 'person' && e.birth == null).map((e) => e.title);

  // ── ATLAS: 지정 토픽이 있으면 그 분포 ──
  let atlas = null;
  if (atlas_topic) {
    try {
      const a = await sepAtlas({ topic: atlas_topic, limit: 12 });
      atlas = { topic: a.topic, total_persons: a.total_persons, by_era: a.by_era, by_nationality: a.by_nationality };
    } catch (e) {
      atlas = { error: e.message };
    }
  }

  return {
    resolved: entries.length,
    missing_slugs: missing.length ? missing : undefined,
    cosmos: {
      inner_edges: inner,
      inner_edge_count: inner.length,
      outside_neighbors: outside,
      note: inner.length
        ? '근거 항목들 사이의 연결이다. relation_note는 사람이 쓴 한국어 해설이니 그대로 인용하라.'
        : '근거 항목들 사이에 직접 연결이 없다 — 서로 다른 갈래의 근거를 모았다는 뜻이다. 그렇게 밝혀라.',
    },
    chronos: {
      persons,
      undated: undatedPersons.length ? undatedPersons : undefined,
      span: persons.length ? { earliest: persons[0].birth, latest: persons[persons.length - 1].birth } : null,
      note: 'birth/death 음수는 기원전 — 출력할 때 "기원전 469–399" 형태로 바꿔라.',
    },
    atlas,
    hub: hub ? {
      slug: hub.slug, title: hub.title, wdeg: hub.wdeg,
      inner_degree: hubDeg,
      selected_by: hubBy,
      note: hubBy === 'wdeg_fallback'
        ? '근거 항목들 사이에 엣지가 없어 집합 내부 연결도로 허브를 정할 수 없었다. 전역 연결도로 물러선 것이므로 outside_neighbors가 질문과 무관할 수 있다 — 무관하면 그 절을 싣지 마라.'
        : undefined,
    } : null,
  };
}

// ── 시대 순서 (ATLAS 분포 정렬용) ──────────────────────
const ERA_ORDER = ['고대', '중세', '르네상스', '근대초기', '근대', '현대'];


// ── ATLAS — 담론지도 조회 ──────────────────────────────
/**
 * ⚠ ATLAS 데이터는 DB 파생이 아니다.
 * atlas.html에 내장된 867개 토픽은 큐레이션을 거쳤다 — 예컨대 `mereology-medieval`은
 * sep_edges로 계산하면 인물 20명(소크라테스·플라톤 등 고대 인물 포함)이 나오지만
 * ATLAS는 13명만 보여준다. 따라서 DB로 재현하면 모듈과 다른 답이 나온다.
 * 모듈과 결과를 일치시키기 위해 atlas.html의 내장 JSON을 직접 읽는다.
 */
let _atlasP = null;
const loadAtlas = () => (_atlasP ??= initAtlas());

async function initAtlas() {
  // 예전에는 프로젝트의 sep_analysis/atlas.html을 찾아 내장 JSON을 긁었다.
  // 그러면 플러그인만 설치한 사람에게는 ATLAS 절이 통째로 빠졌으므로 데이터를 동봉했다.
  const { topics, geo } = JSON.parse(fs.readFileSync(readData('atlas.json'), 'utf8'));
  log(`ATLAS 로드: 토픽 ${Object.keys(topics || {}).length}`);
  return { topics: topics || {}, region: (geo || {}).region || {} };
}

async function sepAtlas({ topic, limit = 30 }) {
  const { topics, region } = await loadAtlas();

  if (!topic) {
    const list = Object.entries(topics)
      .map(([id, v]) => ({ id, label: v.l, type: v.t, persons: (v.p || []).length }))
      .sort((a, b) => b.persons - a.persons);
    return {
      mode: '토픽 목록', total: list.length,
      note: '인물 수 많은 순. 특정 토픽을 보려면 topic에 id를 넣어라.',
      topics: list.slice(0, limit),
    };
  }

  const q = String(topic).toLowerCase();
  let id = Object.keys(topics).find((k) => k.toLowerCase() === q)
    || Object.keys(topics).find((k) => (topics[k].l || '').toLowerCase() === q)
    || Object.keys(topics).find((k) => k.toLowerCase().includes(q) || (topics[k].l || '').toLowerCase().includes(q));
  if (!id) {
    const near = Object.entries(topics)
      .filter(([k, v]) => k.includes(q) || (v.l || '').toLowerCase().includes(q))
      .slice(0, 8).map(([k, v]) => ({ id: k, label: v.l }));
    throw new Error(`토픽 "${topic}"을 찾을 수 없다.` + (near.length ? ` 비슷한 것: ${near.map((x) => x.id).join(', ')}` : ' topic 없이 호출하면 목록이 나온다.'));
  }

  const v = topics[id];
  // p 배열 스키마: [국적, 생년, 몰년, 가중치, 이름, 노드id, 시대]
  const persons = (v.p || []).map((a) => ({
    nationality: a[0], birth: a[1], death: a[2], weight: a[3], name: a[4], node_id: a[5], era: a[6],
  }));
  const tally = (key) => {
    const c = {};
    for (const p of persons) { const k = p[key] || '미상'; c[k] = (c[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]));
  };
  const byEra = tally('era');
  const ordered = Object.fromEntries(
    ERA_ORDER.filter((e) => byEra[e]).map((e) => [e, byEra[e]])
      .concat(Object.entries(byEra).filter(([k]) => !ERA_ORDER.includes(k))));

  return {
    mode: '토픽 상세',
    topic: { id, label: v.l, type: v.t },
    source: 'atlas.html 내장 데이터 — DB 계산이 아니라 ATLAS 모듈과 동일한 큐레이션본',
    total_persons: persons.length,
    by_era: ordered,
    by_nationality: tally('nationality'),
    region_map: region && Object.keys(region).length ? '국적→지역 매핑 있음' : undefined,
    persons: persons.sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, limit),
    note: 'weight는 그 토픽 안에서의 비중이다. birth/death 음수는 기원전.',
  };
}

// ── 실행 로그 ──────────────────────────────────────────
/**
 * 파이프라인 실행 기록을 파일로 남긴다.
 * 프롬프트에만 맡기면 잊히므로 도구로 만들어 두고, 경로·시각 스탬프는 서버가 찍는다.
 */
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return {
    id: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    human: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

async function sepLog({ run_id, step, content, question, command }) {
  if (!step && !question) throw new Error('step 또는 question 중 하나는 필요하다.');
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const now = stamp();
  let id = run_id;
  let created = false;

  if (!id) {
    id = now.id;
    created = true;
  }
  const file = path.join(LOG_DIR, `oracle-${id}.md`);

  if (created || !fs.existsSync(file)) {
    const head =
      `# ORACLE 실행 기록 — ${id}\n\n` +
      `- **시작**: ${now.human}\n` +
      `- **커맨드**: ${command || '/philosophy-oracle:oracle'}\n` +
      `- **질문**: ${question || '(미기재)'}\n\n---\n`;
    fs.writeFileSync(file, head);
  }

  if (step) {
    fs.appendFileSync(file, `\n## ${step}\n_${now.human}_\n\n${content || ''}\n`);
  }

  return {
    run_id: id,
    path: file,
    appended: step || '(헤더만)',
    bytes: fs.statSync(file).size,
    note: created
      ? '새 실행 로그를 시작했다. 이후 단계에서는 이 run_id를 그대로 넘겨라.'
      : undefined,
  };
}

/**
 * 결과물(답변) 파일 — 로그와 분리한다.
 * 로그(oracle-<id>.md)는 과정 추적용이라 검색어·폐기 후보·게이트 선택이 섞여 있다.
 * 답변만 따로 필요할 때 그 안에서 캐내야 하는 불편을 없애려고 answer-<id>.md를 따로 쓴다.
 * 같은 폴더에 나란히 두어 한 실행의 산출물이 붙어 있게 한다.
 */
async function sepAnswer({ run_id, question, body, section, verdict }) {
  if (!run_id) throw new Error('run_id가 필요하다. sep_log가 돌려준 id를 그대로 넘겨라.');
  if (!body) throw new Error('body(답변 본문)가 비어 있다.');
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const now = stamp();
  const file = path.join(LOG_DIR, `answer-${run_id}.md`);
  const title = section || 'SEP 근거 답변';

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file,
      `# ${question || '(질문 미기재)'}\n\n` +
      `> PHILOSOPHY · ORACLE — ${now.human}\n` +
      `> 과정 기록: \`oracle-${run_id}.md\`\n\n---\n`);
  }

  let chunk = `\n## ${title}\n\n${body}\n`;
  if (verdict) chunk += `\n### 검증\n\n${verdict}\n`;
  fs.appendFileSync(file, chunk);

  return {
    run_id, path: file, section: title, bytes: fs.statSync(file).size,
    note: '결과물 파일이다(과정 기록은 별도). 확장 답변이 나오면 같은 run_id로 다시 호출해 section을 붙여라.',
  };
}

/**
 * 누적 교훈·선호 저장소 — 실행 간 유일한 상태다.
 *
 * 실행마다 run_id가 새로 나고 아무것도 이어지지 않으면, 같은 실수가 매번 반복되고
 * 사용자의 범위 결정도 매번 처음부터 다시 말해야 한다. 그래서 두 가지를 남긴다.
 *
 * **둘을 절대 섞지 마라** — 이것이 이 도구의 설계 핵심이다:
 *  - `lesson`     = 시스템이 실제로 틀린 것. 다음 실행에서 반복하지 말아야 한다.
 *  - `preference` = 사용자가 의도적으로 내린 범위 결정. **오류가 아니다.**
 *                   "고쳐야 할 것"으로 취급하면 사용자 의도를 시스템이 되돌리는 꼴이 된다.
 *
 * jsonl이 원본이고 md는 사람이 읽으라고 매번 다시 렌더한다.
 * 같은 key로 다시 add하면 hits가 오른다 — 반복될수록 눈에 띄게 하려는 것이다.
 */
const LESSON_DIR = process.env.ORACLE_LESSON_DIR || path.dirname(LOG_DIR);
const LESSON_JSONL = path.join(LESSON_DIR, 'lessons.jsonl');
const LESSON_MD = path.join(LESSON_DIR, 'lessons.md');

const KINDS = {
  lesson: { label: '교훈 — 시스템이 틀렸던 것', note: '다음 실행에서 반복하지 마라.' },
  preference: { label: '선호 — 사용자의 범위 결정', note: '오류가 아니다. 일관되게 유지하라.' },
};

function readLessons() {
  if (!fs.existsSync(LESSON_JSONL)) return [];
  return fs.readFileSync(LESSON_JSONL, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// hits가 쌓일수록 강하게 표시한다. 두 번 이상 재발한 것은 프롬프트에 넣기만 해서는
// 안 고쳐진다는 뜻이므로 사람이 스킬 파일을 손볼 신호로 쓴다.
function severity(hits) {
  if (hits >= 3) return '🔴 세 번 이상 재발 — 스킬 파일을 고쳐야 한다';
  if (hits >= 2) return '⚠ 재발';
  return '';
}

function renderLessons(all) {
  const now = stamp();
  let out = `# ORACLE 누적 교훈·선호\n\n_갱신 ${now.human} · 총 ${all.length}건_\n\n` +
    `> 이 파일은 \`sep_lesson\`이 자동으로 다시 쓴다. 직접 고치려면 \`lessons.jsonl\`을 고쳐라.\n\n`;
  for (const kind of Object.keys(KINDS)) {
    const rows = all.filter((e) => e.kind === kind)
      .sort((a, b) => (b.hits || 1) - (a.hits || 1) || String(b.last).localeCompare(String(a.last)));
    out += `\n---\n\n## ${KINDS[kind].label}  (${rows.length}건)\n\n_${KINDS[kind].note}_\n`;
    if (!rows.length) { out += `\n(없음)\n`; continue; }
    for (const e of rows) {
      const sev = severity(e.hits || 1);
      out += `\n### ${e.key}${sev ? `  ${sev}` : ''}\n` +
        `- **적용 대상**: ${e.scope || '(전체)'}\n` +
        `- **횟수**: ${e.hits || 1}회 · 최초 ${e.first} · 최근 ${e.last}\n` +
        `- **내용**: ${e.text}\n` +
        (e.why ? `- **이렇게 분류한 근거**: ${e.why}\n` : '') +
        (e.runs?.length ? `- **실행**: ${e.runs.slice(-5).join(', ')}${e.runs.length > 5 ? ` 외 ${e.runs.length - 5}건` : ''}\n` : '');
    }
  }
  return out;
}

async function sepLesson({ action, kind, key, scope, text, why, run_id, filter_scope, filter_kind }) {
  fs.mkdirSync(LESSON_DIR, { recursive: true });
  const act = action || 'read';

  if (act === 'read') {
    let all = readLessons();
    const total = all.length;
    if (filter_kind) all = all.filter((e) => e.kind === filter_kind);
    if (filter_scope) {
      const q = String(filter_scope).toLowerCase();
      all = all.filter((e) => !e.scope || String(e.scope).toLowerCase().includes(q) || q.includes(String(e.scope).toLowerCase()));
    }
    if (!total) {
      return {
        total: 0, returned: 0, path: LESSON_MD, entries: [],
        note: '누적된 교훈이 아직 없다. 첫 실행이거나 아직 아무것도 기록하지 않았다. 그대로 진행하라.',
      };
    }
    return {
      total,
      returned: all.length,
      path: LESSON_MD,
      lessons: all.filter((e) => e.kind === 'lesson')
        .sort((a, b) => (b.hits || 1) - (a.hits || 1))
        .map((e) => ({ key: e.key, scope: e.scope, hits: e.hits || 1, severity: severity(e.hits || 1) || undefined, text: e.text })),
      preferences: all.filter((e) => e.kind === 'preference')
        .sort((a, b) => (b.hits || 1) - (a.hits || 1))
        .map((e) => ({ key: e.key, scope: e.scope, hits: e.hits || 1, text: e.text })),
      note:
        '**lesson은 고칠 것, preference는 지킬 것이다. 섞지 마라.** ' +
        'lesson은 관련 있는 것만 골라 해당 담당 에이전트 프롬프트에 넣어라(전부 넣으면 프롬프트가 잡음이 된다). ' +
        'preference는 후보를 제시하는 게이트(③⑧⑩)에서 반영하되, 사용자가 이번에 다르게 고르면 그 선택이 우선이다.',
    };
  }

  if (act === 'add') {
    if (!kind || !KINDS[kind]) throw new Error("kind는 'lesson' 또는 'preference'여야 한다. 사용자의 의도적 범위 결정을 lesson으로 적지 마라.");
    if (!key) throw new Error('key가 필요하다(짧은 kebab-case 식별자 — 재발 판정에 쓴다).');
    if (!text) throw new Error('text가 비어 있다.');

    const all = readLessons();
    const now = stamp();
    const i = all.findIndex((e) => e.key === key && e.kind === kind);
    let entry, recurred = false;

    if (i >= 0) {
      entry = all[i];
      entry.hits = (entry.hits || 1) + 1;
      entry.last = now.human;
      entry.text = text;
      if (why) entry.why = why;
      if (scope) entry.scope = scope;
      entry.runs = [...new Set([...(entry.runs || []), run_id].filter(Boolean))];
      all[i] = entry;
      recurred = true;
    } else {
      entry = { key, kind, scope: scope || null, text, why: why || null, hits: 1, first: now.human, last: now.human, runs: run_id ? [run_id] : [] };
      all.push(entry);
    }

    fs.writeFileSync(LESSON_JSONL, all.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(LESSON_MD, renderLessons(all));

    return {
      key, kind, hits: entry.hits, recurred,
      path: LESSON_MD, total: all.length,
      severity: severity(entry.hits) || undefined,
      note: recurred
        ? (entry.hits >= 3
          ? '🔴 세 번째 이상 재발이다. 프롬프트에 교훈을 넣는 것만으로는 안 고쳐진다는 뜻이니, 해당 스킬·에이전트 파일 자체를 고치라고 사용자에게 알려라.'
          : '⚠ 재발이다. 다음 실행에서 이 항목을 해당 담당 프롬프트에 반드시 넣어라.')
        : '새로 기록했다.',
    };
  }

  if (act === 'remove') {
    if (!key) throw new Error('key가 필요하다.');
    const all = readLessons();
    const left = all.filter((e) => !(e.key === key && (!kind || e.kind === kind)));
    if (left.length === all.length) return { removed: 0, note: '그 key를 찾지 못했다.' };
    fs.writeFileSync(LESSON_JSONL, left.map((e) => JSON.stringify(e)).join('\n') + (left.length ? '\n' : ''));
    fs.writeFileSync(LESSON_MD, renderLessons(left));
    return { removed: all.length - left.length, total: left.length, path: LESSON_MD };
  }

  throw new Error("action은 'read' | 'add' | 'remove' 중 하나여야 한다.");
}

// ── 도구 스키마 ────────────────────────────────────────
const POOL_SCHEMA = {
  type: 'string', enum: ['person', 'keyword', 'discipline', 'all'],
  description: '검색할 SEP 풀. person=인물 484개, keyword=개념 931개, discipline=분과 304개, all=전체 1,719개. 담당 에이전트는 자기 풀을 지정하라.',
};

const TOOLS = [
  {
    name: 'sep_log',
    description:
      '파이프라인 실행 기록을 사용자 홈의 로그 파일에 남긴다(기본 `~/.claude/philosophy-oracle/logs/oracle-<run_id>.md`, `ORACLE_LOG_DIR`로 변경 가능). ' +
      '**①에서 run_id 없이 question과 함께 한 번 호출해 실행을 시작하고, 이후 매 단계마다 그 run_id로 append하라.** 시각 스탬프와 경로는 서버가 찍는다.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '이어 쓸 실행 id. **처음 호출에서는 비워라** — 서버가 만들어 돌려준다.' },
        question: { type: 'string', description: '사용자 질문(첫 호출에서만 · 헤더에 기록된다)' },
        command: { type: 'string', description: '실행 커맨드(첫 호출에서만, 예: /philosophy-oracle:oracle 또는 /philosophy-oracle:locate)' },
        step: { type: 'string', description: '단계 제목(예: "① 질문 분석", "③ 인간 감독 — 근거 확정", "⑧ 확장 여부 게이트")' },
        content: { type: 'string', description: '그 단계에서 남길 내용(마크다운). 검색어·찾은 항목·사용자 선택·판정 등 나중에 추적할 수 있을 만큼 구체적으로.' },
      },
    },
  },
  {
    name: 'sep_answer',
    description:
      '**결과물(답변) 파일**을 쓴다 — 과정 기록(sep_log)과 분리된 별도 파일 `answer-<run_id>.md`. ' +
      '⑦에서 SEP 답변이 완성되면 호출하고, 확장 답변(⑬)이 나오면 같은 run_id로 다시 호출해 절을 덧붙인다. ' +
      '로그와 같은 폴더에 나란히 저장되어 한 실행의 산출물이 붙어 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'sep_log가 돌려준 실행 id' },
        question: { type: 'string', description: '사용자 질문(첫 호출에서만 · 제목이 된다)' },
        body: { type: 'string', description: '답변 본문 마크다운 — 모듈 링크·본문·SEP 원문 출처까지 사용자에게 보여준 그대로' },
        section: { type: 'string', description: '절 제목(기본 "SEP 근거 답변", 확장 답변이면 "확장 조사 — 심화 답변" 등)' },
        verdict: { type: 'string', description: '검증관의 판정·총평·남은 미확인 진술' },
      },
      required: ['run_id', 'body'],
    },
  },
  {
    name: 'sep_lexicon',
    description:
      '한국어 철학 용어 → SEP 영어 표제어 사전 조회(개념·철학자·분과 392개 키). ' +
      '**검색어를 만들기 전에 이걸 먼저 호출하라.** 한국어를 영어로 옮기는 일을 매번 즉흥적으로 하면 실행마다 검색어가 달라져 같은 질문에 다른 답이 나온다. ' +
      '사전에 있는 표현을 쓰면 그 변환이 결정적이 된다. 사전에 없는 용어는 `missing`으로 돌려주니 그때만 직접 만들어라.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '조회할 한국어 용어 배열(개념·철학자 이름·분과명 섞어도 된다)' },
      },
      required: ['terms'],
    },
  },
  {
    name: 'sep_search',
    description:
      'SEP 항목 어휘검색. 여러 검색어를 한 번에 OR로 던지고 제목>한국어설명>주제 순 랭킹(동점은 연결도 wdeg)으로 돌려준다. ' +
      'URL 인코딩과 type 풀 필터를 서버가 처리한다. **한국어 검색어는 사전으로 영어 표제어가 자동 보강되며**, 무엇이 어떻게 확장됐는지 `ko_expansions`로 함께 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '검색어 배열. 동의어·유사어를 한꺼번에 넣어라(예: ["free will","determinism","autonomy"]). 여러 번 호출할 필요 없다.' },
        pool: POOL_SCHEMA,
        limit: { type: 'integer', description: '반환 개수(기본 8). 담당 에이전트는 4 정도로 좁혀라.' },
      },
      required: ['terms'],
    },
  },
  {
    name: 'sep_semantic',
    description:
      'SEP 의미검색(pgvector). 질문을 multilingual-e5-small로 임베딩해 코사인 유사도로 찾는다. ' +
      '**한국어 질문을 그대로 넣어도 영어 본문과 매칭된다** — 어휘가 안 겹쳐 sep_search가 0건일 때 이걸 써라. 최초 호출은 모델 로드로 수십 초 걸릴 수 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '자연어 질의. 한국어 원문 질문을 그대로 넣어도 된다.' },
        pool: POOL_SCHEMA,
        limit: { type: 'integer', description: '반환 개수(기본 8)' },
      },
      required: ['q'],
    },
  },
  {
    name: 'sep_excerpt',
    description:
      'DB의 **한국어 요약(ko_desc)** 에서 검색어가 몰린 문장을 뽑는다. 빠르다(네트워크 1회). ' +
      '⚠ 이것은 SEP 영어 원문이 아니라 한국어 요약 서술이므로 "SEP 원문 인용"으로 제시하면 안 된다. 답변의 한국어 서술 근거로만 써라.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'sep_search/sep_semantic이 준 slug' },
        terms: { type: 'array', items: { type: 'string' }, description: '이 문장들에 들어 있길 바라는 용어' },
        n: { type: 'integer', description: '뽑을 문장 수(기본 3)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'sep_source',
    description:
      'SEP 원문 페이지(plato.stanford.edu)를 직접 받아 **영어 verbatim 문장**과 그 구절로 가는 text-fragment 딥링크를 만들어 준다. ' +
      'DB에는 영어 본문이 없으므로(intro 컬럼 전부 비어 있음), 답변에 영어 원문 인용·출처 딥링크를 붙이려면 반드시 이 도구를 써야 한다. 네트워크 요청이라 sep_excerpt보다 느리다.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'sep_search/sep_semantic이 준 slug' },
        terms: { type: 'array', items: { type: 'string' }, description: '찾고 싶은 영어 용어(이 용어가 든 문장을 우선 반환)' },
        n: { type: 'integer', description: '뽑을 문장 수(기본 3)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'sep_evidence_view',
    description:
      '**ORACLE ⑦ 전용** — 확정된 근거 항목들에 대해 COSMOS·CHRONOS·ATLAS 세 관점을 한 번에 만든다. ' +
      '링크만 주면 브라우저를 열어야 하므로 답변 안에서 바로 보이게 하는 것이 목적이다. ' +
      '핵심은 **근거 항목들 사이의 관계**(바깥 이웃 전체가 아니라) — 답변이 어떤 항목들 위에 서 있고 그것들이 어떻게 얽혀 있는지가 드러난다.',
    inputSchema: {
      type: 'object',
      properties: {
        slugs: { type: 'array', items: { type: 'string' }, description: '③에서 확정된 근거 항목의 slug 전부' },
        atlas_topic: { type: 'string', description: 'ATLAS 분포를 볼 대표 토픽 id(대개 대표 개념 항목의 slug). 없으면 ATLAS 절을 생략한다.' },
        neighbor_limit: { type: 'integer', description: '근거 밖 이웃을 몇 개까지 곁들일지(기본 3, 0이면 생략)' },
      },
      required: ['slugs'],
    },
  },
  {
    name: 'sep_atlas',
    description:
      'ATLAS(담론지도) 조회 — 토픽에 속한 인물들을 시대·국적 분포와 함께 돌려준다. `topic`을 비우면 토픽 목록(867개)을 인물 수 순으로 준다. ' +
      '**DB가 아니라 atlas.html의 내장 큐레이션 데이터를 읽으므로 ATLAS 모듈과 결과가 일치한다**(DB의 sep_edges로 계산하면 다른 인물 집합이 나온다).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '토픽 id 또는 라벨(부분일치). 비우면 목록.' },
        limit: { type: 'integer', description: '반환 개수(기본 30)' },
      },
    },
  },
  {
    name: 'sep_neighbors',
    description:
      'COSMOS 관계망(sep_edges 31,001개)에서 이 항목과 연결된 항목을 연결강도순으로 준다. 사람이 쓴 한국어 관계 해설(note)이 함께 온다. ' +
      '근거가 얇을 때 인접 항목으로 넓히거나, 답변에 관계 맥락을 붙일 때 쓴다.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        limit: { type: 'integer', description: '반환 개수(기본 10)' },
      },
      required: ['slug'],
    },
  },
];

TOOLS.push({
  name: 'sep_lesson',
  description:
    '**실행 간 유일한 상태** — 누적 교훈·선호 저장소(`~/.claude/philosophy-oracle/lessons.md`). ' +
    '①에서 `action:"read"`로 읽어 관련된 것을 담당 프롬프트에 넣고, 실행을 마칠 때 `action:"add"`로 남긴다.\n\n' +
    '**두 종류를 절대 섞지 마라 — 이 도구의 존재 이유다:**\n' +
    '- `lesson` = **시스템이 실제로 틀린 것.** 다음 실행에서 반복하지 마라.\n' +
    '- `preference` = **사용자가 의도적으로 내린 범위 결정.** 오류가 아니다. 일관되게 유지하라. ' +
    '사용자가 어떤 후보를 뺐다고 해서 담당이 틀렸다는 뜻은 아니다 — 사용자가 초점을 좁힌 것일 수 있다. ' +
    '그것을 lesson으로 적으면 다음 실행에서 시스템이 사용자 의도를 "고쳐야 할 오류"로 취급하게 된다.\n\n' +
    '같은 key로 다시 add하면 재발 횟수가 오른다. 3회 이상이면 프롬프트로는 안 고쳐진다는 뜻이니 스킬 파일 자체를 고쳐야 한다.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'add', 'remove'], description: "기본 'read'." },
      kind: {
        type: 'string', enum: ['lesson', 'preference'],
        description:
          'add에 필수. **lesson=시스템이 틀린 것 / preference=사용자의 의도적 범위 결정.** ' +
          '판단이 서지 않으면 **아무것도 기록하지 마라** — 억지 분류가 다음 실행을 왜곡한다.',
      },
      key: { type: 'string', description: '짧은 kebab-case 식별자. 같은 key면 재발로 집계된다(예: `summary-drops-caveat`).' },
      scope: { type: 'string', description: '적용 대상 — 에이전트명 또는 단계(예: `oracle-synthesizer`, `sep-discipline`, `③ 근거 확정`, `orchestrator`). 읽을 때 필터로 쓴다.' },
      text: { type: 'string', description: '내용. 다음 실행의 프롬프트에 그대로 넣어도 작동할 만큼 구체적으로.' },
      why: { type: 'string', description: '**왜 lesson/preference로 분류했는지의 근거.** 특히 사용자 선택을 분류할 때 반드시 남겨라 — 나중에 오분류를 되돌릴 수 있어야 한다.' },
      run_id: { type: 'string', description: '이 판정이 나온 실행 id' },
      filter_scope: { type: 'string', description: 'read 전용 — 특정 담당에 해당하는 것만' },
      filter_kind: { type: 'string', enum: ['lesson', 'preference'], description: 'read 전용' },
    },
  },
});

const HANDLERS = {
  sep_log: sepLog,
  sep_lesson: sepLesson,
  sep_answer: sepAnswer,
  sep_lexicon: sepLexicon,
  sep_search: sepSearch,
  sep_semantic: sepSemantic,
  sep_excerpt: sepExcerpt,
  sep_source: sepSource,
  sep_evidence_view: sepEvidenceView,
  sep_atlas: sepAtlas,
  sep_neighbors: sepNeighbors,
};

// ── JSON-RPC over stdio ────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER,
        });

      case 'notifications/initialized':
      case 'initialized':
        return; // 알림 — 응답 없음

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: TOOLS });

      case 'tools/call': {
        const fn = HANDLERS[params?.name];
        if (!fn) return fail(id, -32602, `알 수 없는 도구: ${params?.name}`);
        try {
          const result = await fn(params.arguments || {});
          return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          // 도구 실행 실패는 프로토콜 오류가 아니라 isError 결과로 돌려준다(모델이 읽고 대응하게)
          return ok(id, { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true });
        }
      }

      default:
        if (isNotification) return;
        return fail(id, -32601, `지원하지 않는 메서드: ${method}`);
    }
  } catch (e) {
    log('handler error', e);
    if (!isNotification) fail(id, -32603, e.message);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); }
  catch { return log('JSON 파싱 실패:', s.slice(0, 200)); }
  handle(msg);
});

process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));
log(`SEP MCP 준비 — 자립형(동봉 데이터 ${DATA_DIR})`);
