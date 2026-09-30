// Vercel 서버리스 함수: 아이폰(iCloud) 공개 캘린더 연결.
//   GET  /api/calendar                  → { calendars: [{ id, name, color, url }] }
//   GET  /api/calendar?ics=1            → 위 + { ics: { [id]: ".ics 텍스트" | null }, errors: {...} }
//   POST /api/calendar { calendars }    → 캘린더 목록 저장
// 공유 주소는 공개 GitHub 저장소가 아닌 Redis에만 저장하고, 저장된 주소만 가져온다(아무 주소나 대신 받아주지 않음).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PASSWORD = process.env.APP_PASSWORD;
const KEY = 'gagyebu:calendars';

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// webcal:// 주소를 https:// 로, iCloud 공개 캘린더 주소만 허용
function normalizeUrl(raw) {
  const s = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('캘린더 주소 형식이 올바르지 않아요.'); }
  if (u.protocol !== 'https:' || !/(^|\.)icloud\.com$/i.test(u.hostname)) {
    throw new Error('아이폰(iCloud) 공개 캘린더 주소만 넣을 수 있어요.');
  }
  return u.toString();
}

async function fetchIcs(url) {
  const r = await fetch(url, { headers: { Accept: 'text/calendar, text/plain' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`캘린더를 가져오지 못했어요 (${r.status})`);
  const text = await r.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('캘린더 파일이 아니에요. 공유 주소를 다시 확인해주세요.');
  return text;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'no-storage', message: '저장소가 연결되지 않았어요.' });
  if (PASSWORD && req.headers['x-app-key'] !== encodeURIComponent(PASSWORD)) {
    return res.status(401).json({ error: 'auth', message: '비밀번호가 맞지 않아요.' });
  }

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const calendars = (body.calendars || []).slice(0, 6).map((c, i) => ({
        id: String(c.id || `cal${i}`).slice(0, 20),
        name: String(c.name || '캘린더').slice(0, 20),
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#4d7cc9',
        url: normalizeUrl(c.url),
      })).filter((c) => c.url);
      await redis('SET', KEY, JSON.stringify(calendars));
      return res.status(200).json({ calendars });
    }
    if (req.method !== 'GET') return res.status(405).end();

    const calendars = JSON.parse((await redis('GET', KEY)) || '[]');
    if (!req.query.ics) return res.status(200).json({ calendars });

    const ics = {}, errors = {};
    await Promise.all(calendars.map(async (c) => {
      try { ics[c.id] = await fetchIcs(c.url); } catch (e) { ics[c.id] = null; errors[c.id] = e.message; }
    }));
    return res.status(200).json({ calendars, ics, errors });
  } catch (e) {
    return res.status(400).json({ error: 'bad', message: e.message });
  }
}
