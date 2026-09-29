import {
  PEOPLE, WHO, uid, fmt, monthLabel, shiftMonth, parseAmount, logTotal, itemAmount,
  catTotal, totals, applyOp, nextMonthFrom, parsePasted, guessWho,
} from './shared/ledger.js';
import { seedMonth } from './shared/seed.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const S = {
  me: store.get('gb-me'),
  key: store.get('gb-key', ''),
  mode: 'remote', // remote | local
  needKey: false,
  monthId: today().slice(0, 7),
  month: null,
  months: [],
  tab: ['home', 'log', 'plan'].includes(store.get('gb-tab')) ? store.get('gb-tab') : 'home',
  showIncome: false,
  whoFilter: '전체',
  addWho: '같이',
  pending: 0,
  error: '',
};

/* ---------------- 데이터 ---------------- */

class AuthError extends Error {}
class NoServer extends Error {}

async function remote(method, payload) {
  const url = method === 'GET' ? `/api/ledger?month=${payload.month}` : '/api/ledger';
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-app-key': encodeURIComponent(S.key || '') },
      body: method === 'GET' ? undefined : JSON.stringify({ ...payload, by: S.me }),
    });
  } catch { throw new NoServer(); }
  if (r.status === 401) throw new AuthError();
  const type = r.headers.get('content-type') || '';
  if (!type.includes('json')) throw new NoServer();
  const j = await r.json();
  if (r.status === 503) throw new NoServer();
  if (!r.ok) throw new Error(j.message || '저장에 실패했어요');
  return j;
}

// 서버가 없을 때(로컬 미리보기) 이 브라우저에만 저장하는 모드
const local = {
  db() {
    const db = store.get('gb-local');
    if (db) return db;
    const seed = seedMonth();
    return { months: { [seed.id]: seed } };
  },
  save(db) { store.set('gb-local', db); },
  get(id) {
    const db = this.db();
    return { month: db.months[id] || null, months: Object.keys(db.months).sort() };
  },
  create(id) {
    const db = this.db();
    if (!db.months[id]) {
      const ids = Object.keys(db.months).sort();
      const prev = ids.filter((m) => m < id).pop() || ids[0];
      db.months[id] = nextMonthFrom(db.months[prev], id);
      this.save(db);
    }
    return this.get(id);
  },
  ops(id, ops) {
    const db = this.db();
    ops.forEach((op) => applyOp(db.months[id], op));
    db.months[id].rev++;
    this.save(db);
    return this.get(id);
  },
};

async function load(id = S.monthId, { quiet = false } = {}) {
  S.monthId = id;
  try {
    const j = S.mode === 'local' ? local.get(id) : await remote('GET', { month: id });
    S.months = j.months;
    if (quiet && S.month && j.month && S.month.id === j.month.id && S.month.rev === j.month.rev) return;
    S.month = j.month;
    S.needKey = false;
  } catch (e) {
    if (e instanceof AuthError) { S.needKey = true; S.month = null; }
    else if (e instanceof NoServer) { S.mode = 'local'; return load(id, { quiet }); }
    else toast(e.message);
  }
  if (quiet && isEditing()) return;
  render();
}

async function createMonth() {
  try {
    const j = S.mode === 'local' ? local.create(S.monthId) : await remote('POST', { month: S.monthId, create: true });
    S.month = j.month; S.months = j.months;
    render();
    toast(`${monthLabel(S.monthId)} 가계부를 시작했어요`);
  } catch (e) { toast(e.message); }
}

// 화면에는 바로 반영하고, 서버에는 순서대로 보낸다
let queue = Promise.resolve();
function commit(...ops) {
  const id = S.month.id;
  ops.forEach((op) => applyOp(S.month, op));
  render();
  S.pending++;
  setSync();
  queue = queue.then(async () => {
    try {
      const j = S.mode === 'local' ? local.ops(id, ops) : await remote('POST', { month: id, ops });
      S.pending--;
      if (S.pending === 0 && S.month?.id === id) { S.month = j.month; if (!isEditing()) render(); }
    } catch (e) {
      S.pending--;
      toast('저장 실패: ' + e.message + ' — 새로고침 해주세요');
    }
    setSync();
  });
}

