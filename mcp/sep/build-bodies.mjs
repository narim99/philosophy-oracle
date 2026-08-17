#!/usr/bin/env node
/**
 * SEP 영어 본문을 플러그인 데이터로 굽는다.
 *
 *   node build-bodies.mjs <웹앱 data 폴더>
 *   예) node build-bodies.mjs ../../../../sep_chatbot/data
 *
 * 왜 필요한가: 플러그인 데이터는 Supabase 테이블에서 떠 왔는데 그 테이블에는
 * 본문 컬럼이 없었다(slug·title·url·type·ko_desc·topics·embedding뿐). 그래서
 * 어휘검색이 제목·한국어 설명·topics에만 걸렸고, **본문에만 나오는 말로는
 * 항목을 찾지 못했다.** 웹앱 쪽에는 영어 전문이 샤드로 있으므로 그것을 굽는다.
 *
 * 저장 방식 — 통짜 JSON을 쓰지 않는다:
 *   bodies.bin      항목별로 따로 deflate한 블록을 이어 붙인 것
 *   bodies.idx.json { slug: [오프셋, 압축길이, 원문길이] }
 * 이렇게 하면 한 항목을 읽을 때 **그 블록만** 풀면 된다. 153MB를 통째로
 * 메모리에 올리지 않는다. 검색은 별도로 term index를 쓴다(아래).
 *
 *   terms.bin       항목별 고유 단어 집합(소문자, 3자 이상)을 deflate
 *   terms.idx.json  { slug: [오프셋, 압축길이] }
 * 본문 전체를 풀지 않고 단어 집합만 풀어 후보를 좁힌 뒤, 살아남은 항목의
 * 본문만 풀어 문맥을 뽑는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const SRC = process.argv[2];

if (!SRC || !fs.existsSync(SRC)) {
  console.error('웹앱 data 폴더 경로를 줘라.  예) node build-bodies.mjs ../../../../sep_chatbot/data');
  process.exit(1);
}

const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();

// ── 웹앱 인덱스 읽기 ───────────────────────────────────
globalThis.window = {};
new Function(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'))();
const webIndex = globalThis.window.__SEP_INDEX__;
if (!Array.isArray(webIndex)) throw new Error('index.js에서 __SEP_INDEX__를 못 읽었다.');
console.log(`웹앱 인덱스: ${webIndex.length}건`);

// url → 샤드 번호(=배열 위치). 샤드 파일명이 e<위치>.js 이다.
const byUrl = new Map();
webIndex.forEach((e, i) => byUrl.set(norm(e.u), { i, meta: e }));

// ── 플러그인 항목 ──────────────────────────────────────
const entries = JSON.parse(fs.readFileSync(path.join(DATA, 'entries.json'), 'utf8'));
console.log(`플러그인 항목: ${entries.length}건`);

// ── 굽기 ───────────────────────────────────────────────
const bodyBlocks = [];
const termBlocks = [];
const bodyIdx = {};
const termIdx = {};
let bodyOff = 0;
let termOff = 0;
let hit = 0;
let miss = [];
let rawTotal = 0;

const STOP = new Set(('the of and to in a is that it for as with on are be this by an or not from which can we they '
  + 'if but has have had was were will would there their what when who how all any some more most such no nor only '
  + 'own same so than too very one two also may might must should could into out up down over under again further '
  + 'then once here both each few other its it\'s them these those you your our his her he she him').split(' '));

for (const e of entries) {
  const found = byUrl.get(norm(e.url));
  if (!found) { miss.push(e.slug); continue; }

  let shard;
  try {
    shard = fs.readFileSync(path.join(SRC, `e${found.i}.js`), 'utf8');
  } catch { miss.push(e.slug); continue; }

  let payload = null;
  globalThis.__SEP_LOAD__ = (_id, o) => { payload = o; };
  try { new Function(shard)(); } catch { miss.push(e.slug); continue; }
  if (!payload) { miss.push(e.slug); continue; }

  // 본문 = 서론 + 각 절(제목 포함). 절 제목을 남겨야 인용 위치를 말할 수 있다.
  const parts = [];
  if (payload.intro) parts.push(payload.intro);
  for (const s of payload.secs || []) {
    if (s.h) parts.push(`\n\n## ${s.h}\n`);
    if (s.x) parts.push(s.x);
  }
  const text = parts.join('\n').trim();
  if (!text) { miss.push(e.slug); continue; }

  rawTotal += text.length;

  const packed = zlib.deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 });
  bodyBlocks.push(packed);
  bodyIdx[e.slug] = [bodyOff, packed.length, text.length];
  bodyOff += packed.length;

  // 검색용 단어 집합 — 소문자 3자 이상, 불용어 제외
  const terms = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) {
    if (!STOP.has(w)) terms.add(w);
  }
  const tp = zlib.deflateRawSync(Buffer.from([...terms].join(' '), 'utf8'), { level: 9 });
  termBlocks.push(tp);
  termIdx[e.slug] = [termOff, tp.length];
  termOff += tp.length;

  hit++;
  if (hit % 200 === 0) process.stdout.write(`\r  구운 항목 ${hit}건…`);
}
console.log(`\r  구운 항목 ${hit}건       `);

fs.writeFileSync(path.join(DATA, 'bodies.bin'), Buffer.concat(bodyBlocks));
fs.writeFileSync(path.join(DATA, 'bodies.idx.json'), JSON.stringify(bodyIdx));
fs.writeFileSync(path.join(DATA, 'terms.bin'), Buffer.concat(termBlocks));
fs.writeFileSync(path.join(DATA, 'terms.idx.json'), JSON.stringify(termIdx));

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('');
console.log('── 결과 ──');
console.log(`  본문 있는 항목   ${hit} / ${entries.length}`);
console.log(`  본문 없는 항목   ${miss.length}${miss.length ? '  예) ' + miss.slice(0, 5).join(', ') : ''}`);
console.log(`  원문 총량        ${mb(rawTotal)}`);
console.log(`  bodies.bin       ${mb(bodyOff)}`);
console.log(`  terms.bin        ${mb(termOff)}`);
console.log(`  색인 두 개       ${mb(JSON.stringify(bodyIdx).length + JSON.stringify(termIdx).length)}`);
