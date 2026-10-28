// Topshiriq AI — Telegram bot (webhook)
// Ovozli/matnli xabar → STT → AI tahlil → tasdiqlash → vazifa.
// Deploy: supabase functions deploy telegram-bot --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const env = (k: string, required = true) => {
  const v = Deno.env.get(k);
  if (required && !v) throw new Error(`Missing env ${k}`);
  return v ?? '';
};

const BOT_TOKEN = env('TELEGRAM_BOT_TOKEN');
const WEBHOOK_SECRET = env('TELEGRAM_WEBHOOK_SECRET');
const OPENAI_KEY = env('OPENAI_API_KEY');
const STT_PROVIDER = env('STT_PROVIDER', false) || 'openai'; // openai | elevenlabs
const ELEVEN_KEY = env('ELEVENLABS_API_KEY', false);
const SITE_URL = env('SITE_URL', false) || 'https://vazifa-board.onrender.com';
const PARSE_MODEL = env('PARSE_MODEL', false) || 'gpt-4o-mini';
const MAX_VOICE_SEC = 300;
// Ruxsat etilgan Telegram user ID'lar (vergul bilan). Bo'sh bo'lsa — bot hech kimga ishlamaydi (xavfsiz default).
const ALLOWED_IDS = new Set(env('ALLOWED_TG_IDS', false).split(',').map((x) => x.trim()).filter(Boolean));
const isAllowed = (id: unknown) => ALLOWED_IDS.has(String(id));
const STEP = 1000; // app.js bilan bir xil
const TZ = 'Asia/Tashkent';

const db: SupabaseClient = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

// ---------- Telegram helpers ----------
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error(`tg ${method}`, j);
  return j;
}
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function downloadTgFile(file_id: string): Promise<Blob> {
  const f = await tg('getFile', { file_id });
  if (!f.ok) throw new Error('getFile failed');
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) throw new Error(`download ${r.status}`);
  return await r.blob();
}

// ---------- STT ----------
async function transcribe(audio: Blob, filename: string): Promise<string> {
  const fd = new FormData();
  if (STT_PROVIDER === 'elevenlabs') {
    fd.append('model_id', 'scribe_v1');
    fd.append('language_code', 'uzb');
    fd.append('file', audio, filename);
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: fd,
    });
    if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
    return ((await r.json()).text ?? '').trim();
  }
  fd.append('model', 'whisper-1');
  fd.append('language', 'uz');
  fd.append('file', audio, filename); // .ogg (opus) Whisper qabul qiladi
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${OPENAI_KEY}` }, body: fd,
  });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  return ((await r.json()).text ?? '').trim();
}

// ---------- AI tahlil ----------
type Member = { user_id: string; name: string };
type Parsed = { title: string; description: string; assignee_ids: string[]; due_date: string | null };

function todayTashkent(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

async function parseTask(text: string, members: Member[]): Promise<Parsed> {
  const today = todayTashkent();
  const weekday = new Intl.DateTimeFormat('uz-UZ', { timeZone: TZ, weekday: 'long' }).format(new Date());
  const sys = `Siz vazifa menejeri yordamchisisiz. Foydalanuvchi o'zbek tilida (ba'zan rus so'zlari bilan) vazifa aytadi; matn nutqdan avtomatik olingan, xatolar bo'lishi mumkin.
