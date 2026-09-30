// 브라우저와 서버(api/ledger.js)가 함께 쓰는 가계부 로직.
// 한 달 데이터 = { id, rev, income, cats, log, allowLog, memo }
// allowLog: 각자 용돈으로 쓴 내역. 용돈은 예산표에서 이미 지출로 잡혀 있으므로 총 지출에는 더하지 않는다.

export const PEOPLE = ['상화', '인화'];
export const WHO = ['같이', '상화', '인화'];

export const uid = () => Math.random().toString(36).slice(2, 10);

export const fmt = (n) => (Math.round(n) || 0).toLocaleString('ko-KR');

export function monthLabel(id) {
  const [y, m] = id.split('-').map(Number);
  return `${y}년 ${m}월`;
}

export function shiftMonth(id, delta) {
  const [y, m] = id.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// "15000+3000-500" 같은 간단한 식도 금액으로 인정
export function parseAmount(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[,\s원]/g, '');
  if (!s) return 0;
  if (!/^[-+]?\d+(\.\d+)?([-+]\d+(\.\d+)?)*$/.test(s)) return NaN;
  return (s.match(/[-+]?\d+(\.\d+)?/g) || []).reduce((a, b) => a + Number(b), 0);
}

export const logTotal = (month, who) =>
  month.log.reduce((s, e) => (!who || e.who === who ? s + (Number(e.amount) || 0) : s), 0);

export const itemAmount = (month, item) =>
  item.auto === 'log' ? logTotal(month) : Number(item.amount) || 0;

export const catTotal = (month, cat) =>
  cat.items.reduce((s, it) => s + itemAmount(month, it), 0);

export function totals(month) {
  const income = catTotal(month, month.income);
  const expense = month.cats.reduce((s, c) => s + catTotal(month, c), 0);
  const saving = month.cats
    .filter((c) => c.saving)
    .reduce((s, c) => s + catTotal(month, c), 0);
  return { income, expense, saving, balance: income - expense };
}

function findCat(month, catId) {
  if (catId === 'income') return month.income;
  const c = month.cats.find((c) => c.id === catId);
  if (!c) throw new Error('없는 분류입니다');
  return c;
}

// 서버와 클라이언트가 같은 방식으로 변경사항을 적용한다.
// 항상 최신 데이터 위에 작은 변경만 얹으므로 두 사람이 동시에 써도 서로 덮어쓰지 않는다.
export function applyOp(month, op) {
  switch (op.type) {
    case 'setItem': {
      const it = findCat(month, op.cat).items.find((i) => i.id === op.item);
      if (it) Object.assign(it, op.patch);
      break;
    }
    case 'addItem':
      findCat(month, op.cat).items.push(op.item);
      break;
    case 'delItem': {
      const c = findCat(month, op.cat);
      c.items = c.items.filter((i) => i.id !== op.item || i.auto);
      break;
    }
    case 'addCat':
      month.cats.push(op.cat);
      break;
    case 'setCat':
      Object.assign(findCat(month, op.cat), op.patch);
      break;
    case 'delCat':
      month.cats = month.cats.filter((c) => c.id !== op.cat || c.items.some((i) => i.auto));
      break;
    case 'moveCat': {
      const i = month.cats.findIndex((c) => c.id === op.cat);
      const j = i + op.dir;
      if (i >= 0 && j >= 0 && j < month.cats.length) {
        [month.cats[i], month.cats[j]] = [month.cats[j], month.cats[i]];
      }
      break;
    }
    case 'addLog':
      month.log.push(...(op.entries || [op.entry]));
      break;
    case 'setLog': {
      const e = month.log.find((e) => e.id === op.id);
      if (e) Object.assign(e, op.patch);
      break;
    }
    case 'delLog':
      month.log = month.log.filter((e) => e.id !== op.id);
      break;
    case 'addAllow':
      (month.allowLog ||= []).push(op.entry);
      break;
    case 'setAllow': {
      const e = (month.allowLog || []).find((e) => e.id === op.id);
      if (e) Object.assign(e, op.patch);
      break;
    }
    case 'delAllow':
      month.allowLog = (month.allowLog || []).filter((e) => e.id !== op.id);
      break;
    case 'setMemo':
      month.memo = op.text;
      break;
    default:
      throw new Error('알 수 없는 변경: ' + op.type);
  }
  return month;
}

// 이전 달을 바탕으로 새 달 만들기: 항목·금액은 그대로, 생활비 내역은 비움
export function nextMonthFrom(prev, id) {
  const clone = JSON.parse(JSON.stringify(prev));
  const fresh = (items) => items.map((it) => ({ ...it, id: it.auto ? it.id : uid() }));
  return {
    id,
    rev: 0,
    income: { ...clone.income, items: fresh(clone.income.items) },
    cats: clone.cats.map((c) => ({ ...c, items: fresh(c.items) })),
    log: [],
    allowLog: [],
    memo: clone.memo || '',
  };
}


