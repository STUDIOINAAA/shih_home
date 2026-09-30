// 아이폰(iCloud) 공개 캘린더의 .ics 텍스트를 읽어서 기간 안의 일정 목록으로 펼친다.
// 반복 일정(RRULE: 매일/매주/매월/매년, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY),
// 제외 날짜(EXDATE), 반복 중 한 번만 바뀐 일정(RECURRENCE-ID)을 지원한다.

const DAY = 86400000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

const unescapeText = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// "20260930", "20260930T190000", "20260930T100000Z" → Date
// TZID가 붙은 시간은 한국에서 쓰는 걸 전제로 브라우저 현지 시간으로 해석한다.
function parseDate(value, params = {}) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  const allDay = params.VALUE === 'DATE' || m[4] === undefined;
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { date, allDay };
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params = {};
  for (const p of rawParams) {
    const [k, v] = p.split('=');
    params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

export function parseICS(text) {
  const events = [];
  let ev = null;
  for (const line of unfold(text || '')) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev?.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': ev.uid = p.value; break;
      case 'SUMMARY': ev.title = unescapeText(p.value); break;
      case 'LOCATION': ev.location = unescapeText(p.value); break;
      case 'DESCRIPTION': ev.note = unescapeText(p.value); break;
      case 'URL': ev.url = p.value; break;
      case 'STATUS': ev.status = p.value; break;
      case 'DTSTART': { const d = parseDate(p.value, p.params); if (d) { ev.start = d.date; ev.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(p.value, p.params); if (d) ev.end = d.date; break; }
      case 'DURATION': ev.duration = p.value; break;
      case 'RRULE': ev.rrule = Object.fromEntries(p.value.split(';').map((kv) => kv.split('='))); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) ev.exdates.push(d.date); }
        break;
      case 'RECURRENCE-ID': { const d = parseDate(p.value, p.params); if (d) ev.recurrenceId = d.date; break; }
    }
  }
  for (const e of events) {
    if (!e.end) e.end = e.duration ? new Date(e.start.getTime() + durationMs(e.duration)) : new Date(e.start.getTime() + (e.allDay ? DAY : 0));
  }
  return events.filter((e) => e.status !== 'CANCELLED');
}

function durationMs(s) {
  const m = s.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return 0;
  const [, w = 0, d = 0, h = 0, mi = 0, sec = 0] = m.map((x) => Number(x) || 0);
  return (((+w * 7 + +d) * 24 + +h) * 60 + +mi) * 60000 + +sec * 1000;
}

const sameInstant = (a, b) => Math.abs(a - b) < 60000;
const withTime = (day, src) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), src.getHours(), src.getMinutes(), src.getSeconds());

// 반복 규칙에 따라 시작 시각들을 차례로 만든다 (range 끝을 넘거나 COUNT/UNTIL에 닿으면 멈춤)
function* occurrences(ev, rangeEnd) {
  const r = ev.rrule;
  if (!r) { yield ev.start; return; }
  const interval = Number(r.INTERVAL) || 1;
  const count = Number(r.COUNT) || Infinity;
  const until = r.UNTIL ? parseDate(r.UNTIL)?.date : null;
  const s = ev.start;
  let n = 0;
  const emit = function* (d) {
    if (d < s) return false;
    if ((until && d > until) || n >= count || d > rangeEnd) return true;
    n++;
    yield d;
    return false;
  };

  for (let step = 0; step < 5000; step++) {
    let batch = [];
    if (r.FREQ === 'DAILY') {
      batch = [new Date(s.getFullYear(), s.getMonth(), s.getDate() + step * interval, s.getHours(), s.getMinutes(), s.getSeconds())];
    } else if (r.FREQ === 'WEEKLY') {
      const weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay() + step * 7 * interval);
      const days = r.BYDAY ? r.BYDAY.split(',').map((x) => WD[x.slice(-2)]) : [s.getDay()];
      batch = days.sort((a, b) => a - b).map((wd) => withTime(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd), s));
    } else if (r.FREQ === 'MONTHLY') {
      const y = s.getFullYear(), mo = s.getMonth() + step * interval;
      if (r.BYDAY) {
        batch = r.BYDAY.split(',').map((x) => nthWeekday(y, mo, Number(x.slice(0, -2)) || 1, WD[x.slice(-2)])).filter(Boolean).map((d) => withTime(d, s));
      } else {
        const days = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [s.getDate()];
        batch = days.map((dd) => {
          const last = new Date(y, mo + 1, 0).getDate();
          const day = dd < 0 ? last + dd + 1 : dd;
          return day >= 1 && day <= last ? withTime(new Date(y, mo, day), s) : null;
        }).filter(Boolean);
      }
    } else if (r.FREQ === 'YEARLY') {
      const d = new Date(s.getFullYear() + step * interval, s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds());
      batch = d.getDate() === s.getDate() ? [d] : []; // 2/29 같은 날짜가 없는 해는 건너뜀
    } else {
      yield s; return;
    }
    for (const d of batch.sort((a, b) => a - b)) {
      const stop = yield* emit(d);
      if (stop) return;
    }
  }
}

function nthWeekday(y, m, nth, wd) {
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  if (nth > 0) {
    const d = 1 + ((wd - first.getDay() + 7) % 7) + (nth - 1) * 7;
    return d <= last.getDate() ? new Date(y, m, d) : null;
  }
  const d = last.getDate() - ((last.getDay() - wd + 7) % 7) + (nth + 1) * 7;
  return d >= 1 ? new Date(y, m, d) : null;
}

// from ≤ 일정 < to 사이에 걸치는 일정들을 시간순으로
export function expandEvents(events, from, to, extra = {}) {
  const out = [];
  const overrides = events.filter((e) => e.recurrenceId);
  for (const ev of events) {
    if (ev.recurrenceId) {
      if (ev.end > from && ev.start < to) out.push({ ...extra, ...pick(ev), start: ev.start, end: ev.end });
      continue;
    }
    const len = ev.end - ev.start;
    for (const start of occurrences(ev, to)) {
      if (ev.exdates.some((x) => sameInstant(x, start))) continue;
      if (overrides.some((o) => o.uid === ev.uid && sameInstant(o.recurrenceId, start))) continue;
      const end = new Date(start.getTime() + len);
      if (end > from && start < to) out.push({ ...extra, ...pick(ev), start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0));
}

const pick = (e) => ({ uid: e.uid, title: e.title || '(제목 없음)', location: e.location || '', note: e.note || '', url: e.url || '', allDay: !!e.allDay });

// 여러 날에 걸친 일정을 날짜(YYYY-MM-DD)별로 나눠 담기
export function byDay(list) {
  const map = {};
  for (const e of list) {
    const last = e.allDay ? new Date(e.end.getTime() - 1) : e.end.getTime() === e.start.getTime() ? e.start : new Date(e.end.getTime() - 1);
    for (let d = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate()); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      (map[key] ||= []).push(e);
      if (Object.keys(map).length > 400) break;
    }
  }
  return map;
}