Bugun: ${today} (${weekday}), vaqt mintaqasi ${TZ}.
Loyiha a'zolari (id — ism): ${members.map((m) => `${m.user_id} — ${m.name}`).join('; ')}
Qoidalar:
- title: qisqa, buyruq shaklida, 80 belgigacha, imlo xatolari tuzatilgan.
- description: to'liq mazmun, tushunarli o'zbek tilida; yangi ma'lumot qo'shmang.
- assignee_ids: faqat ro'yxatdagi id'lar; ism aniq mos kelmasa — qo'shmang. Gapda mas'ul bo'lmasa — bo'sh.
- due_date: "ertaga", "juma", "15-noyabr" kabi ifodalarni YYYY-MM-DD ga aylantiring; muddat aytilmasa — null. O'tgan sanani bermang.`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: PARSE_MODEL,
      temperature: 0,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'task', strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            required: ['title', 'description', 'assignee_ids', 'due_date'],
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              assignee_ids: { type: 'array', items: { type: 'string' } },
              due_date: { type: ['string', 'null'] },
            },
          },
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`parse ${r.status}: ${await r.text()}`);
  const p = JSON.parse((await r.json()).choices[0].message.content) as Parsed;

  // AI chiqishiga ishonmaymiz — tekshiramiz
  const ids = new Set(members.map((m) => m.user_id));
  p.assignee_ids = [...new Set(p.assignee_ids.filter((id) => ids.has(id)))];
  if (p.due_date && !(/^\d{4}-\d{2}-\d{2}$/.test(p.due_date) && !isNaN(Date.parse(p.due_date)) && p.due_date >= today)) {
    p.due_date = null;
  }
  p.title = (p.title || text).trim().slice(0, 200);
  p.description = (p.description || '').trim().slice(0, 4000);
  return p;
}

// ---------- DB helpers ----------
async function getLink(chat_id: number) {
  const { data } = await db.from('telegram_links').select('*').eq('chat_id', chat_id).maybeSingle();
  return data as { user_id: string; chat_id: number; default_project_id: string | null } | null;
}

async function isMember(project_id: string, user_id: string) {
  const { data } = await db.from('project_members').select('user_id')
    .eq('project_id', project_id).eq('user_id', user_id).maybeSingle();
  return !!data;
}

async function projectMembers(project_id: string): Promise<Member[]> {
  const { data, error } = await db.from('project_members')
    .select('user_id, profiles(full_name, email)').eq('project_id', project_id);
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((m: any) => ({ user_id: m.user_id, name: m.profiles?.full_name || m.profiles?.email || m.user_id }));
}

async function userProjects(user_id: string) {
  const { data } = await db.from('project_members').select('project_id, projects(name)').eq('user_id', user_id);
  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((r: any) => ({ id: r.project_id as string, name: r.projects?.name as string }));
}

// ---------- Handlers ----------
const NOT_LINKED = `Hisobingiz ulanmagan.\n\n1. ${SITE_URL} ga kiring\n2. Menyu → <b>Telegramni ulash</b>\n3. Chiqqan tugmani bosing`;

async function handleStart(chat_id: number, code: string, username?: string) {
  if (!code) {
    const link = await getLink(chat_id);
    return send(chat_id, link
      ? 'Hisob ulangan ✅\n\nOvozli yoki matnli xabar yuboring — vazifa bo\'lib tushadi.\n/loyiha — standart loyihani tanlash'
      : NOT_LINKED);
  }
  const { data: row } = await db.from('telegram_link_codes').select('*').eq('code', code).maybeSingle();
  if (!row || new Date(row.expires_at) < new Date()) {
    return send(chat_id, 'Kod eskirgan yoki noto\'g\'ri. Saytda qaytadan "Telegramni ulash" ni bosing.');
  }
  await db.from('telegram_link_codes').delete().eq('code', code);
  // Bitta chat — bitta hisob: shu chatga oldin ulangan boshqa hisobni ajratamiz
  await db.from('telegram_links').delete().eq('chat_id', chat_id).neq('user_id', row.user_id);
  const { error } = await db.from('telegram_links')
    .upsert({ user_id: row.user_id, chat_id, username: username ?? null }, { onConflict: 'user_id' });
  if (error) throw error;
  await send(chat_id, 'Hisob ulandi ✅');
  return askProject(chat_id, row.user_id);
}

async function askProject(chat_id: number, user_id: string) {
  const projects = await userProjects(user_id);
  if (!projects.length) return send(chat_id, 'Sizda hali loyiha yo\'q. Avval saytda loyiha yarating yoki a\'zo bo\'ling.');
  return send(chat_id, 'Vazifalar qaysi loyihaga tushsin?', {
    reply_markup: { inline_keyboard: projects.map((p) => [{ text: p.name, callback_data: `p:${p.id}` }]) },
  });
}

