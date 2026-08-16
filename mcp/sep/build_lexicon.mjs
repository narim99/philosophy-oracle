#!/usr/bin/env node
/**
 * lexicon.json 생성기 — 한국어 철학 용어 → SEP 영어 표제어 사전
 *
 * 두 출처를 합친다.
 *   ① sep_analysis/cosmos.html 의 검증된 사전 3종(KO_EN·PHIL_KO·DISC_KO)
 *      — 브라우저 COSMOS/ORACLE 검색이 실제로 쓰고 있는 것. 앱과 플러그인의 어휘를 일치시킨다.
 *   ② 아래 ADDITIONS — SEP 표제어를 겨냥해 보강한 항목.
 *      선정 기준: (a) ko_desc 히트가 0~2건이라 한국어 어휘검색으로는 못 찾는 개념,
 *                (b) SEP에 독립 항목이 있는 개념, (c) 한국어 다의어라 오역 위험이 큰 것.
 *
 * 실행: node build_lexicon.mjs   (플러그인 폴더 기준 상대경로로 cosmos.html을 읽는다)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COSMOS = path.resolve(HERE, '../../../../sep_analysis/cosmos.html');
const OUT = path.join(HERE, 'lexicon.json');

// ── ② 보강 항목 ────────────────────────────────────────
// 값은 SEP 표제어에 실제로 쓰이는 표현을 우선한다(첫 항목이 대표어).
const ADDITIONS = {
  concepts: {
    // 과학철학
    '공약불가능성': ['incommensurability', 'Kuhn', 'scientific revolutions'],
    '패러다임': ['paradigm', 'scientific revolutions', 'Kuhn'],
    '정상과학': ['normal science', 'Kuhn'],
    '과학혁명': ['scientific revolutions', 'Kuhn'],
    '반증': ['falsification', 'Popper', 'demarcation'],
    '반증가능성': ['falsifiability', 'demarcation', 'Popper'],
    '구획문제': ['demarcation', 'pseudo-science'],
    '과학적 실재론': ['scientific realism'],
    '도구주의': ['instrumentalism', 'scientific realism'],
    '미결정성': ['underdetermination', 'underdetermination of scientific theory'],
    '이론적재성': ['theory-ladenness', 'observation'],
    '설명': ['scientific explanation', 'explanation'],
    '법칙': ['laws of nature', 'ceteris paribus laws'],
    '자연종': ['natural kinds'],
    '환원': ['reduction', 'scientific reduction', 'reductionism'],
    '환원주의': ['reductionism', 'scientific reduction'],
    '창발': ['emergent properties', 'emergence'],
    '수반': ['supervenience'],
    '모형': ['models in science', 'scientific models'],
    '실험': ['experiment in physics', 'scientific experiment'],
    '확증': ['confirmation', 'Bayesian epistemology'],
    '귀납': ['induction', 'problem of induction'],
    '귀추': ['abduction', 'inference to the best explanation'],
    '개연성': ['probability', 'interpretations of probability'],

    // 형이상학·존재론
    '실재론': ['realism', 'scientific realism', 'moral realism'],
    '반실재론': ['anti-realism', 'realism', 'idealism'],
    '유명론': ['nominalism', 'universals'],
    '보편자': ['universals', 'properties', 'nominalism'],
    '개별자': ['particulars', 'tropes'],
    '속성': ['properties'],
    '본질': ['essential vs accidental properties', 'essence'],
    '양상': ['modality', 'possible worlds', 'modal logic'],
    '가능세계': ['possible worlds', 'modality'],
    '필연성': ['necessity', 'modality'],
    '우연성': ['contingency', 'modality'],
    '동일성': ['identity', 'personal identity', 'relative identity'],
    '인격동일성': ['personal identity'],
    '지속': ['persistence', 'temporal parts'],
    '시간': ['time', 'being and becoming in modern physics'],
    '공간': ['space', 'absolute and relational theories of space'],
    '인과': ['causation', 'causal determinism', 'the metaphysics of causation'],
    '인과관계': ['causation', 'counterfactual theories of causation'],
    '결정론': ['causal determinism', 'determinism', 'free will'],
    '자유의지': ['free will', 'compatibilism', 'incompatibilist theories of free will'],
    '양립가능론': ['compatibilism', 'free will'],
    '존재론적 개입': ['ontological commitment', 'Quine'],
    '허구': ['fiction', 'fictionalism'],
    '진리': ['truth', 'correspondence theory of truth', 'coherence theory of truth'],
    '진리대응론': ['correspondence theory of truth'],
    '정합론': ['coherence theory of truth', 'coherentism'],

    // 인식론
    '인식론': ['epistemology'],
    '정당화': ['justification', 'epistemic justification', 'foundationalist theories of epistemic justification'],
    '토대론': ['foundationalist theories of epistemic justification', 'foundationalism'],
    '내재주의': ['internalism and externalism in epistemology'],
    '외재주의': ['internalism and externalism in epistemology', 'externalism about mental content'],
    '신뢰론': ['reliabilist epistemology', 'reliabilism'],
    '덕인식론': ['virtue epistemology'],
    '회의주의': ['skepticism', 'ancient skepticism', 'medieval skepticism'],
    '게티어': ['the analysis of knowledge', 'Gettier'],
    '증언': ['epistemology of testimony', 'testimony'],
    '증거': ['evidence', 'epistemology of evidence'],
    '선험': ['a priori justification and knowledge', 'a priori'],
    '경험론': ['empiricism', 'rationalism vs. empiricism'],
    '합리론': ['rationalism vs. empiricism', 'continental rationalism'],
    '오류가능주의': ['fallibilism'],
    '인식적 부정의': ['epistemic injustice'],
    '사회인식론': ['social epistemology'],
    '베이즈주의': ['Bayesian epistemology', 'Bayes theorem'],

    // 심리철학·인지
    '심신문제': ['the mind/brain identity theory', 'dualism', 'physicalism'],
    '심신이원론': ['dualism'],
    '물리주의': ['physicalism'],
    '기능주의': ['functionalism'],
    '행동주의': ['behaviorism'],
    '의식': ['consciousness', 'the hard problem of consciousness'],
    '감각질': ['qualia', 'consciousness'],
    '지향성': ['intentionality', 'consciousness and intentionality'],
    '표상': ['mental representation', 'representation'],
    '명제태도': ['propositional attitude reports'],
    '개인동일성': ['personal identity'],
    '타심문제': ['other minds'],
    '인공지능': ['artificial intelligence', 'the Chinese room argument'],
    '계산주의': ['computational theory of mind'],
    '연결주의': ['connectionism'],
    '체화인지': ['embodied cognition'],
    '확장된 마음': ['the extended mind thesis', 'embodied cognition'],
    '자유의지와 도덕적 책임': ['moral responsibility', 'free will'],

    // 윤리학
    '윤리학': ['ethics', 'normative ethics'],
    '메타윤리학': ['metaethics', 'moral realism', 'moral anti-realism'],
    '규범윤리학': ['normative ethics'],
    '응용윤리': ['applied ethics'],
    '공리주의': ['consequentialism', 'utilitarianism', 'rule consequentialism'],
    '결과주의': ['consequentialism'],
    '의무론': ['deontological ethics', 'Kant’s moral philosophy'],
    '덕윤리': ['virtue ethics', 'moral character'],
    '정언명법': ['Kant’s moral philosophy', 'categorical imperative', 'Kant'],
    '가언명법': ['hypothetical imperatives', 'Kant’s moral philosophy'],
    '도덕실재론': ['moral realism'],
    '도덕반실재론': ['moral anti-realism'],
    '정서주의': ['moral cognitivism vs. non-cognitivism', 'expressivism'],
    '상대주의': ['moral relativism', 'relativism'],
    '규범성': ['normativity', 'reasons for action', 'moral motivation'],
    '도덕적 책임': ['moral responsibility'],
    '도덕운': ['moral luck'],
    '이기주의': ['egoism'],
    '이타주의': ['altruism', 'empathy'],
    '돌봄윤리': ['feminist ethics', 'the ethics of care'],
    '생명윤리': ['bioethics', 'theory and bioethics'],
    '환경윤리': ['environmental ethics'],
    '동물윤리': ['the moral status of animals', 'animal ethics'],

    // 정치·사회철학
    '정의': ['justice', 'distributive justice'],
    '분배정의': ['distributive justice'],
    '사회계약': ['contractarianism', 'social contract', 'contemporary approaches to the social contract'],
    '자유주의': ['liberalism'],
    '공동체주의': ['communitarianism'],
    '공화주의': ['republicanism'],
    '민주주의': ['democracy'],
    '권위': ['authority', 'political obligation'],
    '정당성': ['legitimacy', 'political legitimacy'],
    '시민불복종': ['civil disobedience'],
    '인권': ['human rights', 'rights'],
    '평등': ['equality', 'egalitarianism'],
    '자유': ['liberty', 'positive and negative liberty', 'freedom'],
    '재산': ['property', 'property and ownership'],
    '이데올로기': ['ideology', 'Marx'],
    '권력': ['power', 'Foucault'],
    '페미니즘': ['feminist philosophy', 'feminism'],
    '인종': ['race', 'philosophy of race'],
    '식민주의': ['colonialism', 'postcolonialism'],

    // 언어·논리
    '언어철학': ['philosophy of language'],
    '지시': ['reference', 'names', 'rigid designators'],
    '고정지시어': ['rigid designators', 'Kripke'],
    '기술이론': ['descriptions', 'Russell'],
    '의미': ['meaning', 'theories of meaning'],
    '의미론': ['semantics', 'theories of meaning'],
    '화용론': ['pragmatics', 'implicature'],
    '함축': ['implicature', 'pragmatics'],
    '화행': ['speech acts'],
    '사적언어': ['private language', 'Wittgenstein'],
    '언어게임': ['Wittgenstein', 'private language'],
    '분석성': ['the analytic/synthetic distinction', 'Quine'],
    '번역불확정성': ['indeterminacy of translation', 'Quine'],
    '논리학': ['logic', 'classical logic'],
    '양상논리': ['modal logic'],
    '직관주의논리': ['intuitionistic logic'],
    '역설': ['paradoxes', 'liar paradox', 'Russell’s paradox'],
    '거짓말쟁이역설': ['liar paradox'],
    '괴델': ['Gödel’s incompleteness theorems', 'Gödel'],
    '불완전성정리': ['Gödel’s incompleteness theorems'],
    '집합론': ['set theory'],
    '무한': ['infinity', 'the infinite'],

    // 미학·종교·기타
    '미학': ['aesthetics', 'aesthetic judgment'],
    '예술': ['art', 'the definition of art'],
    '취미판단': ['aesthetic judgment', 'Kant’s aesthetics'],
    '숭고': ['the sublime'],
    '재현': ['depiction', 'representation'],
    '종교철학': ['philosophy of religion'],
    '신존재증명': ['ontological arguments', 'cosmological argument', 'teleological arguments'],
    '존재론적 논증': ['ontological arguments'],
    '우주론적 논증': ['cosmological argument'],
    '악의 문제': ['the problem of evil'],
    '신정론': ['the problem of evil', 'theodicy'],
    '무신론': ['atheism and agnosticism'],
    '신앙': ['faith', 'faith and reason'],
    '현상학': ['phenomenology', 'Husserl'],
    '해석학': ['hermeneutics', 'Gadamer'],
    '실존주의': ['existentialism'],
    '구조주의': ['structuralism'],
    '해체': ['deconstruction', 'Derrida'],
    '실용주의': ['pragmatism', 'Peirce', 'Dewey'],
    '분석철학': ['analytic philosophy', 'analysis'],
    '대륙철학': ['continental philosophy'],
  },

  philosophers: {
    // cosmos 사전에 없거나 표기가 흔들리는 인물 보강
    '쿤': 'Kuhn', '토마스 쿤': 'Kuhn', '토머스 쿤': 'Kuhn',
    '파이어아벤트': 'Feyerabend', '라카토스': 'Lakatos', '헴펠': 'Hempel',
    '카르납': 'Carnap', '크립키': 'Kripke', '퍼트넘': 'Putnam', '퍼트남': 'Putnam',
    '데이비드슨': 'Davidson', '설': 'Searle', '설리': 'Searle', '촘스키': 'Chomsky',
    '데닛': 'Dennett', '차머스': 'Chalmers', '네이글': 'Nagel', '포더': 'Fodor',
    '루이스': 'Lewis', '암스트롱': 'Armstrong', '스트로슨': 'Strawson',
    '무어': 'Moore', '오스틴': 'Austin', '라일': 'Ryle', '에이어': 'Ayer',
    '가다머': 'Gadamer', '리쾨르': 'Ricoeur', '레비나스': 'Levinas',
    '메를로퐁티': 'Merleau-Ponty', '아렌트': 'Arendt', '벤야민': 'Benjamin',
    '아도르노': 'Adorno', '호르크하이머': 'Horkheimer', '들뢰즈': 'Deleuze',
    '보부아르': 'Beauvoir', '누스바움': 'Nussbaum', '센': 'Sen',
    '노직': 'Nozick', '드워킨': 'Dworkin', '하트': 'Hart', '테일러': 'Taylor',
    '맥킨타이어': 'MacIntyre', '싱어': 'Singer', '파핏': 'Parfit',
    '앤스컴': 'Anscombe', '풋': 'Foot', '윌리엄스': 'Williams',
    '피어스': 'Peirce', '퍼스': 'Peirce', '듀이': 'Dewey', '제임스': 'James',
    '로티': 'Rorty', '셀라스': 'Sellars', '브랜덤': 'Brandom',
    '아비센나': 'Ibn Sina', '이븐시나': 'Ibn Sina', '아베로에스': 'Ibn Rushd',
    '마이모니데스': 'Maimonides', '오컴': 'Ockham', '둔스 스코투스': 'Duns Scotus',
    '주희': 'Zhu Xi', '왕양명': 'Wang Yangming', '맹자': 'Mencius', '순자': 'Xunzi',
    '장자': 'Zhuangzi', '묵자': 'Mozi', '나가르주나': 'Nagarjuna',
  },

  disciplines: {
    '과학기술학': ['science and technology studies'],
    '기술철학': ['philosophy of technology'],
    '생물학철학': ['philosophy of biology'],
    '물리학철학': ['philosophy of physics'],
    '경제철학': ['philosophy of economics'],
    '사회과학철학': ['philosophy of social science'],
    '역사철학': ['philosophy of history'],
    '교육철학': ['philosophy of education'],
    '의학철학': ['philosophy of medicine'],
    '컴퓨터과학철학': ['philosophy of computer science'],
    '심리학철학': ['philosophy of psychology'],
    '인지과학': ['cognitive science'],
    '메타철학': ['metaphilosophy'],
  },
};

// ── ① cosmos.html 사전 파싱 ────────────────────────────
function parseCosmos() {
  if (!fs.existsSync(COSMOS)) {
    console.error(`[lexicon] cosmos.html을 찾을 수 없다: ${COSMOS} — ADDITIONS만으로 생성한다.`);
    return { concepts: [], philosophers: [], disciplines: [] };
  }
  const h = fs.readFileSync(COSMOS, 'utf8');
  const block = (name) => {
    const i = h.indexOf(`const ${name}=`);
    if (i < 0) return '';
    return h.slice(i, h.indexOf('];', i) + 1);
  };
  const nested = [...block('KO_EN').matchAll(/\['([^']+)',\s*\[([^\]]*)\]\]/g)]
    .map((m) => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])]);
  const flat = (name) =>
    [...block(name).matchAll(/\['([^']+)','([^']+)'\]/g)].map((m) => [m[1], [m[2]]]);
  return { concepts: nested, philosophers: flat('PHIL_KO'), disciplines: flat('DISC_KO') };
}

// ── 병합 ───────────────────────────────────────────────
const src = parseCosmos();
const merge = (pairs, additions) => {
  const map = new Map();
  const put = (ko, ens) => {
    const cur = map.get(ko) || [];
    for (const e of [].concat(ens)) if (!cur.some((x) => x.toLowerCase() === e.toLowerCase())) cur.push(e);
    map.set(ko, cur);
  };
  for (const [ko, ens] of pairs) put(ko, ens);
  for (const [ko, ens] of Object.entries(additions)) put(ko, ens);
  return Object.fromEntries([...map].sort((a, b) => b[0].length - a[0].length)); // 긴 키 우선 매칭
};

const lex = {
  _meta: {
    generated_by: 'build_lexicon.mjs',
    sources: ['sep_analysis/cosmos.html (KO_EN·PHIL_KO·DISC_KO)', 'ADDITIONS in build_lexicon.mjs'],
    note: '값의 첫 항목이 대표 영어어. 키는 긴 것부터 정렬되어 있어 부분문자열 오매칭을 줄인다.',
  },
  concepts: merge(src.concepts, ADDITIONS.concepts),
  philosophers: merge(src.philosophers, ADDITIONS.philosophers),
  disciplines: merge(src.disciplines, ADDITIONS.disciplines),
};

fs.writeFileSync(OUT, JSON.stringify(lex, null, 1) + '\n');
const n = (o) => Object.keys(o).length;
console.log(`[lexicon] 생성 완료 → ${OUT}`);
console.log(`  개념 ${n(lex.concepts)} · 철학자 ${n(lex.philosophers)} · 분과 ${n(lex.disciplines)} = 한국어 키 ${n(lex.concepts) + n(lex.philosophers) + n(lex.disciplines)}`);
