// 브라우저와 서버(api/ledger.js)가 함께 쓰는 가계부 로직.
// 한 달 데이터 = { id, rev, income, cats, log, memo }

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

export const guessWho = (name) =>
  /^(최)?인화/.test(name) ? '인화' : /^(박)?상화/.test(name) ? '상화' : '같이';
