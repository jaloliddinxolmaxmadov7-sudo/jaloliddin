// ezome xodimlar serveri: birinchi admin, xodim qo'shish, login/kod almashtirish, o'chirish.
// verify_jwt o'chiq: 'setup' tizimga kirmasdan chaqiriladi; qolgan amallar ichida admin tekshiriladi.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const email = (l: string) => String(l).toLowerCase() + '@ezome.app';
const pass = (c: string) => 'ezome-' + String(c);
const LOGIN = /^[a-z0-9_.-]{3,30}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST kerak' }, 405);
  const adm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: 'JSON noto\'g\'ri' }, 400); }
  const action = String(b.action || '');

  // --- Birinchi admin: faqat bir marta ---
  if (action === 'setup') {
    const name = String(b.name || '').trim().slice(0, 40), login = String(b.login || '').trim().toLowerCase(), code = String(b.code || '');
    if (name.length < 2) return json({ error: 'Ismingizni yozing' }, 400);
    if (!LOGIN.test(login)) return json({ error: "Login 3–30 ta lotin harf, raqam, _ . - bo'lsin" }, 400);
    if (code.length < 6) return json({ error: 'Admin kodi kamida 6 belgi bo\'lsin' }, 400);
    const { data: owner } = await adm.from('docs').select('id').eq('col', 'meta').eq('id', 'owner').maybeSingle();
    if (owner) return json({ error: "Admin allaqachon yaratilgan — o'z login va kodingiz bilan kiring" }, 409);
    const { data: u, error } = await adm.auth.admin.createUser({ email: email(login), password: pass(code), email_confirm: true });
    if (error || !u.user) return json({ error: /already/i.test(error?.message || '') ? 'Bu login band — boshqasini tanlang' : 'Yaratib bo\'lmadi' }, 400);
    const uid = u.user.id, t = Date.now();
    const { error: e1 } = await adm.from('docs').insert({ col: 'meta', id: 'owner', data: { uid, t } });
    if (e1) { await adm.auth.admin.deleteUser(uid); return json({ error: "Admin allaqachon yaratilgan — o'z login va kodingiz bilan kiring" }, 409); }
    await adm.from('docs').insert({ col: 'users', id: uid, data: { name, login, role: 'admin', t } });
    return json({ ok: true, uid });
  }

  // --- Qolgan amallar: faqat faol admin ---
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who } = await adm.auth.getUser(jwt);
  if (!who?.user) return json({ error: 'Kirish kerak' }, 401);
  const { data: me } = await adm.from('docs').select('data').eq('col', 'users').eq('id', who.user.id).maybeSingle();
  if (!me || me.data?.role !== 'admin' || me.data?.disabled) return json({ error: 'Faqat admin' }, 403);

  if (action === 'create') {
    const name = String(b.name || '').trim().slice(0, 40), login = String(b.login || '').trim().toLowerCase(), code = String(b.code || '');
    const role = b.role === 'admin' ? 'admin' : 'worker';
    if (!name) return json({ error: 'Ismini yozing' }, 400);
    if (!LOGIN.test(login)) return json({ error: "Login 3–30 ta lotin harf, raqam, _ . - bo'lsin" }, 400);
    if (code.length < (role === 'admin' ? 6 : 4)) return json({ error: role === 'admin' ? 'Admin kodi kamida 6 belgi' : 'Ishchi kodi kamida 4 belgi' }, 400);
    const { data: u, error } = await adm.auth.admin.createUser({ email: email(login), password: pass(code), email_confirm: true });
    if (error || !u.user) return json({ error: /already/i.test(error?.message || '') ? 'Bu login band' : 'Xodimni yaratib bo\'lmadi' }, 400);
    const { error: e2 } = await adm.from('docs').insert({ col: 'users', id: u.user.id, data: { name, login, role, t: Date.now(), by: me.data?.name || '' } });
    if (e2) { await adm.auth.admin.deleteUser(u.user.id); return json({ error: 'Saqlanmadi' }, 500); }
    return json({ ok: true, uid: u.user.id });
  }

  const uid = String(b.uid || '');
  const { data: target } = await adm.from('docs').select('data').eq('col', 'users').eq('id', uid).maybeSingle();
  if (!target) return json({ error: 'Xodim topilmadi' }, 404);

  if (action === 'update') {
    const upd: Record<string, unknown> = {};
    if (b.login !== undefined && b.login !== target.data?.login) {
      const login = String(b.login).trim().toLowerCase();
      if (!LOGIN.test(login)) return json({ error: 'Login noto\'g\'ri' }, 400);
      upd.email = email(login); upd.email_confirm = true;
    }
    if (b.code) {
      const min = target.data?.role === 'admin' ? 6 : 4;
      if (String(b.code).length < min) return json({ error: 'Kod juda qisqa' }, 400);
      upd.password = pass(String(b.code));
    }
    if (Object.keys(upd).length) {
      const { error } = await adm.auth.admin.updateUserById(uid, upd);
      if (error) return json({ error: /already/i.test(error.message) ? 'Bu login band' : 'Almashtirib bo\'lmadi' }, 400);
    }
    return json({ ok: true });
  }

  if (action === 'disable') {
    if (uid === who.user.id) return json({ error: "O'zingizni o'chira olmaysiz" }, 400);
    await adm.auth.admin.updateUserById(uid, { ban_duration: '876000h' });
    await adm.from('docs').update({ data: { ...target.data, disabled: true, disabledAt: Date.now() } }).eq('col', 'users').eq('id', uid);
    return json({ ok: true });
  }

  return json({ error: "Noma'lum amal" }, 400);
});
