# Topshiriq AI (avvalgi nomi: Vazifa Board)

Asana uslubidagi Kanban board: Google login, jamoaviy loyihalar, real-time yangilanish.

- Frontend: static HTML/JS (`public/`), build yo'q
- Backend: Supabase (Auth + Postgres + RLS + Realtime)
- Hosting: Render Static Site (`publishPath: public`)

## Ma'lumotlar modeli
`profiles` · `projects` · `project_members (owner|member)` · `columns` · `tasks` · `task_assignees` (bir nechta mas'ul) · `task_messages` (vazifa chati)
Barcha ruxsatlar Postgres RLS orqali: foydalanuvchi faqat a'zo bo'lgan loyihalarni ko'radi.

## Google login sozlash
1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application)
   - Authorized redirect URI: `https://hpadmjyjcndxoiddoopq.supabase.co/auth/v1/callback`
2. Supabase → Authentication → Sign In / Providers → Google: Client ID + Secret
3. Supabase → Authentication → URL Configuration: Site URL va Redirect URLs ga sayt manzilini qo'shing

## Vazifa chati
- Har bir vazifa oynasida chat: xabarlar real-time keladi, kartochkada 💬 soni ko'rinadi.
- Ruxsatlar (RLS): faqat loyiha a'zolari o'qiydi va yozadi; xabar faqat o'z nomingizdan; o'chirish — muallif yoki loyiha egasi; tahrirlash yo'q.
- Rasm biriktirish: tugma, sudrab tashlash yoki Ctrl+V. Brauzerda ≤1600px JPEG ga kichraytiriladi. Yopiq bucket `task-files` (5 MB, faqat rasm), yo'l `project_id/task_id/uuid.ext`; ko'rish — 1 soatlik imzolangan havola. Storage RLS: faqat a'zolar o'qiydi/yuklaydi; o'chirish — yuklagan yoki loyiha egasi.
- Xabar boshqa loyihadagi vazifaga bog'lana olmaydi: `(task_id, project_id)` → `tasks(id, project_id)` FK. Vazifa o'chsa, chati ham o'chadi.

## Ish oqimi va mas'ullar
- Bosqichlar: Rejada → **Qabul qilindi** → Jarayonda → Tekshiruvda → Bajarildi (yangi loyihalarda standart; mavjudlariga qo'shildi).
- Vazifaga bir nechta a'zo biriktiriladi (`task_assignees`); faqat loyiha a'zosi, a'zo chiqarilsa biriktirish o'zi o'chadi.
- Vazifa nomini faqat uni yaratgan odam o'zgartiradi (DB trigger `tasks_guard_title` + UI'da qulf).

## Bildirishnomalar
- Jadval `notifications`; yozuvlarni faqat DB triggerlari yaratadi (`private.notify_*`, security definer), foydalanuvchi faqat o'zinikini o'qiydi va `read_at` ni o'zgartiradi
- Kimga boradi (amalni bajargan odamning o'ziga bormaydi):
  - chat xabari, bosqich o'zgarishi → vazifa yaratuvchisi + mas'ullar
  - yangi vazifa → loyihaning barcha a'zolari
  - mas'ul qilib biriktirildi → o'sha odam
  - loyihaga qo'shildi → o'sha odam
- UI: 🔔 belgisi va o'qilmaganlar soni, tab sarlavhasida `(N)`; sayt ochiq, lekin boshqa oyna faol bo'lsa — brauzer bildirishnomasi (ruxsat panel ichidagi tugma orqali so'raladi)
- Cheklov: sayt tabi butunlay yopiq bo'lsa xabar chiqmaydi (buning uchun Web Push yoki Telegram kerak)
