// ViLa license server trên Cloudflare Workers + KV.
// Luồng: khách chuyển khoản (nội dung "VILA <mã thiết bị> GOLDY") → SePay gọi webhook /webhook/sepay → Worker ghi gói vào KV
// → app gọi GET /api/entitlement?device=... để tự kích hoạt (không cần gửi mã tay).
//
// Biến/Secrets cần có:  SEPAY_API_KEY (secret) · ADMIN_TOKEN (secret) · binding KV tên LICENSES

// BẢNG GIÁ (VND) – PHẢI TRÙNG với BillingCatalog.priceVnd trong app.
const PRICES = {
  GOLD:     { M: 49000,  Y: 490000 },
  PLATINUM: { M: 99000,  Y: 990000 },
  DIAMOND:  { M: 149000, Y: 1490000 },
};
const DAY = 86400000;
const DURATION = { M: 31 * DAY, Y: 366 * DAY };
const MEMO_RE = /VILA\s*([0-9A-F]{8})\s*(GOLD|PLATINUM|DIAMOND)\s*([MY])/i;   // ngân hàng có thể bỏ dấu cách

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

const isDevice = (s) => /^[0-9A-F]{8}$/.test(s || '');
const tierId = (t) => t.toLowerCase();
const rank = { gold: 1, platinum: 2, diamond: 3 };

async function readEnt(env, device) {
  const raw = await env.LICENSES.get('ent:' + device);
  return raw ? JSON.parse(raw) : null;
}

/** Cộng gói: cùng gói → cộng dồn thời hạn; khác gói → thay bằng gói mới tính từ bây giờ. */
async function grant(env, device, tier, period) {
  const now = Date.now();
  const cur = await readEnt(env, device);
  const base = cur && cur.tier === tier && cur.expiresAt > now ? cur.expiresAt : now;
  const ent = { tier, expiresAt: base + DURATION[period], updatedAt: now };
  await env.LICENSES.put('ent:' + device, JSON.stringify(ent));
  return ent;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const authed = (req, expected, scheme) => {
  const h = req.headers.get('authorization') || '';
  const want = scheme + ' ' + expected;
  return !!expected && timingSafeEqual(h, want);
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' } });
    }

    // ---- App: hỏi gói của thiết bị ----
    if (url.pathname === '/api/entitlement' && req.method === 'GET') {
      const device = (url.searchParams.get('device') || '').toUpperCase();
      if (!isDevice(device)) return json({ error: 'bad_device' }, 400);
      const ent = await readEnt(env, device);
      if (!ent || ent.expiresAt <= Date.now()) return json({ tier: 'free', expiresAt: 0 });
      return json({ tier: ent.tier, expiresAt: ent.expiresAt });
    }

    // ---- SePay webhook: tự cấp gói khi tiền về ----
    if (url.pathname === '/webhook/sepay' && req.method === 'POST') {
      if (!authed(req, env.SEPAY_API_KEY, 'Apikey')) return json({ success: false, error: 'unauthorized' }, 401);
      const body = await req.json().catch(() => null);
      if (!body) return json({ success: false, error: 'bad_json' }, 400);
      if (body.transferType && body.transferType !== 'in') return json({ success: true, ignored: 'not_incoming' });

      const txId = String(body.id ?? body.referenceCode ?? '');
      if (txId && (await env.LICENSES.get('tx:' + txId))) return json({ success: true, duplicate: true });   // chống cộng 2 lần

      const text = String(body.content || '') + ' ' + String(body.description || '');
      const m = MEMO_RE.exec(text);
      if (!m) return json({ success: true, ignored: 'no_memo' });
      const device = m[1].toUpperCase(), TIER = m[2].toUpperCase(), P = m[3].toUpperCase();
      const need = PRICES[TIER][P];
      const paid = Number(body.transferAmount || 0);
      if (paid < need) {
        await env.LICENSES.put('short:' + (txId || Date.now()), JSON.stringify({ device, TIER, P, paid, need, at: Date.now() }), { expirationTtl: 60 * 86400 });
        return json({ success: true, ignored: 'underpaid' });
      }
      const ent = await grant(env, device, tierId(TIER), P);
      if (txId) await env.LICENSES.put('tx:' + txId, '1', { expirationTtl: 400 * 86400 });
      return json({ success: true, granted: { device, ...ent } });
    }

    // ---- Admin ----
    if (url.pathname.startsWith('/api/admin/')) {
      if (!authed(req, env.ADMIN_TOKEN, 'Bearer')) return json({ error: 'unauthorized' }, 401);

      // Cấp tay (khi khách chuyển khoản mà webhook không khớp nội dung)
      if (url.pathname === '/api/admin/grant' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const device = String(b.device || '').toUpperCase();
        const tier = String(b.tier || '').toLowerCase();
        const P = b.period === 'yearly' || b.period === 'Y' ? 'Y' : 'M';
        if (!isDevice(device) || !rank[tier]) return json({ error: 'bad_request' }, 400);
        return json({ ok: true, device, ...(await grant(env, device, tier, P)) });
      }
      if (url.pathname === '/api/admin/revoke' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const device = String(b.device || '').toUpperCase();
        if (!isDevice(device)) return json({ error: 'bad_request' }, 400);
        await env.LICENSES.delete('ent:' + device);
        return json({ ok: true });
      }
      // Danh sách khách + giao dịch thiếu tiền
      if (url.pathname === '/api/admin/list' && req.method === 'GET') {
        const out = [];
        const ents = await env.LICENSES.list({ prefix: 'ent:' });
        for (const k of ents.keys) {
          const v = JSON.parse((await env.LICENSES.get(k.name)) || 'null');
          if (v) out.push({ device: k.name.slice(4), tier: v.tier, expiresAt: new Date(v.expiresAt).toISOString(), active: v.expiresAt > Date.now() });
        }
        const shorts = [];
        for (const k of (await env.LICENSES.list({ prefix: 'short:' })).keys) shorts.push(JSON.parse((await env.LICENSES.get(k.name)) || 'null'));
        return json({ customers: out, underpaid: shorts });
      }
    }

    return json({ ok: true, service: 'vila-license' });
  },
};
