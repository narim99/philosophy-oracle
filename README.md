# PHILOSOPHY · ORACLE — Claude Code 플러그인

브라우저 웹앱 `sep_chatbot/oracle.html`의 오라클 파이프라인을 **Claude Code 플러그인**으로 재구현한 것. SEP(스탠퍼드 철학 백과)를 근거로 철학 질문에 답한다.

## 파이프라인

**SEP 근거 답변 (①~⑦)** — `/oracle <질문>` →
① 질문 분석(`oracle-analyst`) → ② 팀 조사(`sep-scholar`·`sep-keyword`·`sep-discipline` 병렬) → ③ **인간 감독**(`AskUserQuestion`으로 문서 확인/제외/재검색) → ④ 문서분석·토론 + ⑤ 답변작성(`oracle-synthesizer` 1회 호출) → ⑥ 검증(`oracle-verifier`, 부분통과면 재작성 1회 루프) → ⑦ **COSMOS·CHRONOS·ATLAS 세 관점을 답변 안에 렌더링**(`sep_evidence_view`) + SEP 원문 출처.

> 에이전트 간 왕복(③ 재검색, ⑥ 재작성)은 **`/oracle` 오케스트레이터가 재호출로 돌린다** — 서브에이전트는 서로를 호출할 수 없다.

**⑧ 확장 경로 게이트 (분기점 · 항상 거친다)** — ⑦ 답변 직후, 오케스트레이터가 **세 경로별 후보**를 번호 매겨 제시하고 `AskUserQuestion` **2문항**(경로 복수선택 + 항목 번호 지정)으로 한 번에 받는다. 종료도 정상 종료다.

| 경로 | 하는 일 | 담당 팀 |
|---|---|---|
| **A 간극 파고들기** | ⑦이 미결로 남긴 구멍을 더 깊이 판다 | `gap-investigator` |
| **B 철학 내 타 분과** | 같은 문제를 다른 철학 분과의 눈으로 본다 | `philosophy-scout` |
| **C 철학 외 분과** | 그 주장이 경험적으로 검사되는 지점을 찾는다 | `external-scout` |

**확장 조사 (⑨~⑬)** — ⑨ **선택 항목 하나당 전담 에이전트 하나를 병렬 투입** → ⑩ 세 팀 보고를 통합 표로 합쳐 확정 → ⑩-b 확정 논문마다 `paper-reader`가 **본문까지 병렬 정독** → ⑪⑫ 심화 작성(⑦이 남긴 간극을 메우는 방향) → ⑬ 검증. 여러 경로를 **동시에** 고를 수 있다.

**위치 찾기 (발췌)** — `/locate <내용>` → 답변을 새로 쓰지 않고, 자연어(애매·구어체)로 물은 내용이 **SEP 어느 문서·어느 단락**에 있는지 찾아(WebFetch로 원문 단락까지) 한국어 번역 + SEP 딥링크 + 3모듈 리다이렉션으로 보여준다. SEP에 없으면 "찾을 수 없습니다". 파이프라인 앞단(①②)만 수행.

## 트리거 문장 — 이렇게 부른다

커맨드는 **`/sep:oracle`** 과 **`/sep:locate`** 둘뿐이다.

### 기본형 — 판정·비교·해석을 요구하는 질문일수록 파이프라인이 제 값을 한다

```
/sep:oracle 토마스 쿤의 공약불가능성 논제는 실재론인가?
/sep:oracle 칸트의 정언명법과 공리주의는 무엇이 다른가?
/sep:oracle 자유의지와 결정론은 양립할 수 있는가?
/sep:oracle 흄의 인과 회의주의가 과학에 남긴 문제는 무엇인가?
```

### 질문 유형별로 잘 듣는 형태

Agent 1이 질문 유형을 분류해 검색 초점을 바꾸므로, 형태를 맞춰주면 정확도가 오른다.

| 유형 | 트리거 문장 예 |
|---|---|
| 정의형 | `/sep:oracle 지향성이란 무엇인가?` |
| 입장귀속형 | `/sep:oracle 비트겐슈타인은 사적 언어를 왜 부정했나?` |
| 분류·판정형 | `/sep:oracle 구조주의는 반실재론인가?` |
| 비교형 | `/sep:oracle 롤스의 정의론과 노직의 소유권론은 어디서 갈라지나?` |
| 인과·근거형 | `/sep:oracle 왜 게티어 문제가 지식 삼분석을 무너뜨렸나?` |
| 평가형 | `/sep:oracle 악의 문제에 대한 신정론은 성공적인가?` |

