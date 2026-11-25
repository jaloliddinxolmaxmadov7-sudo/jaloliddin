# ezome — Supabase server qismi

Loyiha: `nyrtswxdrxsycubkhpiw` (eu-central-1, bepul tarif).

- `schema.sql` — `docs` jadvali, ruxsat qoidalari (RLS), real vaqt, rasmlar papkasi (`img`), sotuv raqami hisoblagichi.
- `functions/staff/index.ts` — xodimlar serveri: birinchi admin, xodim qo'shish, login/kod almashtirish, xodimni o'chirish.

Ruxsatlar qisqacha:
- admin hammasini ko'radi va o'zgartiradi;
- ishchi faqat o'z sotuvi, tarixi va hisobotini ko'radi; tovarning faqat qoldig'ini o'zgartira oladi;
- o'chirilgan xodim va tizimga kirmagan odam hech narsani ko'rmaydi.
