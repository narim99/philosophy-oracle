---
name: sep-retrieval
description: SEP(스탠퍼드 철학 백과) 항목을 번들 SEP MCP로 검색·발췌하고, 답변에 붙일 리다이렉션 URL(cosmos·chronos·atlas)과 SEP 원문 딥링크를 생성하는 규칙. 오라클 파이프라인의 학자·키워드·분과 에이전트와 답변 작성 단계가 사용한다.
---

# SEP Retrieval — 번들 SEP MCP

SEP 데이터(1,719개 항목·31,001개 관계)는 Supabase에 있고, 브라우저 오라클과 **같은 DB**를 쓴다(데이터 중복 없음).
접근은 **플러그인에 번들된 `sep` MCP 서버**로 한다 — 인코딩·풀 필터·verbatim 보장을 서버가 처리하므로 curl로 직접 치지 마라.

도구 이름은 호스트가 `mcp__plugin_sep_sep__sep_search` 처럼 네임스페이싱한다.
**이름 전체를 외우지 말고 `sep_log`·`sep_answer`·`sep_lexicon`·`sep_search`·`sep_semantic`·`sep_excerpt`·`sep_source`·`sep_evidence_view`·`sep_atlas`·`sep_neighbors`가 들어간 도구를 찾아 쓰라.**

## 도구 10개

| 도구 | 쓰임 | 비고 |
|---|---|---|
| `sep_log` | **과정 기록** — 단계마다 호출 | 홈 아래에 쌓인다(저장소 무관) |
| `sep_answer` | **결과물 파일** — 답변만 담긴 `answer-<id>.md` | ⑦·⑬에서 호출 |
| `sep_lexicon` | **한→영 표제어 사전 조회**(키 392개) | Agent 1이 검색어 만들기 **전에** 호출 |
| `sep_search` | **어휘검색**. 동의어 여러 개를 `terms` 배열로 한 번에 던진다 | 풀 필터·인코딩·**한국어 자동확장**을 서버가 처리 |
| `sep_semantic` | **의미검색**. 한국어 질문을 그대로 넣어도 영어 항목과 매칭 | 첫 호출만 모델 로드로 느림 |
| `sep_excerpt` | DB의 **한국어 요약**(ko_desc)에서 문장 발췌 | 빠름. **영어 원문이 아니다** |
| `sep_source` | **SEP 원문 페이지에서 영어 verbatim 문장 + 딥링크** | 네트워크 요청이라 느림 |
| `sep_neighbors` | 관계망(31,001개) 이웃 + 한국어 관계 해설 | 근거 확장용 |
| `sep_evidence_view` | **⑦ 전용** — 근거 항목들에 대한 COSMOS·CHRONOS·ATLAS 3관점 | 근거 **사이의** 관계가 핵심 |
| `sep_atlas` | 토픽별 인물·시대·지역 분포 | **atlas.html 큐레이션본**을 읽는다 |

`pool` 값은 담당별 풀이다 — `person`(484) · `keyword`(931) · `discipline`(304) · `all`(1,719).
**`topic`·`person-topic` 같은 type은 DB에 없다.**

### ⚠ 풀 배정은 직관과 다르다

`discipline`은 학문 분과만 담고 있지 않다. **주요 -ism과 입장이 여기 들어 있다**(2026-08-15 실측):

| 개념 | 실제 풀 |
|---|---|
| `Realism` · `Scientific Realism` · `Structural Realism` · `Moral Realism` | **discipline** |
| `Epistemology` · `Physicalism` | **discipline** |
| `Free Will` · `Consciousness` | keyword |

또 `Causation`·`Utilitarianism`·`Nominalism`·`Determinism`은 **그 제목의 항목이 아예 없다**(다른 제목 아래 다뤄진다).

따라서 **자기 풀에서 결과가 빈약하면(3건 미만) `pool: "all"`로 한 번 더 확인하라.** 다른 풀에 있는 항목을 발견하면 그 사실을 밝혀 보고한다 — 담당이 아니어서 버리면 근거가 통째로 사라진다.

```
sep_search  { terms: ["free will","determinism","autonomy"], pool: "keyword", limit: 4 }
sep_semantic{ q: "칸트는 자유의지를 어떻게 옹호했는가", pool: "person", limit: 4 }
sep_source  { slug: "kant", terms: ["autonomy","moral law"], n: 3 }
```

## 한국어 → 영어 표제어 일치성

주 이용자는 한국어로 묻는데 SEP 표제어는 영어다. 이 변환을 **매번 즉흥적으로 하면 같은 질문이 실행마다 다른 검색어를 낳는다** — 이 파이프라인의 최대 재현성 문제다. 그래서 사전을 코드에 심었다.