// 구글시트에서 복사해 붙여넣은 "날짜 / 항목 / 금액" 줄을 생활비 내역으로 변환
export function parsePasted(text, monthId) {
  const [y, m] = monthId.split('-');
  let lastDate = `${y}-${m}-01`;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.split('\t').map((s) => s.trim());
    if (cols.length < 2 || cols.every((c) => !c)) continue;
    let [d, name, amt] = cols.length >= 3 ? cols : ['', cols[0], cols[1]];
    if (!name || name === '항목' || name === '합계') continue;
    const dm = d.replace(/;/g, '').match(/(\d{1,2})[./-](\d{1,2})/);
    if (dm) lastDate = `${y}-${String(dm[1]).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}`;
    const n = parseAmount(amt);
    out.push({
      id: uid(),
      date: lastDate,
      name,
      amount: Number.isNaN(n) ? 0 : n,
      note: Number.isNaN(n) ? amt : '',
      who: guessWho(name),
    });
  }
  return out;
}

// 생활비 소비 카테고리. 항목 이름으로 자동 분류하고, 내역에 cat이 있으면 그걸 우선한다.
// 위에서부터 먼저 맞는 카테고리로 들어가므로 순서가 중요하다.
export const SPEND_CATS = [
  { id: 'gift', name: '경조사·선물', emoji: '🎁', color: '#d9a441', re: /경조사|축의|부조|선물/ },
  { id: 'wedding', name: '결혼 준비', emoji: '💍', color: '#e38aa5', re: /청첩|청모|\d+매|스티커|웨딩|드레스/ },
  { id: 'work', name: '521 FRAMEWORK', emoji: '🎬', color: '#8a7fd1', re: /521|dji|프레임워크/i },
  { id: 'car', name: '차량·교통', emoji: '🚗', color: '#5f8fb8', re: /주유|주차|엔진오일|세차|톨게이트|하이패스|택시|버스|지하철|교통/ },
  { id: 'digital', name: '구독·디지털', emoji: '📱', color: '#6fb3c9', re: /애플|icloud|클라우드|카카오톡|구독|넷플릭스|유튜브|쿠팡플레이|티빙/i },
  { id: 'cvs', name: '편의점', emoji: '🏪', color: '#62b08a', re: /편의점|cu|gs25|세븐일레븐|이마트24|미니스톱|삼김/i },
  { id: 'cafe', name: '카페', emoji: '☕', color: '#a9795b', re: /커피|카페|아샷추|아아|라떼|메가|바나프레소|컴포즈|스타벅스|이디야|빽다방|다방|미숫/ },
  { id: 'living', name: '생활용품·뷰티', emoji: '🧴', color: '#9fb86a', re: /다이소|이케아|화장품|폼클렌징|클렌징|치약|칫솔|세정제|세제|휴지|트러블패치|커텐|커튼|비오틴|영양제|약국|올리브영/ },
  { id: 'eatout', name: '외식', emoji: '🍽️', color: '#e07a5f', re: /점심|저녁|식사|피자|분식|서브웨이|버거|맥도날드|롯데리아|국밥|순대국|떡볶이|칼국수|냉면|평냉|닭갈비|치킨|초밥|배달|술집|고기집/ },
  { id: 'snack', name: '간식', emoji: '🍪', color: '#f2b5a0', re: /간식|아이스크림|빵|모나카|디저트|케이크|반숙란|과자/ },
  { id: 'grocery', name: '장보기', emoji: '🛒', color: '#4f9d9a', re: /이마트|홈플러스|롯데마트|롯데슈퍼|세이브존|마트|슈퍼|쿠팡|식재료|우유|햇반|닭가슴살|앞다리살|고기|어묵|야채|과일|음료수|계란/ },
  { id: 'etc', name: '기타', emoji: '🏷️', color: '#b3aa9f', re: null },
];
const ETC = SPEND_CATS[SPEND_CATS.length - 1];

export const guessSpendCat = (name) => SPEND_CATS.find((c) => c.re && c.re.test(name || '')) || ETC;

export const spendCat = (e) => SPEND_CATS.find((c) => c.id === e.cat) || guessSpendCat(e.name);

// 카테고리별 합계, 금액 큰 순
export function spendByCat(entries) {
  const map = new Map();
  for (const e of entries) {
    const c = spendCat(e);
    const row = map.get(c.id) || { ...c, amount: 0, count: 0 };
    row.amount += Number(e.amount) || 0;
    row.count++;
    map.set(c.id, row);
  }
  return [...map.values()].filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
}

export const guessWho = (name) =>
  /^(최)?인화/.test(name) ? '인화' : /^(박)?상화/.test(name) ? '상화' : '같이';

// 용돈: 예산표에서 이름에 "용돈"과 그 사람 이름이 들어간 항목 합계 vs 용돈 내역에 적은 사용액
export function allowanceOf(month, person) {
  const budget = month.cats.flatMap((c) => c.items)
    .filter((it) => !it.auto && it.name.includes('용돈') && guessWho(it.name) === person)
    .reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const entries = (month.allowLog || []).filter((e) => e.who === person);
  const spent = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return { budget, spent, left: budget - spent, entries };
}