### 확장까지 갈 질문

⑧ 확장 게이트는 **항상** 뜨지만, SEP만으로 안 끝나는 질문이 확장의 값을 본다. 확장하면 논문마다 정독가가 붙어 본문까지 읽는다.

```
/sep:oracle 확장된 마음 논제는 인지과학의 경험적 증거로 뒷받침되나?
/sep:oracle 도덕적 책임 개념은 신경과학의 자유의지 실험에 의해 훼손되는가?
```

### 위치 찾기 — 답을 새로 쓰지 않고 원문 위치만 짚는다

애매하게 물어도 된다. 구어체·불완전한 기억이 오히려 이 커맨드의 용도다.

```
/sep:locate 칸트가 말한 그 명령 같은 거, 무조건 따라야 한다는 원칙 뭐였지?
/sep:locate 통 속의 뇌 논증 원문
```

### 잘 안 맞는 질문

- **단일 사실 조회**(`칸트 생몰년?`) — 13단계를 태울 값이 없다. 그냥 물어보는 편이 빠르다.
- **SEP 범위 밖**(`한국 성리학의 이기론`) — ②에서 0건이 나오고 ⑧ 확장으로 넘어가야 한다. 이때는 "SEP에서 찾을 수 없습니다"가 정상 응답이다.
- **최신 시사**(`올해 나온 AI 윤리 지침`) — SEP은 백과사전이라 시의성 있는 자료가 없다.

## 구성

```
sep/
  .claude-plugin/plugin.json   매니페스트
  commands/oracle.md           /oracle — ①~⑬ 단일 파이프라인 오케스트레이션
  commands/locate.md           /locate — SEP 위치 찾기(발췌 전용)
  agents/                      10개 서브에이전트(Agent 1·SEP팀3·Agent2/3·Agent4·정독가·확장팀3)
  skills/sep-retrieval/        SEP MCP 사용 규칙 + 리다이렉션 URL 규칙
  mcp/sep/                     자체 SEP MCP 서버(server.mjs·run.sh)
  mcp/sep/data/                동봉 SEP 데이터 — 외부 DB 불필요
  mcp/sep/refresh.mjs          DB를 고쳤을 때 데이터 갱신
  .mcp.json                    MCP 선언 3개(sep·scientific-papers·academix)
```

## 설치

이 저장소 루트가 곧 로컬 마켓플레이스다(`.claude-plugin/marketplace.json`).

```bash
claude plugin marketplace add "/Users/hwangmiran/Philosophical Work"
claude plugin install sep@sep-local
```

설치본은 `~/.claude/plugins/cache/sep-local/sep/<version>/`에 **복사**된다. 따라서 이 폴더의 파일을 고쳐도 **자동 반영되지 않는다** — 고친 뒤 아래를 돌리고 세션을 재시작하라.

```bash
claude plugin marketplace update sep-local
claude plugin update sep@sep-local
```

> `update`는 **`plugin@marketplace` 전체 id**를 요구한다. 이름만 주면 `Plugin "sep" not found`로 실패한다. 또 `plugin.json`의 `version`을 올리지 않으면 업데이트가 잡히지 않으니, 내용을 고칠 때 버전도 함께 올려라.
>
> 단, **MCP 서버는 예외로 보인다.** `claude mcp list`에서 `plugin:sep:sep`의 실행 경로가 캐시가 아니라 **소스 디렉터리**(`plugins/sep/mcp/sep/run.sh`)로 잡혔다(2026-08-15 확인). `server.mjs`만 고칠 때는 버전을 올리지 않아도 재시작만으로 반영될 수 있다. 커맨드·에이전트·스킬은 캐시 복사본을 쓰므로 위 절차가 필요하다.

개발 중 빠르게 돌려보려면 설치 없이:

```bash
claude --plugin-dir ./plugins/sep
```