- **`sep_lexicon { terms: [한국어 용어들] }`** — 개념 245 · 철학자 121 · 분과 26(총 392키). 브라우저 COSMOS/ORACLE이 쓰는 사전 3종에 SEP 표제어를 겨냥한 보강분을 합쳤다. 앱과 플러그인이 같은 어휘를 쓴다.
- 반환의 **`canonical`(대표 영어어)을 그대로 쓰라.** 임의로 다르게 번역하지 마라.
- `missing`으로 온 것만 직접 만들되, 확신이 없으면 `sep_semantic`으로 실제 표제어를 확인하고 **그 제목을 검색어로** 삼아라.
- **`sep_search`는 한국어를 자동 보강한다** — 한국어 용어를 그대로 넣어도 사전 영어어가 더해지고, 무엇이 어떻게 확장됐는지 `ko_expansions`로, 사전에 없던 것은 `unmapped_korean`으로 돌려준다.

```
sep_lexicon { terms: ["공약불가능성","실재론","쿤"] }
→ 공약불가능성 → incommensurability (+Kuhn, scientific revolutions)
   실재론      → realism (+scientific realism, moral realism)   ← 다의어: 문맥으로 고를 것
   쿤          → Kuhn
```

한국어 어휘검색만으로는 recall이 낮다(`ko_desc`는 짧은 요약이라 "공약불가능성"은 1,719개 중 1건, "정언명법"은 0건에만 걸린다). **영어 표제어 변환이 사실상 검색의 전부**라고 보면 된다.

**다의어 주의** — 사전이 여러 영어어를 주는 경우는 뜻이 갈리는 것이다. 문맥으로 고르고, 못 고르면 둘 다 넣어라: 실재론(scientific/moral/universals), 관념(idea/notion), 정신(mind/spirit), 이념(idea/ideology), 반성(reflection), 지향성(intentionality ≠ intention).

## 검색 전략

0. **`sep_lexicon` 먼저**(Agent 1) — 한국어를 사전 표현으로 고정한 뒤 검색어를 만든다.
1. **`sep_search`** — Agent 1이 준 영어 용어를 **한 배열에 모두** 넣어 1회 호출한다(용어마다 따로 호출하지 마라).
2. **0건이거나 빈약하면 `sep_semantic`** — 어휘가 안 겹치는 경우가 진짜 병목이다. 한국어 원 질문을 그대로 넣어라.
3. 후보가 정해지면 근거 문장을 받는다 — **답변에 영어 원문을 인용하거나 출처 딥링크를 붙일 거면 `sep_source`**, 한국어 서술 근거만 필요하면 `sep_excerpt`.

## ⚠ 근거 인용에서 반드시 지킬 것

**DB에는 SEP 영어 본문이 없다.** `sep_entries.intro`는 1,719행 전부 비어 있고, 채워진 본문은 `ko_desc`(한국어 요약 서술)뿐이다.

- `sep_excerpt`가 주는 text는 **한국어 요약**이다. 이것을 "SEP 원문 인용"이라고 제시하면 **거짓 인용**이 된다.
- **영어 verbatim 인용과 `#:~:text=` 딥링크는 `sep_source`로만** 만들 수 있다(SEP 페이지를 실시간으로 받아 온다).
- 어느 쪽이든 도구가 돌려준 `text`를 **그대로** 쓰라. 손으로 옮겨 적으며 다듬지 마라.

## SEP 원문 출처 링크

`sep_source`가 발췌마다 `#:~:text=` 딥링크를 만들어 준다. **그 도구가 준 것만 유효하다** — 직접 조립하거나 지어내지 마라.

## MCP를 못 쓸 때

`sep` MCP 도구가 보이지 않으면(플러그인 비활성 등) **대체 경로는 없다.** SEP 데이터는 플러그인에 동봉돼 있고(`mcp/sep/data/`) 외부 API가 아니므로, curl로 대신 칠 곳이 없다. 도구가 안 보이면 플러그인 설치 상태를 확인하라.

`sep_source`만은 예외로 `plato.stanford.edu`를 직접 받아오므로, 정 급하면 `WebFetch`로 SEP 페이지를 직접 읽을 수 있다. 다만 딥링크 생성과 문장 랭킹은 직접 해야 한다.

## 확장 조사(⑨~⑬) Discovery — 학술 MCP

확장 조사 단계는 함께 번들된 `scientific-papers`(arXiv·OpenAlex·PMC·CORE 등)와 `academix`(OpenAlex·Semantic Scholar·CrossRef·DBLP·arXiv 통합)로 SEP 밖 논문을 조사한다. **①~⑦은 SEP-only라 이 둘을 쓰지 않는다**(`sep` MCP는 SEP 접근 수단이므로 예외). 확장 진입은 ⑧ 인간 감독 게이트가 결정한다.
