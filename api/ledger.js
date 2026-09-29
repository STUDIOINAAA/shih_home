// Vercel 서버리스 함수: 가계부 데이터를 Upstash Redis(Vercel Storage)에 저장한다.
//   GET  /api/ledger?month=2026-09          → { month, months }
//   POST /api/ledger { month, ops: [...] }   → 변경 적용 후 { month, months }
//   POST /api/ledger { month, create: true } → 직전 달을 복사해 새 달 생성
import { applyOp, nextMonthFrom } from '../shared/ledger.js';
import { seedMonth } from '../shared/seed.js';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PASSWORD = process.env.APP_PASSWORD;

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

const monthKey = (id) => `gagyebu:month:${id}`;
const MONTHS_KEY = 'gagyebu:months';

async function getMonths() {
  let months = JSON.parse((await redis('GET', MONTHS_KEY)) || 'null');
  if (!months) {
    // 첫 실행: 구글시트 9월 데이터로 시작
    const seed = seedMonth();
    await redis('SET', monthKey(seed.id), JSON.stringify(seed));
    months = [seed.id];
    await redis('SET', MONTHS_KEY, JSON.stringify(months));
  }
  return months;
}

const getMonth = async (id) => JSON.parse((await redis('GET', monthKey(id))) || 'null');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) {
    return res.status(503).json({ error: 'no-storage', message: 'Vercel에서 Upstash Redis 저장소를 연결해주세요.' });
  }
  if (PASSWORD && req.headers['x-app-key'] !== encodeURIComponent(PASSWORD)) {
    return res.status(401).json({ error: 'auth', message: '비밀번호가 맞지 않아요.' });
  }

  try {
    const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) : {};
    const id = (req.method === 'GET' ? req.query.month : body.month) || '';
    let months = await getMonths();
    if (!/^\d{4}-\d{2}$/.test(id)) return res.status(200).json({ month: null, months });

    if (req.method === 'GET') {
      return res.status(200).json({ month: await getMonth(id), months });
    }

    if (req.method !== 'POST') return res.status(405).end();

    if (body.create) {
      let month = await getMonth(id);
      if (!month) {
        const prevId = [...months].sort().filter((m) => m < id).pop() || [...months].sort()[0];
        month = nextMonthFrom(await getMonth(prevId), id);
        await redis('SET', monthKey(id), JSON.stringify(month));
        months = [...new Set([...months, id])].sort();
        await redis('SET', MONTHS_KEY, JSON.stringify(months));
      }
      return res.status(200).json({ month, months });
    }

    const month = await getMonth(id);
    if (!month) return res.status(404).json({ error: 'not-found', message: '없는 달이에요.' });
    for (const op of body.ops || []) applyOp(month, op);
    month.rev = (month.rev || 0) + 1;
    month.updatedAt = Date.now();
    month.updatedBy = body.by || '';
    await redis('SET', monthKey(id), JSON.stringify(month));
    return res.status(200).json({ month, months });
  } catch (e) {
    return res.status(500).json({ error: 'server', message: e.message });
  }
}