설치되면:
- `/mcp` → 번들 MCP 3종이 `mcp__plugin_sep_<서버>__*`로 노출(플러그인 스코핑). **플러그인 미설치/비활성 시 노출되지 않는다.**
- `/oracle <질문>` → ①~⑦ 실행 후 SEP 답변을 내고, ⑧에서 확장 여부를 묻는다. 감독 질문은 ③(근거 확정)·⑧(확장 여부·분야)·⑩(외부 자료 확정) 세 번.
- 커맨드는 플러그인 이름공간으로 등록된다 — 맨 `/oracle`이 아니라 **`/sep:oracle`**.
- 모듈 뷰는 `/oracle` ⑦에 통합돼 있다. 독립 조회 커맨드는 없다.

## SEP MCP (자체 제작 · ①~⑦의 주력 도구)

`mcp/sep/`의 서버가 SEP 검색·발췌·관계·모듈뷰를 담당한다. **데이터를 동봉하고 있어 외부 의존이 없다**(→ 「SEP 데이터」).

| 도구 | 하는 일 |
|---|---|
| `sep_log` | **과정 기록** — 단계마다 호출, 사용자 홈에 누적 |
| `sep_answer` | **결과물 파일** — 답변만 담긴 `answer-<id>.md` |
| `sep_lexicon` | **한→영 SEP 표제어 사전**(392키) 조회 — 검색어 만들기 전에 |
| `sep_search` | 동의어 여러 개를 한 번에 OR 검색 + 표제어 근접도 랭킹 |
| `sep_semantic` | 임베딩 의미검색 — **한국어 질문이 영어 항목과 매칭된다** |
| `sep_excerpt` | DB 한국어 요약(ko_desc)에서 문장 발췌 |
| `sep_source` | **SEP 원문 페이지에서 영어 verbatim + text-fragment 딥링크** |
| `sep_neighbors` | 관계망 이웃 + 사람이 쓴 한국어 관계 해설 |
| `sep_evidence_view` | **/oracle ⑦ 전용** — 근거 항목들의 관계·연대·담론 분포를 한 번에 |
| `sep_atlas` | 토픽별 인물·시대·지역 분포 (867토픽 큐레이션본) |
| `sep_lesson` | **누적 교훈·선호** — ①에서 읽고 ⑭에서 쓴다. 실행 간에 이어지는 유일한 상태 |

**의존성 설계** — 어휘검색·발췌·관계·링크는 **의존성 0**(Node 내장 fetch)으로 동작한다. 의미검색만 `@xenova/transformers`가 필요하며, `run.sh`가 최초 실행 시 `~/.claude/philosophy-oracle/mcp-sep/`에 설치하고 심볼릭 링크를 건다(플러그인 버전이 올라가도 재설치하지 않는다). 설치가 실패해도 `sep_semantic`만 비활성이고 나머지는 정상이다.

### 알아 둘 데이터 한계

- **SEP 영어 본문은 데이터에 없다.** 원본 DB의 `intro` 컬럼이 1,719행 전부 비어 있어 동봉에서도 제외했다. 그래서 영어 verbatim 인용과 딥링크는 `sep_source`가 SEP 페이지를 실시간으로 받아 만든다. **`sep_excerpt`가 주는 것은 한국어 요약이며 원문 인용이 아니다** — 이것을 "SEP 원문"으로 제시하면 거짓 인용이 된다.
- **`wdeg`(연결도)는 인물 484행에만 있다.** 키워드·분과 풀에서는 항상 비어 있으므로 주 정렬 기준이 될 수 없다. `sep_evidence_view`의 허브도 이 때문에 전역 연결도가 아니라 **근거 집합 내부 연결도**로 고른다.

## 확장 조사용 번들 MCP (플러그인 전용)

`.mcp.json`에 선언된 MCP는 **이 플러그인이 설치됐을 때만** 활성화된다(전역 설치 아님). 둘 다 **⑨ 이후** Discovery에서 SEP 외 논문 조사에 쓴다. **①~⑦은 SEP-only**라 이 둘을 쓰지 않는다(`sep` MCP는 예외 — 그것이 SEP 접근 수단이다).

| MCP | 실행 | 커버리지 | 전제 |
|---|---|---|---|
| **scientific-papers** | `npx -y @futurelab-studio/latest-science-mcp` (무설정) | arXiv·OpenAlex·PMC·Europe PMC·bioRxiv·CORE | Node(`npx`) |
| **academix** | `uvx --python 3.12 --with "mcp<2" --from git+…/Academix.git academix` | OpenAlex·Semantic Scholar·CrossRef·DBLP·arXiv 통합 | **`uv`(uvx)** |