const isEditing = () => {
  const a = document.activeElement;
  return (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || $sheet.open;
};

function setSync() {
  const el = document.getElementById('sync');
  if (el) el.textContent = S.pending ? '저장 중…' : S.mode === 'local' ? '이 기기에만 저장' : '저장됨';
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- 화면 ---------------- */

const TABS = [
  ['home', '요약', '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ['log', '생활비', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
  ['plan', '월 예산표', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'],
];

// 수입과 남는 돈(수입이 역산되는 값)은 탭하기 전까지 가려둔다
const HIDE_AFTER = 30000;
let hideTimer;
function revealIncome(on) {
  S.showIncome = on;
  clearTimeout(hideTimer);
  if (on) hideTimer = setTimeout(() => { S.showIncome = false; if (!isEditing()) render(); }, HIDE_AFTER);
  render();
}
const secret = (html, cls = '') => S.showIncome
  ? `<button class="secret shown ${cls}" data-act="reveal" aria-label="수입 숨기기">${html}</button>`
  : `<button class="secret ${cls}" data-act="reveal" aria-label="탭해서 수입 보기"><span class="dots">••••••</span><small>탭해서 보기</small></button>`;

function render() {
  if (!S.me || S.needKey) return renderLogin();
  const m = S.month;
  $app.innerHTML = `
    <header class="top">
      <div class="brand">
        <span class="logo">상화 <i>&amp;</i> 인화네</span>
        <button class="me me-${esc(S.me)}" data-act="switch-me" title="사용자 바꾸기">${esc(S.me)}</button>
      </div>
      <div class="monthnav">
        <button class="icon" data-act="month" data-d="-1" aria-label="이전 달">‹</button>
        <h1>${monthLabel(S.monthId)}</h1>
        <button class="icon" data-act="month" data-d="1" aria-label="다음 달">›</button>
      </div>
      <div class="sync" id="sync"></div>
    </header>
    ${S.mode === 'local' ? `<div class="banner">미리보기 모드예요. 지금 입력한 내용은 이 브라우저에만 저장돼요. (Vercel 배포 후에는 두 사람이 함께 보게 돼요)</div>` : ''}
    <main>${m ? VIEWS[S.tab](m) : emptyMonth()}</main>
    <nav class="tabs">
      ${TABS.map(([id, label, icon]) => `
        <button class="${S.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>
        </button>`).join('')}
    </nav>`;
  setSync();
}

function renderLogin() {
  $app.innerHTML = `
    <div class="login">
      <div class="login-card">
        <div class="login-mark">🏠</div>
        <h1>상화 &amp; 인화네 가계부</h1>
        <p>누가 쓰고 있나요?</p>
        <div class="who-pick">
          ${PEOPLE.map((p) => `<button class="pick pick-${p} ${S.me === p ? 'on' : ''}" data-act="pick" data-who="${p}">${p}</button>`).join('')}
        </div>
        ${S.needKey ? `
          <form class="keyform" data-form="key">
            <label>우리 가계부 비밀번호
              <input type="password" name="key" autocomplete="current-password" required autofocus />
            </label>
            <button class="primary" ${S.me ? '' : 'disabled'}>들어가기</button>
          </form>` : ''}
      </div>
    </div>`;
}

function emptyMonth() {
  const prev = S.months.filter((m) => m < S.monthId).pop();
  const src = prev || S.months[0];
  return `
    <section class="empty">
      <p class="empty-title">${monthLabel(S.monthId)} 가계부가 아직 없어요</p>
      ${src ? `<p class="muted">${monthLabel(src)}의 고정비·적금 항목과 금액을 그대로 가져오고,<br>생활비 내역만 비워서 시작해요.</p>
      <button class="primary" data-act="create">${monthLabel(src).slice(6)} 내용으로 시작하기</button>` : ''}
    </section>`;
}

/* ---- 요약 ---- */
function viewHome(m) {
  const t = totals(m);
  const cats = m.cats.map((c) => ({ c, v: catTotal(m, c) })).filter((x) => x.v > 0);
  const max = Math.max(1, ...cats.map((x) => x.v));
  const living = logTotal(m);
  const days = new Set(m.log.map((e) => e.date)).size;
  return `
    <section class="stats">
      <div class="stat"><span>수입</span>${secret(`<b>${fmt(t.income)}</b>`)}</div>
      <div class="stat"><span>총 지출</span><b>${fmt(t.expense)}</b></div>
      <div class="stat big ${S.showIncome && t.balance < 0 ? 'neg' : ''}">
        <span>남는 돈 <small>수입 − 지출</small></span>
        ${secret(`<b>${t.balance < 0 ? '−' : ''}${fmt(Math.abs(t.balance))}<em>원</em></b>`)}
        ${S.showIncome && t.income === 0 ? `<button class="link" data-act="tab" data-tab="plan">수입을 입력하면 남는 돈이 계산돼요 →</button>` : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>지출 구성</h2><span class="muted">저축 ${fmt(t.saving)}원 포함</span></div>
      <ul class="bars">
        ${cats.map(({ c, v }) => `
          <li>
            <div class="bar-label"><span>${esc(c.name)}</span><b>${fmt(v)}</b></div>
            <div class="bar"><i class="${c.saving ? 'save' : ''}" style="width:${(v / max) * 100}%"></i></div>
          </li>`).join('') || '<li class="muted">아직 지출이 없어요</li>'}
      </ul>
    </section>

    <section class="card">
      <div class="card-head"><h2>생활비</h2><button class="link" data-act="tab" data-tab="log">내역 보기 →</button></div>
      <div class="living-total"><b>${fmt(living)}</b>원 <span class="muted">· ${m.log.length}건${days ? ` · 하루 평균 ${fmt(living / days)}원` : ''}</span></div>
      <div class="split">
        ${WHO.map((w) => {
          const v = logTotal(m, w);
          return `<div class="split-part who-${w}" style="flex:${Math.max(v, 1)}"><span>${w}</span><b>${fmt(v)}</b></div>`;
        }).join('')}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>메모</h2><span class="muted">출금일 · 급여일 등</span></div>
      <textarea class="memo" data-field="memo" rows="${Math.min(12, Math.max(4, (m.memo || '').split('\n').length + 1))}" placeholder="카드 출금일, 급여일 같은 걸 적어두세요">${esc(m.memo)}</textarea>
    </section>`;
}

/* ---- 생활비 ---- */
function viewLog(m) {
  const f = S.whoFilter;
  const list = m.log.filter((e) => f === '전체' || e.who === f);
  const groups = {};
  for (const e of list) (groups[e.date] ||= []).push(e);
  const dates = Object.keys(groups).sort().reverse();
  const defDate = today().startsWith(m.id) ? today() : `${m.id}-01`;
  const dayName = (d) => '일월화수목금토'[new Date(d + 'T00:00').getDay()];
  return `
    <section class="card addform">
      <form data-form="add-log">
        <div class="row">
          <input type="date" name="date" value="${defDate}" min="${m.id}-01" max="${m.id}-31" required />
          <div class="seg" role="radiogroup" aria-label="누가 썼나요">
            ${WHO.map((w) => `<button type="button" class="seg-${w} ${S.addWho === w ? 'on' : ''}" data-act="add-who" data-who="${w}">${w}</button>`).join('')}
          </div>
        </div>
        <div class="row">
          <input name="name" placeholder="어디에 썼나요? (예: 이마트 장보기)" required autocomplete="off" />
        </div>
        <div class="row">
          <input name="amount" class="amount" inputmode="numeric" placeholder="금액" required autocomplete="off" />
          <button class="primary">추가</button>
        </div>
      </form>
    </section>

    <div class="filters">
      ${['전체', ...WHO].map((w) => `<button class="chip ${f === w ? 'on' : ''}" data-act="filter" data-who="${w}">${w}</button>`).join('')}
      <span class="filter-sum">${fmt(list.reduce((s, e) => s + (Number(e.amount) || 0), 0))}원</span>
    </div>

    ${dates.map((d) => `
      <section class="day">
        <div class="day-head"><span>${Number(d.slice(8))}일 <small>${dayName(d)}</small></span><span>${fmt(groups[d].reduce((s, e) => s + (Number(e.amount) || 0), 0))}</span></div>
        <ul>
          ${groups[d].map((e) => `
            <li data-act="edit-log" data-id="${e.id}" tabindex="0">
              <span class="dot who-${esc(e.who)}" title="${esc(e.who)}"></span>
              <span class="log-name">${esc(e.name)}${e.note ? ` <small>${esc(e.note)}</small>` : ''}</span>
              <b>${fmt(e.amount)}</b>
            </li>`).join('')}
        </ul>
      </section>`).join('') || '<p class="empty muted">아직 내역이 없어요</p>'}

    <div class="log-tools">
      <button class="ghost" data-act="paste">구글시트에서 붙여넣기</button>
    </div>`;
}

/* ---- 월 예산표 ---- */
function catCard(m, c, isIncome = false) {
  const total = catTotal(m, c);
  if (isIncome && !S.showIncome) {
    return `
      <section class="card cat income locked">
        <div class="card-head"><h2>수입</h2>${secret('', 'compact')}</div>
      </section>`;
  }
  return `
    <section class="card cat ${isIncome ? 'income' : ''} ${c.saving ? 'saving' : ''}">
      <div class="card-head">
        ${isIncome ? `<h2>수입 <button class="link" data-act="reveal">숨기기</button></h2>` : `<input class="cat-name" value="${esc(c.name)}" data-field="cat-name" data-cat="${c.id}" aria-label="분류 이름" />`}
        <b class="cat-total">${fmt(total)}</b>
        ${isIncome ? '' : `<button class="icon small" data-act="cat-menu" data-cat="${c.id}" aria-label="분류 설정">⋯</button>`}
      </div>
      <ul class="items">
        ${c.items.map((it) => it.auto === 'log' ? `
          <li class="auto">
            <span class="item-name">${esc(it.name)} <small>생활비 내역 합계</small></span>
            <button class="amount-auto" data-act="tab" data-tab="log">${fmt(itemAmount(m, it))}</button>
            <span class="del-spacer"></span>
          </li>` : `
          <li>
            <input class="item-name" value="${esc(it.name)}" data-field="item-name" data-cat="${c.id}" data-item="${it.id}" aria-label="항목 이름" />
            <input class="amount" inputmode="numeric" value="${it.amount ? fmt(it.amount) : ''}" placeholder="0" data-field="item-amount" data-cat="${c.id}" data-item="${it.id}" aria-label="${esc(it.name)} 금액" />
            <button class="del" data-act="del-item" data-cat="${c.id}" data-item="${it.id}" aria-label="삭제">×</button>
          </li>`).join('')}
      </ul>
      <button class="add-item" data-act="add-item" data-cat="${c.id}">+ 항목 추가</button>
    </section>`;
}

function viewPlan(m) {
  const t = totals(m);
  return `
    <div class="plan-sum">
      <div><span>수입</span>${secret(`<b>${fmt(t.income)}</b>`, 'compact')}</div>
      <div><span>지출</span><b>${fmt(t.expense)}</b></div>
      <div class="${S.showIncome && t.balance < 0 ? 'neg' : ''}"><span>남는 돈</span>${secret(`<b>${fmt(t.balance)}</b>`, 'compact')}</div>
    </div>
    <p class="hint">금액 칸에 <code>15000+3000</code>처럼 식을 넣어도 계산돼요.</p>
    <div class="grid">
      ${catCard(m, m.income, true)}
      ${m.cats.map((c) => catCard(m, c)).join('')}
    </div>
    <button class="ghost wide" data-act="add-cat">+ 분류 추가</button>`;
}

const VIEWS = { home: viewHome, log: viewLog, plan: viewPlan };

/* ---------------- 시트(모달) ---------------- */

function openSheet(html, onSubmit) {
  $sheet.innerHTML = `<form method="dialog" class="sheet">${html}</form>`;
  const form = $sheet.querySelector('form');
  form.addEventListener('submit', (ev) => {
    const action = ev.submitter?.value;
    if (action && action !== 'cancel') { ev.preventDefault(); if (onSubmit(action, new FormData(form)) !== false) $sheet.close(); }
  });
  $sheet.showModal();
}
$sheet.addEventListener('close', () => { if (S.month) render(); });
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) $sheet.close(); });

function editLog(id) {
  const e = S.month.log.find((x) => x.id === id);
  if (!e) return;
  openSheet(`
    <h2>생활비 수정</h2>
    <label>날짜<input type="date" name="date" value="${e.date}" /></label>
    <label>항목<input name="name" value="${esc(e.name)}" required /></label>
    <label>금액<input name="amount" inputmode="numeric" value="${fmt(e.amount)}" /></label>
    <label>메모<input name="note" value="${esc(e.note)}" placeholder="선택" /></label>
    <fieldset class="seg-field"><legend>누가</legend>
      ${WHO.map((w) => `<label class="radio seg-${w}"><input type="radio" name="who" value="${w}" ${e.who === w ? 'checked' : ''} /><span>${w}</span></label>`).join('')}
    </fieldset>
    <div class="sheet-actions">
      <button value="delete" class="danger" formnovalidate>삭제</button>
      <span></span>
      <button value="cancel" class="ghost" formnovalidate>취소</button>
      <button value="save" class="primary">저장</button>
    </div>`, (action, fd) => {
    if (action === 'delete') { commit({ type: 'delLog', id }); toast('삭제했어요'); return; }
    const amount = parseAmount(fd.get('amount'));
    if (Number.isNaN(amount)) { toast('금액을 확인해주세요'); return false; }
    commit({ type: 'setLog', id, patch: { date: fd.get('date'), name: fd.get('name').trim(), amount, note: fd.get('note').trim(), who: fd.get('who') } });
  });
}

function catMenu(catId) {
  const c = S.month.cats.find((x) => x.id === catId);
  const hasAuto = c.items.some((i) => i.auto);
  openSheet(`
    <h2>${esc(c.name)}</h2>
    <label class="toggle"><input type="checkbox" name="saving" ${c.saving ? 'checked' : ''} /> 저축으로 집계 (요약의 저축 금액에 포함)</label>
    <div class="sheet-row">
      <button value="up" class="ghost" formnovalidate>↑ 위로</button>
      <button value="down" class="ghost" formnovalidate>↓ 아래로</button>
    </div>
    <div class="sheet-actions">
      ${hasAuto ? '<span></span>' : '<button value="delete" class="danger" formnovalidate>분류 삭제</button>'}
      <span></span>
      <button value="cancel" class="ghost" formnovalidate>닫기</button>
      <button value="save" class="primary">저장</button>
    </div>`, (action, fd) => {
    if (action === 'up' || action === 'down') { commit({ type: 'moveCat', cat: catId, dir: action === 'up' ? -1 : 1 }); return; }
    if (action === 'delete') {
      if (!confirm(`'${c.name}' 분류와 항목을 모두 지울까요?`)) return false;
      commit({ type: 'delCat', cat: catId }); return;
    }
    commit({ type: 'setCat', cat: catId, patch: { saving: fd.get('saving') === 'on' } });
  });
}

function pasteDialog() {
  openSheet(`
    <h2>구글시트에서 붙여넣기</h2>
    <p class="muted small">시트에서 <b>날짜 · 항목 · 금액</b> 세 칸을 드래그해서 복사한 뒤 아래에 붙여넣으세요. 날짜가 빈 줄은 윗줄 날짜를 따르고, "인화_", "상화_"로 시작하면 사람도 자동으로 정해져요.</p>
    <textarea name="text" rows="8" placeholder="9/1	인화_메가커피	2000"></textarea>
    <div class="sheet-actions">
      <span></span><span></span>
      <button value="cancel" class="ghost" formnovalidate>취소</button>
      <button value="import" class="primary">추가</button>
    </div>`, (action, fd) => {
    const entries = parsePasted(fd.get('text') || '', S.month.id);
    if (!entries.length) { toast('읽을 수 있는 줄이 없어요'); return false; }
    commit({ type: 'addLog', entries });
    toast(`${entries.length}건 추가했어요`);
  });
}

/* ---------------- 이벤트 ---------------- */

$app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'pick':
      S.me = d.who; store.set('gb-me', S.me);
      if (S.needKey) { renderLogin(); document.querySelector('.keyform input')?.focus(); } else load();
      break;
    case 'switch-me':
      S.me = null; store.set('gb-me', null); renderLogin(); break;
    case 'tab':
      S.tab = d.tab; store.set('gb-tab', S.tab); render(); window.scrollTo(0, 0); break;
    case 'month':
      S.month = null; load(shiftMonth(S.monthId, Number(d.d))); break;
    case 'create': createMonth(); break;
    case 'filter': S.whoFilter = d.who; render(); break;
    case 'add-who':
      S.addWho = d.who;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
      break;
    case 'edit-log': editLog(d.id); break;
    case 'paste': pasteDialog(); break;
    case 'cat-menu': catMenu(d.cat); break;
    case 'add-item': {
      const item = { id: uid(), name: '새 항목', amount: 0 };
      commit({ type: 'addItem', cat: d.cat, item });
      const input = document.querySelector(`[data-field="item-name"][data-item="${item.id}"]`);
      input?.focus(); input?.select();
      break;
    }
    case 'del-item': {
      const c = d.cat === 'income' ? S.month.income : S.month.cats.find((x) => x.id === d.cat);
      const it = c.items.find((x) => x.id === d.item);
      if (it.amount && !confirm(`'${it.name}' 항목을 지울까요?`)) return;
      commit({ type: 'delItem', cat: d.cat, item: d.item });
      break;
    }
    case 'add-cat': {
      const cat = { id: 'c-' + uid(), name: '새 분류', items: [{ id: uid(), name: '항목', amount: 0 }] };
      commit({ type: 'addCat', cat });
      const input = document.querySelector(`[data-field="cat-name"][data-cat="${cat.id}"]`);
      input?.focus(); input?.select();
      break;
    }
    case 'reveal': revealIncome(!S.showIncome); break;
  }
});

