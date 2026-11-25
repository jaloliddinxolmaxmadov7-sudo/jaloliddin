# ezome — manba kodi

Sayt `../ezome/` papkasida (tayyor, yig'ilgan). Bu papkada uni yig'ish va server uchun kerakli fayllar.

- `ilova-manba.html` — ilovaning to'liq manbasi (Claude'dagi ezome bilan bir xil kod).
- `build.py` — `python3 build.py ilova-manba.html` → `public/index.html` (Supabase versiyasi).
  Yig'ilgan faylni `../ezome/index.html` ga ko'chiring.
- `supabase/` — ma'lumotlar bazasi sxemasi, ruxsat qoidalari va xodimlar serveri.
- `paynet-server/` — Paynet avtomatik to'lov serveri (keyinchalik ulanadi; `npm test` — sinovlar).

Sayt sozlamasi: `../ezome/config.js` (Supabase manzili va ochiq kalit, Paynet yoqilganmi, admin aloqasi).