async function handleIncomingTask(chat_id: number, link: NonNullable<Awaited<ReturnType<typeof getLink>>>, text: string, isVoice: boolean) {
  const pid = link.default_project_id;
  if (!pid || !(await isMember(pid, link.user_id))) {
    await send(chat_id, 'Avval loyihani tanlang.');
    return askProject(chat_id, link.user_id);
  }
  const members = await projectMembers(pid);
  const p = await parseTask(text, members);
  const { data: draft, error } = await db.from('telegram_drafts')
    .insert({ user_id: link.user_id, chat_id, project_id: pid, payload: { ...p, transcript: text } })
    .select('id').single();
  if (error) throw error;

  const names = p.assignee_ids.map((id) => members.find((m) => m.user_id === id)?.name).filter(Boolean);
  const lines = [
    isVoice ? `🎙 <i>${esc(text)}</i>\n` : '',
    `📌 <b>${esc(p.title)}</b>`,
    p.description && p.description !== p.title ? esc(p.description) : '',
    `👤 ${names.length ? esc(names.join(', ')) : '—'}`,
    `📅 ${p.due_date ?? '—'}`,
  ].filter(Boolean);
  return send(chat_id, lines.join('\n'), {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Yaratish', callback_data: `c:${draft.id}` },
      { text: '❌ Bekor', callback_data: `x:${draft.id}` },
    ]] },
  });
}

async function createTaskFromDraft(draft_id: string, user_id: string) {
  const { data: d } = await db.from('telegram_drafts').select('*').eq('id', draft_id).eq('user_id', user_id).maybeSingle();
  if (!d) return { error: 'Qoralama topilmadi yoki allaqachon ishlatilgan' };
  // Atomik "claim": ikki marta bosilsa ikki vazifa yaralmasin
  const { data: claimed } = await db.from('telegram_drafts').delete().eq('id', draft_id).select('id');
  if (!claimed?.length) return { error: 'Allaqachon yaratilgan' };

  if (!(await isMember(d.project_id, user_id))) return { error: 'Siz bu loyiha a\'zosi emassiz' };
  const { data: col } = await db.from('columns').select('id, title').eq('project_id', d.project_id)
    .eq('is_done', false).order('position').limit(1).maybeSingle();
  if (!col) return { error: 'Loyihada ustun yo\'q' };
  const { data: last } = await db.from('tasks').select('position').eq('column_id', col.id)
    .order('position', { ascending: false }).limit(1).maybeSingle();

  const p = d.payload as Parsed & { transcript: string };
  const { data: task, error } = await db.from('tasks').insert({
    project_id: d.project_id,
    column_id: col.id,
    title: p.title,
    description: p.description,
    due_date: p.due_date,
    position: (last?.position ?? 0) + STEP,
    created_by: user_id,
    tags: ['telegram'],
  }).select('id').single();
  if (error) throw error;

  // Draft yaratilgandan keyin a'zolikdan chiqqanlarni olib tashlaymiz (FK xatosi bo'lmasin)
  const current = new Set((await projectMembers(d.project_id)).map((m) => m.user_id));
  const rows = p.assignee_ids.filter((id) => current.has(id))
    .map((uid) => ({ task_id: task.id, project_id: d.project_id, user_id: uid }));
  if (rows.length) {
    const { error: e2 } = await db.from('task_assignees').insert(rows);
    if (e2) console.error('assignees', e2);
  }
  return { ok: true, column: col.title as string, title: p.title };
}