- 둘 다 **첫 실행 시 자동 다운로드**된다(npx `-y` / uvx). 사전 설치 불필요하나, 각각 **Node와 uv**가 PATH에 있어야 한다.
- **uv 설치(이 머신에서 쓴 방법, 2026-08-15)** — Homebrew가 없어 PyPI로 설치하고 이미 PATH에 있는 `~/.local/bin`에 링크했다(셸 설정 수정 없음):
  ```bash
  pip3 install --user uv && ln -sf ~/Library/Python/3.9/bin/uv ~/.local/bin/uv && ln -sf ~/Library/Python/3.9/bin/uvx ~/.local/bin/uvx
  ```
  공식 설치 스크립트(`curl -LsSf https://astral.sh/uv/install.sh | sh`)도 가능하다.
- **academix에 `--python 3.12 --with "mcp<2"`가 붙은 이유** — academix는 `mcp.server.fastmcp`(MCP Python SDK 1.x)를 import하는데, 고정 없이 두면 uv가 **mcp 2.0.0**을 해석해 온다. 2.x에서 `fastmcp`가 `mcpserver`로 개편돼 `ModuleNotFoundError`로 서버가 즉사한다(`Connection closed`로 보인다). 상류가 SDK 2.x를 지원하면 이 고정을 풀어도 된다.
- **academix 환경변수**(선택): `.mcp.json`의 `env.ACADEMIX_EMAIL`을 채우면 OpenAlex polite pool(더 높은 rate limit)을 쓴다. `SEMANTIC_SCHOLAR_API_KEY`는 있으면 Semantic Scholar 추천 품질↑. 비워 둬도 익명으로 동작한다(rate 낮음).
- academix는 PyPI에 없고 GitHub 저장소로 배포되므로 `uvx --from git+…`로 그 저장소에서 직접 설치·실행한다(정식 `[project.scripts] academix` 엔트리포인트, hatchling·requires-python≥3.11).

## 산출물과 실행 로그

한 번 실행하면 파일 두 개가 나란히 남는다. MCP 도구가 쓰므로 프롬프트가 잊어도 경로·시각은 서버가 찍는다.

```
~/.claude/philosophy-oracle/logs/
  answer-<YYYYMMDD-HHMMSS>.md   ← 결과물: 답변·근거·출처만 (sep_answer)
  oracle-<YYYYMMDD-HHMMSS>.md   ← 과정 기록: 검색어·폐기 후보·게이트 선택 (sep_log)
```

둘을 나눈 이유는 과정 기록에 "왜 이 근거가 선택됐는지"를 남겨야 해서 검색어·폐기 내역이 섞이는데, 답변만 필요할 때 그 속에서 캐내기 불편하기 때문이다. 확장 조사까지 가면 심화 답변이 같은 결과물 파일에 절로 덧붙는다.


**왜 저장소가 아니라 홈인가** — 로그는 **사용자별 개인 기록**이다. 저장소는 공유·커밋되므로 여러 사람이 쓰면 서로의 기록이 섞이고, 플러그인 캐시(`~/.claude/plugins/cache/...`)는 버전을 올릴 때마다 새 폴더로 갈아치워져 기록이 사라진다. 홈 아래에 두면 각자 자기 것만 쌓이고 버전 업데이트에도 살아남는다(의미검색 의존성도 같은 경로를 쓴다).

프로젝트 안에 두고 싶으면 `.mcp.json`의 `sep` 서버에 환경변수를 주면 된다:

```json
"env": { "ORACLE_LOG_DIR": "${CLAUDE_PLUGIN_ROOT}/../../logs/oracle" }
```

기록되는 것: 질문 → Agent 1의 분석·모호성·검색어 → 담당별 검색 결과와 **폐기한 후보·이유** → 감독 게이트에서 **사용자가 고른 것** → 답변 전문 → 검증 판정·재작성 루프 횟수 → 확장 여부 선택 → (확장 시) 외부 자료·심화 답변. "왜 이 근거가 선택됐는지"를 나중에 추적하는 것이 목적이다.

## SEP 데이터 — 플러그인에 동봉돼 있다

**외부 DB도 API 키도 필요 없다.** 데이터는 `mcp/sep/data/` 안에 있고, 설치하면 그대로 돈다.

