# Vazifa Board

Asana uslubidagi Kanban board: Google login, jamoaviy loyihalar, real-time yangilanish.

- Frontend: static HTML/JS (`public/`), build yo'q
- Backend: Supabase (Auth + Postgres + RLS + Realtime)
- Hosting: Render Static Site (`publishPath: public`)

## Ma'lumotlar modeli
`profiles` · `projects` · `project_members (owner|member)` · `columns` · `tasks` · `task_messages` (vazifa chati)
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