// deno-lint-ignore no-explicit-any
async function handleCallback(q: any) {
  const chat_id: number = q.message?.chat?.id;
  const [kind, id] = String(q.data || '').split(':');
  const link = await getLink(chat_id);
  if (!link) {
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Hisob ulanmagan' });
    return;
  }
  if (kind === 'p') {
    if (!(await isMember(id, link.user_id))) {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Ruxsat yo\'q' });
      return;
    }
    await db.from('telegram_links').update({ default_project_id: id }).eq('user_id', link.user_id);
    const name = (await userProjects(link.user_id)).find((p) => p.id === id)?.name ?? '';
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Saqlandi' });
    await tg('editMessageText', {
      chat_id, message_id: q.message.message_id, parse_mode: 'HTML',
      text: `Loyiha: <b>${esc(name)}</b> ✅\n\nEndi ovozli yoki matnli xabar yuboring.`,
    });
    return;
  }
  if (kind === 'x') {
    await db.from('telegram_drafts').delete().eq('id', id).eq('user_id', link.user_id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Bekor qilindi' });
    await tg('editMessageReplyMarkup', { chat_id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (kind === 'c') {
    const r = await createTaskFromDraft(id, link.user_id);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? 'Yaratildi' : r.error });
    await tg('editMessageReplyMarkup', { chat_id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (r.ok) await send(chat_id, `✅ Vazifa "${esc(r.title!)}" — <b>${esc(r.column!)}</b> ustuniga qo'shildi.\n${SITE_URL}`);
  }
}

// deno-lint-ignore no-explicit-any
async function handleUpdate(u: any) {
  const from = u.callback_query?.from ?? u.message?.from;
  if (!isAllowed(from?.id)) {
    if (u.callback_query) return tg('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Ruxsat yo\'q' });
    if (u.message?.chat?.type === 'private') {
      return send(u.message.chat.id, `⛔ Sizga ruxsat berilmagan.\nID: <code>${from?.id}</code> — uni administratorga yuboring.`);
    }
    return;
  }
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m || m.chat?.type !== 'private') return; // guruhlarda ishlamaydi (xavfsizlik)
  const chat_id: number = m.chat.id;
  const text: string = (m.text ?? '').trim();

  if (text.startsWith('/start')) return handleStart(chat_id, text.split(/\s+/)[1] ?? '', m.from?.username);

  const link = await getLink(chat_id);
  if (!link) return send(chat_id, NOT_LINKED);

  if (text === '/loyiha') return askProject(chat_id, link.user_id);
  if (text === '/uzish') {
    await db.from('telegram_links').delete().eq('user_id', link.user_id);
    return send(chat_id, 'Hisob uzildi.');
  }

  const audio = m.voice ?? m.audio;
  if (audio) {
    if ((audio.duration ?? 0) > MAX_VOICE_SEC) return send(chat_id, `Ovozli xabar ${MAX_VOICE_SEC / 60} daqiqadan oshmasin.`);
    await tg('sendChatAction', { chat_id, action: 'typing' });
    const blob = await downloadTgFile(audio.file_id);
    const transcript = await transcribe(blob, m.voice ? 'voice.ogg' : (audio.file_name ?? 'audio.mp3'));
    if (!transcript) return send(chat_id, 'Ovozni tanib bo\'lmadi. Aniqroq gapirib qayta yuboring.');
    return handleIncomingTask(chat_id, link, transcript, true);
  }
  if (text && !text.startsWith('/')) return handleIncomingTask(chat_id, link, text, false);
  return send(chat_id, 'Ovozli yoki matnli xabar yuboring.\n/loyiha — loyihani tanlash\n/uzish — hisobni uzish');
}

// ---------- Entry ----------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  // deno-lint-ignore no-explicit-any
  let u: any;
  try { u = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  // Telegram qayta yuborsa — takrorlamaymiz
  const { error: dup } = await db.from('telegram_updates').insert({ update_id: u.update_id });
  if (dup) return new Response('dup');

  const work = (async () => {
    try {
      await handleUpdate(u);
    } catch (e) {
      console.error('handleUpdate', e);
      const chat_id = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
      if (chat_id) await send(chat_id, 'Xatolik yuz berdi, birozdan keyin qayta urinib ko\'ring.');
    }
  })();
  // Telegram'ga darhol 200 qaytaramiz, ish fonda davom etadi
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return new Response('ok');
});