$app.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('li[data-act="edit-log"]')) { ev.preventDefault(); editLog(ev.target.dataset.id); }
  if (ev.key === 'Enter' && ev.target.matches('input[data-field]')) ev.target.blur();
});

// 입력칸은 포커스가 빠질 때(change) 저장
$app.addEventListener('change', (ev) => {
  const el = ev.target;
  const d = el.dataset;
  switch (d.field) {
    case 'memo': commit({ type: 'setMemo', text: el.value }); break;
    case 'cat-name': commit({ type: 'setCat', cat: d.cat, patch: { name: el.value.trim() || '이름 없음' } }); break;
    case 'item-name': commit({ type: 'setItem', cat: d.cat, item: d.item, patch: { name: el.value.trim() || '이름 없음' } }); break;
    case 'item-amount': {
      const n = parseAmount(el.value);
      if (Number.isNaN(n)) { toast('금액을 확인해주세요'); el.focus(); return; }
      commit({ type: 'setItem', cat: d.cat, item: d.item, patch: { amount: n } });
      break;
    }
  }
});

$app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  if (form.dataset.form === 'key') {
    S.key = fd.get('key'); store.set('gb-key', S.key); S.needKey = false; load();
    return;
  }
  if (form.dataset.form === 'add-log') {
    const amount = parseAmount(fd.get('amount'));
    if (Number.isNaN(amount)) { toast('금액을 확인해주세요'); return; }
    const name = fd.get('name').trim();
    const who = S.addWho === '같이' ? guessWho(name) : S.addWho;
    commit({ type: 'addLog', entry: { id: uid(), date: fd.get('date'), name, amount, who, note: '', by: S.me } });
    toast(`${name} ${fmt(amount)}원 추가`);
    const date = fd.get('date');
    render();
    const f = document.querySelector('[data-form="add-log"]');
    f.date.value = date;
    f.name.focus();
  }
});

// 상대방이 입력한 내용을 주기적으로 가져오기
setInterval(() => {
  if (document.visibilityState === 'visible' && S.me && S.month && S.pending === 0 && S.mode === 'remote') load(S.monthId, { quiet: true });
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S.showIncome) { S.showIncome = false; clearTimeout(hideTimer); render(); }
  if (document.visibilityState === 'visible' && S.me && S.pending === 0 && S.mode === 'remote') load(S.monthId, { quiet: true });
});

load();