| 파일 | 내용 | 크기 |
|---|---|---|
| `entries.json` | SEP 항목 1,719건 (제목·url·type·한국어 요약·토픽·생몰·시대·국적·분야·연결도) | 0.4 MB |
| `embeddings.bin` | 항목별 384차원 임베딩, float32 바이너리 (`entries.json`과 같은 순서) | 2.5 MB |
| `edges.json` | 항목 간 관계 31,001건 + **사람이 쓴 한국어 관계 해설** | 5.0 MB |
| `atlas.json` | ATLAS 큐레이션 토픽 867개와 토픽별 인물 | 0.7 MB |

담당별 풀 = `type`:

| type | 건수 | 담당 |
|---|---|---|
| `person` | 484 | `sep-scholar` |
| `keyword` | 931 | `sep-keyword` |
| `discipline` | 304 | `sep-discipline` |

**네트워크를 쓰는 곳은 `sep_source` 하나뿐이다** — SEP 영어 원문과 딥링크가 필요할 때 `plato.stanford.edu`를 직접 받아온다(확장 조사의 학술 MCP는 별개다).

### 왜 원격 DB를 쓰지 않는가

처음에는 Supabase PostgREST를 호출했다. 자립형으로 옮기면서 세 가지가 함께 해결됐다.

- **키가 필요 없어졌다.** 공개 저장소에 자격증명을 올릴 일이 없다.
- **검색이 정확해졌다.** 원격 시절에는 후보를 서버에서 잘라 온 뒤 랭킹했다. 지금은 1,719건 전체를 훑고 랭킹하므로 누락이 없다(실측: `자유의지·결정론` 질의에서 `Causal Determinism`·`Ancient Theories of Freedom and Determinism`이 원격에서는 후보에 들지 못했다).
- **한글 인코딩 함정이 사라졌다.** PostgREST `or=(...)`에 한글을 인코딩 없이 넣으면 에러 없이 빈 배열이 오던 문제가 로컬 필터에서는 존재하지 않는다.

동점 정렬은 slug로 끊어 **같은 질의가 항상 같은 순서**를 낸다.

### 월 1회 정기 갱신 — 이것 하나면 된다

```bash
bash update.sh
```

받아오고 · 커밋하고 · GitHub에 올리고 · 설치본까지 맞춘다. 달라진 게 없으면 커밋을 건너뛴다.
확인만 하려면 `bash update.sh --check`.

### 나눠서 하고 싶으면 — 데이터만 갱신

동봉 데이터는 **받아온 시점에 굳어 있다.** Supabase에서 항목을 추가하거나 설명을 고쳤다면 다시 받아와야 플러그인이 안다.

```bash
node mcp/sep/refresh.mjs
```

이 한 줄이면 끝난다. 무엇이 달라졌는지(새로 생긴 항목·없어진 항목·수정된 항목) 먼저 알려주고 갱신한다.

받아만 보고 확인하려면:

```bash
node mcp/sep/refresh.mjs --check
```

**접속 정보는 저장소에 두지 않는다.** 홈 폴더에 한 번만 만들어 두면 다음부터는 그냥 실행하면 된다.

```bash
mkdir -p ~/.claude/philosophy-oracle
echo '{"url":"https://<프로젝트>.supabase.co","key":"<키>"}' > ~/.claude/philosophy-oracle/supabase.json
chmod 600 ~/.claude/philosophy-oracle/supabase.json
```

(환경변수 `SEP_SUPABASE_URL`·`SEP_SUPABASE_KEY`로 줘도 된다.)

알아 둘 것:

- **갱신 후 Claude Code를 재시작해야** 새 데이터를 읽는다.
- 새 파일을 다 쓴 뒤 마지막에 한꺼번에 바꿔치기하므로, **중간에 실패해도 기존 데이터는 그대로** 남는다.
- **`atlas.json`은 건드리지 않는다** — DB가 아니라 `sep_analysis/atlas.html`의 큐레이션본에서 온 것이다. ATLAS를 고쳤다면 그건 따로 다시 뽑아야 한다.
- 갱신한 데이터를 저장소에도 반영하려면 평소처럼 `git add -A && git commit && git push`.

한→영 사전은 `mcp/sep/build_lexicon.mjs`가 따로 만든다.
