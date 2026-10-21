(() => {
'use strict';

const { supabaseUrl, supabaseAnonKey } = window.VAZIFA_CONFIG;
const sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

// ---------- utils ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = n => { const d = new Date(); d.setDate(d.getDate()+n); return ymd(d); };
const today = () => ymd(new Date());
const MONTHS = ['yan','fev','mar','apr','may','iyn','iyl','avg','sen','okt','noy','dek'];
const PROJECT_COLORS = ['#0E7457','#3C5BA9','#B5482F','#8A5A12','#6B4FA3'];
const AV_COLORS = ['#0E7457','#B5482F','#3C5BA9','#8A5A12','#6B4FA3','#2F7F8A'];
const PRIO_LABEL = {high:'Yuqori', mid:"O'rta", low:'Past'};
const STEP = 1000;
const ACTIVE_KEY = 'vazifa-active-project';
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k, v); } catch {} },
};

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function fail(err, fallback = 'Xatolik yuz berdi') {
  console.error(err);
  toast(err?.message ? `${fallback}: ${err.message}` : fallback);
}

// ---------- state ----------
const S = {
  user: null,
  projects: [],
  activeId: null,
  members: [],   // [{user_id, role, profile:{id,email,full_name,avatar_url}}]
  columns: [],
  tasks: [],
  msgCounts: {}, // task_id -> xabarlar soni
  assignees: {}, // task_id -> [user_id]
};
// Ochiq vazifa chati
const chat = { taskId: null, messages: [], loading: false, sending: false };
const filter = { q: '', who: '' };
let loadSeq = 0;
let channel = null;
let userChannel = null;

const activeProject = () => S.projects.find(p => p.id === S.activeId) || null;
const myRole = () => S.members.find(m => m.user_id === S.user?.id)?.role || null;
const isOwner = () => myRole() === 'owner';
// Vazifa nomini (va o'chirishni) faqat yaratgan odam boshqaradi; yaratuvchisi yo'q bo'lsa — loyiha egasi
const canEditTitle = t => !t || t.created_by === S.user?.id || (!t.created_by && isOwner());
const whoOf = id => S.assignees[id] || [];
// Vazifani faqat uni yaratgan odam o'chiradi; yaratuvchisi yo'q (hisobi o'chgan) bo'lsa — loyiha egasi
const canDeleteTask = t => !!t && (t.created_by === S.user?.id || (!t.created_by && isOwner()));
const profileOf = id => S.members.find(m => m.user_id === id)?.profile || null;
const colTasks = colId => S.tasks.filter(t => t.column_id === colId).sort((a, b) => a.position - b.position);
const displayName = p => p?.full_name || p?.email?.split('@')[0] || 'Foydalanuvchi';

function avatarHTML(profile, cls = 'av') {
  if (!profile) return `<span class="${cls} none" title="Mas'ul tayinlanmagan">?</span>`;
  const name = displayName(profile);
  const url = profile.avatar_url && /^https:\/\//.test(profile.avatar_url) ? profile.avatar_url : '';
  const color = AV_COLORS[[...profile.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];
  const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="${cls}" style="background:${color}" title="${esc(name)}">${
    url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : esc(initials)}</span>`;
}

// ---------- views ----------
function show(view) {
  $('#viewLoading').hidden = view !== 'loading';
  $('#viewLogin').hidden = view !== 'login';
  $('#viewApp').hidden = view !== 'app';
}

// ---------- auth ----------
// Primary: Google Identity Services button on our own origin → ID token → Supabase.
// The consent dialog shows this site's domain instead of the Supabase project URL.
const GOOGLE_CLIENT_ID = window.VAZIFA_CONFIG.googleClientId;
let rawNonce = null;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomNonce() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[^a-zA-Z0-9]/g, '');
}

async function onGoogleCredential(resp) {
  $('#loginErr').textContent = '';
  const nonce = rawNonce;
  const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce });
  if (error) { $('#loginErr').textContent = error.message; renderGsiButton(); }
  // success → onAuthStateChange takes over
}

let gsiWait = 0;
async function renderGsiButton() {
  const slot = $('#gsiBtn');
  if (!window.google?.accounts?.id) {
    // GIS script still loading; after ~6s assume blocked and show redirect fallback
    if (++gsiWait > 30) { slot.hidden = true; $('#googleBtn').hidden = false; return; }
    return setTimeout(renderGsiButton, 200);
  }
  const nonce = randomNonce();
  rawNonce = nonce;
  const hashed = await sha256Hex(nonce);
  if (rawNonce !== nonce) return; // a newer render superseded this one
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: onGoogleCredential,
    nonce: hashed, // Google gets the hash, Supabase verifies with the raw value
    ux_mode: 'popup',
    use_fedcm_for_prompt: true,
    itp_support: true,
  });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  slot.innerHTML = '';
  google.accounts.id.renderButton(slot, {
    type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large',
    text: 'signin_with', shape: 'pill', logo_alignment: 'center',
    width: Math.min(320, slot.clientWidth || 320),
  });
}

// Fallback: classic OAuth redirect via Supabase (used only if GIS fails to load)
$('#googleBtn').addEventListener('click', async () => {
  const btn = $('#googleBtn');
  btn.disabled = true; $('#loginErr').textContent = '';
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } },
  });
  if (error) { btn.disabled = false; $('#loginErr').textContent = error.message; }
});

async function logout() {
  $('#menu').hidden = true;
  teardownRealtime();
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
  await sb.auth.signOut();
}

let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  // Callback must stay synchronous; defer async work (supabase-js deadlock guidance).
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  const user = session?.user || null;
  if (!user) {
    S.user = null; booted = false; teardownRealtime();
    // surface OAuth errors returned in the URL
    const params = new URLSearchParams(location.search + location.hash.replace(/^#/, '&'));
    const err = params.get('error_description');
    if (err) { $('#loginErr').textContent = err; history.replaceState(null, '', location.pathname); }
    $('#googleBtn').disabled = false;
    show('login');
    renderGsiButton();
    return;
  }
  if (booted && S.user?.id === user.id) { S.user = user; return; } // token refresh
  S.user = user; booted = true;
  if (location.search.includes('code=') || location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  show('loading');
  renderMe();
  subscribeUser();
  await loadProjects(store.get(ACTIVE_KEY));
  show('app');
}

function renderMe() {
  const meta = S.user.user_metadata || {};
  const p = { id: S.user.id, email: S.user.email, full_name: meta.full_name || meta.name, avatar_url: meta.avatar_url || meta.picture };
  $('#meBtn').innerHTML = avatarHTML(p);
  $('#menuWho').innerHTML = `${esc(displayName(p))}<small>${esc(p.email)}</small>`;
}

// ---------- data loading ----------
async function loadProjects(preferId) {
  const { data, error } = await sb.from('projects').select('id,name,color,owner_id,created_at').order('created_at');
  if (error) return fail(error, 'Loyihalarni yuklab bo\'lmadi');
  S.projects = data;
  const target = data.find(p => p.id === (preferId || S.activeId)) || data[0] || null;
  await selectProject(target?.id || null);
}

async function selectProject(id) {
  S.activeId = id;
  if (id) store.set(ACTIVE_KEY, id);
  renderTabs();
  const has = !!id;
  $('#noProjects').hidden = has;
  $('#board').hidden = !has; $('#sub').hidden = !has;
  ['#q', '#who', '#newTask'].forEach(s => { $(s).disabled = !has; $(s).hidden = !has; });
  if (!has) { teardownProjectChannel(); return; }
  await loadBoard();
  subscribeProject(id);
}

async function loadBoard() {
  const id = S.activeId; if (!id) return;
  const seq = ++loadSeq;
  const [m, c, t, n, a] = await Promise.all([
    sb.from('project_members').select('user_id, role, profile:profiles(id,email,full_name,avatar_url)').eq('project_id', id),
    sb.from('columns').select('*').eq('project_id', id).order('position'),
    sb.from('tasks').select('*').eq('project_id', id).order('position'),
    sb.rpc('task_message_counts', { p_project: id }),
    sb.from('task_assignees').select('task_id,user_id,created_at').eq('project_id', id).order('created_at'),
  ]);
  if (seq !== loadSeq || id !== S.activeId) return; // stale response
  const error = m.error || c.error || t.error;
  if (error) return fail(error, 'Board\'ni yuklab bo\'lmadi');
  S.members = m.data; S.columns = c.data; S.tasks = t.data;
  if (!n.error) S.msgCounts = Object.fromEntries(n.data.map(r => [r.task_id, Number(r.n)]));
  if (!a.error) { S.assignees = {}; a.data.forEach(r => (S.assignees[r.task_id] ||= []).push(r.user_id)); }
  render();
}

// ---------- realtime ----------
let reloadTimer = null;
let pendingReload = false;
function scheduleReload() {
  if (drag?.active || $('#taskDlg').open) { pendingReload = true; return; }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadBoard, 250);
}
function flushPendingReload() {
  if (pendingReload) { pendingReload = false; scheduleReload(); }
}

function subscribeProject(id) {
  teardownProjectChannel();
  const f = `project_id=eq.${id}`;
  channel = sb.channel(`project-${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: f }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'columns', filter: f }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members', filter: f }, onMembersChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${id}` }, p => {
      const x = S.projects.find(q => q.id === p.new?.id); if (!x) return;
      Object.assign(x, { name: p.new.name, color: p.new.color }); render();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_messages', filter: f }, p => onMessageInsert(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_assignees', filter: f }, scheduleReload)
    // DELETE'da filter ishlamaydi: faqat o'z vazifalarimizga tegishlisini olamiz
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'task_assignees' },
        p => { if (S.tasks.some(t => t.id === p.old?.task_id)) scheduleReload(); })
    // DELETE hodisalarida Realtime filter ishlamaydi va faqat id keladi: o'zimiz tekshiramiz
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'task_messages' }, p => onMessageDelete(p.old?.id))
    .subscribe(status => { $('#sync').classList.toggle('off', status !== 'SUBSCRIBED'); });
}
async function onMembersChange(payload) {
  // If I was removed from the active project, go back to the project list.
  if (payload.eventType === 'DELETE' && payload.old?.user_id === S.user.id) {
    toast('Siz loyihadan chiqarildingiz');
    return loadProjects();
  }
  scheduleReload();
}
function subscribeUser() {
  if (userChannel) sb.removeChannel(userChannel);
  userChannel = sb.channel(`user-${S.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'project_members', filter: `user_id=eq.${S.user.id}` },
        () => loadProjects())
    .subscribe();
}
function teardownProjectChannel() { if (channel) { sb.removeChannel(channel); channel = null; } }
function teardownRealtime() {
  teardownProjectChannel();
  if (userChannel) { sb.removeChannel(userChannel); userChannel = null; }
}

// ---------- rendering ----------
const matches = t => {
  if (filter.who && (filter.who === '_none' ? whoOf(t.id).length : !whoOf(t.id).includes(filter.who))) return false;
  if (!filter.q) return true;
  const q = filter.q.toLowerCase();
  return t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.tags.some(g => g.toLowerCase().includes(q));
};

function dueInfo(due, done) {
  if (!due) return '';
  const [y, m, d] = due.split('-').map(Number);
  const now = today();
  let cls = '', label = `${d} ${MONTHS[m-1]}`;
  if (!done) {
    if (due < now) cls = 'late';
    else if (due === now) { cls = 'today'; label = 'Bugun'; }
    else if (due === addDays(1)) label = 'Ertaga';
  }
  if (y !== new Date().getFullYear()) label += ` ${y}`;
  return `<span class="due ${cls}">${label}</span>`;
}

function cardHTML(t, done) {
  return `<article class="card${done ? ' done' : ''}" data-id="${t.id}" tabindex="0" aria-label="${esc(t.title)}">
    <button class="grip" type="button" aria-label="Ko'chirish" tabindex="-1"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.2"/><circle cx="8" cy="2.5" r="1.2"/><circle cx="4" cy="6" r="1.2"/><circle cx="8" cy="6" r="1.2"/><circle cx="4" cy="9.5" r="1.2"/><circle cx="8" cy="9.5" r="1.2"/></svg></button>
    ${t.tags.length ? `<div class="tags">${t.tags.map(g => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
    <div class="title">${esc(t.title)}</div>
    <div class="meta">
      ${t.priority ? `<span class="prio ${t.priority}">${PRIO_LABEL[t.priority]}</span>` : ''}
      ${dueInfo(t.due_date, done)}
      ${t.description ? `<span class="desc-flag" title="Tavsif bor">≡</span>` : ''}
      ${msgFlag(t.id)}
      ${avatarsHTML(t.id)}
    </div>
  </article>`;
}

function avatarsHTML(taskId) { return avatarStack(whoOf(taskId)); }
function avatarStack(all) {
  const ids = all.filter(id => profileOf(id));
  if (!ids.length) return `<span class="avs">${avatarHTML(null)}</span>`;
  const shown = ids.slice(0, 3), extra = ids.length - shown.length;
  // row-reverse: birinchisi eng o'ngda emas, chapda ko'rinsin
  return `<span class="avs" title="${esc(ids.map(id => displayName(profileOf(id))).join(', '))}">${
    extra ? `<span class="more">+${extra}</span>` : ''}${shown.slice().reverse().map(id => avatarHTML(profileOf(id))).join('')}</span>`;
}
function msgFlag(taskId) {
  const n = S.msgCounts[taskId] || 0;
  return n ? `<span class="msg-flag" data-msgs="${taskId}" title="${n} ta xabar">💬 ${n}</span>` : '';
}
// Board'ni qayta chizmasdan bitta kartochkadagi xabarlar sonini yangilash (drag paytida ham xavfsiz)
function patchCardCount(taskId) {
  const card = document.querySelector(`.card[data-id="${taskId}"]`); if (!card) return;
  card.querySelector('.msg-flag')?.remove();
  const html = msgFlag(taskId); if (!html) return;
  const av = card.querySelector('.meta .av');
  av ? av.insertAdjacentHTML('beforebegin', html) : card.querySelector('.meta')?.insertAdjacentHTML('beforeend', html);
}

function renderTabs() {
  $('#tabs').innerHTML = S.projects.map(x =>
    `<button class="tab" role="tab" data-pid="${x.id}" aria-selected="${x.id === S.activeId}"><span class="dot" style="background:${esc(x.color)}"></span>${esc(x.name)}</button>`
  ).join('') + `<button class="tab" id="addProject" aria-label="Yangi loyiha">+ Loyiha</button>`;
}

function render() {
  const p = activeProject(); if (!p) return;
  renderTabs();
  $('#pname').textContent = p.name;

  const doneCols = new Set(S.columns.filter(c => c.is_done).map(c => c.id));
  const open = S.tasks.filter(t => !doneCols.has(t.column_id));
  const late = open.filter(t => t.due_date && t.due_date < today()).length;
  $('#stats').innerHTML =
    `<span>${S.tasks.length} vazifa</span><span>${S.tasks.length - open.length} bajarildi</span>` +
    (late ? `<span class="bad">${late} muddati o'tgan</span>` : '');

  const filtering = !!(filter.q || filter.who);
  const owner = isOwner();
  $('#mEditProj').hidden = !owner;
  $('#board').innerHTML = S.columns.map(c => {
    const all = colTasks(c.id), vis = all.filter(matches);
    return `<section class="col" data-col="${c.id}">
      <div class="col-head">
        <input class="col-title" value="${esc(c.title)}" maxlength="40" aria-label="Ustun nomi" id="ct-${c.id}"${owner ? '' : ' readonly tabindex="-1" title="Ustunlarni faqat loyiha egasi o\'zgartiradi"'}>
        <span class="count">${filtering ? `${vis.length}/${all.length}` : all.length}</span>
        ${owner ? `<button class="icon-btn" data-act="del-col" aria-label="Ustunni o'chirish" title="Ustunni o'chirish">×</button>` : ''}
      </div>
      <div class="list" data-col="${c.id}">
        ${vis.length ? vis.map(t => cardHTML(t, c.is_done)).join('') : `<div class="empty">${all.length ? 'Filtrga mos vazifa yo\'q' : 'Bu yerga vazifa torting'}</div>`}
      </div>
      <div class="col-foot"><button class="add-task" data-act="quick">+ Vazifa qo'shish</button></div>
    </section>`;
  }).join('') + (owner ? `<button class="add-col" id="addCol">+ Ustun qo'shish</button>` : '');

  const whoSel = $('#who');
  whoSel.innerHTML = `<option value="">Hamma</option>` +
    S.members.map(m => `<option value="${m.user_id}">${esc(displayName(m.profile))}</option>`).join('') +
    `<option value="_none">Tayinlanmagan</option>`;
  if (filter.who && filter.who !== '_none' && !S.members.some(m => m.user_id === filter.who)) filter.who = '';
  whoSel.value = filter.who;
}

// ---------- mutations ----------
function nextPosition(colId) {
  const list = colTasks(colId);
  return list.length ? list[list.length - 1].position + STEP : STEP;
}

async function createTask(colId, data) {
  const row = { project_id: S.activeId, column_id: colId, position: nextPosition(colId), ...data };
  const { data: created, error } = await sb.from('tasks').insert(row).select().single();
  if (error) return fail(error, 'Vazifa qo\'shilmadi');
  if (!S.tasks.some(t => t.id === created.id)) S.tasks.push(created);
  render();
  return created;
}

async function updateTask(id, patch) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  const prev = { ...t };
  Object.assign(t, patch); render();
  const { error } = await sb.from('tasks').update(patch).eq('id', id);
  if (error) { Object.assign(t, prev); render(); fail(error, 'Saqlanmadi'); }
}

async function deleteTask(id) {
  const i = S.tasks.findIndex(t => t.id === id); if (i < 0) return;
  if (!canDeleteTask(S.tasks[i])) return toast("Vazifani faqat uni yaratgan odam o'chira oladi");
  const [removed] = S.tasks.splice(i, 1); render();
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) { S.tasks.push(removed); render(); fail(error, 'O\'chirilmadi'); }
  else toast("Vazifa o'chirildi");
}

// Fractional positioning: place moved task between neighbours; rebalance the column if gaps run out.
async function moveTask(id, toColId, beforeId) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  const list = colTasks(toColId).filter(x => x.id !== id);
  let idx = beforeId ? list.findIndex(x => x.id === beforeId) : -1;
  if (idx < 0) idx = list.length;
  const prev = list[idx - 1], next = list[idx];
  let pos;
  if (prev && next) pos = (prev.position + next.position) / 2;
  else if (next) pos = next.position - STEP;
  else if (prev) pos = prev.position + STEP;
  else pos = STEP;

  const fromDone = S.columns.find(c => c.id === t.column_id)?.is_done;
  const toDone = S.columns.find(c => c.id === toColId)?.is_done;

  const needsRebalance = prev && next && (next.position - prev.position) < 1e-6;
  if (needsRebalance) {
    list.splice(idx, 0, t);
    const updates = list.map((x, i) => ({ id: x.id, position: (i + 1) * STEP }));
    t.column_id = toColId;
    updates.forEach(u => { S.tasks.find(x => x.id === u.id).position = u.position; });
    render();
    const results = await Promise.all(updates.map(u =>
      sb.from('tasks').update(u.id === id ? { position: u.position, column_id: toColId } : { position: u.position }).eq('id', u.id)));
    const err = results.find(r => r.error)?.error;
    if (err) { fail(err, 'Ko\'chirilmadi'); loadBoard(); }
  } else {
    await updateTask(id, { column_id: toColId, position: pos });
  }
  if (toDone && !fromDone) toast('Bajarildi ✓');
}

async function addColumn(title) {
  const last = S.columns[S.columns.length - 1];
  const { data, error } = await sb.from('columns')
    .insert({ project_id: S.activeId, title, position: last ? last.position + STEP : STEP }).select().single();
  if (error) return fail(error, 'Ustun qo\'shilmadi');
  if (!S.columns.some(c => c.id === data.id)) S.columns.push(data);
  render();
}

async function renameColumn(id, title) {
  if (!isOwner()) return;
  const c = S.columns.find(x => x.id === id); if (!c || c.title === title) return;
  const old = c.title; c.title = title;
  const { error } = await sb.from('columns').update({ title }).eq('id', id);
  if (error) { c.title = old; render(); fail(error, 'Nom saqlanmadi'); }
}

async function deleteColumn(id) {
  if (!isOwner()) return;
  if (colTasks(id).length) return toast('Avval ustundagi vazifalarni ko\'chiring');
  const i = S.columns.findIndex(c => c.id === id);
  const [removed] = S.columns.splice(i, 1); render();
  const { error } = await sb.from('columns').delete().eq('id', id);
  if (error) { S.columns.splice(i, 0, removed); render(); fail(error, 'Ustun o\'chirilmadi'); }
}

async function createProject(name) {
  const color = PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length];
  const { data: id, error } = await sb.rpc('create_project', { p_name: name, p_color: color });
  if (error) return fail(error, 'Loyiha yaratilmadi');
  await loadProjects(id);
  show('app');
}

// ---------- quick add ----------
function openQuick(colEl) {
  const colId = colEl.dataset.col;
  const foot = colEl.querySelector('.col-foot');
  foot.innerHTML = `<textarea class="quick" placeholder="Vazifa nomi…" maxlength="200" aria-label="Yangi vazifa nomi"></textarea><div class="hint">Enter — qo'shish, Esc — bekor</div>`;
  const ta = foot.querySelector('textarea');
  ta.focus();
  let busy = false;
  const commit = async () => {
    const title = ta.value.trim();
    if (!title || busy) return false;
    busy = true; ta.value = '';
    await createTask(colId, { title });
    busy = false;
    return true;
  };
  ta.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (await commit()) { const el = document.querySelector(`.col[data-col="${colId}"]`); if (el) openQuick(el); }
    } else if (e.key === 'Escape') render();
  });
  ta.addEventListener('blur', () => setTimeout(async () => {
    if (!document.body.contains(ta)) return;
    const added = await commit();
    if (!added) render();
  }, 150));
}

// ---------- task dialog ----------
const dlg = $('#taskDlg');
let editing = null;

let picked = new Set();
// Mas'ullar: select ko'rinishidagi tugma + bosilganda ochiladigan ro'yxat (bir nechta tanlash)
function renderWhoValue() {
  const ids = S.members.map(m => m.user_id).filter(id => picked.has(id)); // a'zolar tartibida
  $('#fWhoVal').innerHTML = ids.length
    ? `${avatarStack(ids)}<span class="who-names">${esc(ids.map(id => displayName(profileOf(id))).join(', '))}</span>`
    : `<span class="who-none">Tanlanmagan</span>`;
}
function renderWhoPick() {
  $('#fWho').innerHTML = S.members.map(m => `<button type="button" class="who-opt" role="option" data-uid="${m.user_id}" aria-selected="${picked.has(m.user_id)}">
    <span class="chk" aria-hidden="true"></span>${avatarHTML(m.profile)}<span class="nm">${esc(displayName(m.profile))}${m.user_id === S.user.id ? ' (siz)' : ''}</span></button>`).join('');
  renderWhoValue();
}
function toggleWhoList(open) {
  const list = $('#fWho'), btn = $('#fWhoBtn');
  open ??= list.hidden;
  list.hidden = !open; btn.setAttribute('aria-expanded', open);
  if (open) (list.querySelector('[aria-selected="true"]') || list.querySelector('.who-opt'))?.focus();
}
$('#fWhoBtn').addEventListener('click', () => toggleWhoList());
$('#fWho').addEventListener('click', e => {
  const b = e.target.closest('[data-uid]'); if (!b) return;
  const id = b.dataset.uid; picked.has(id) ? picked.delete(id) : picked.add(id);
  b.setAttribute('aria-selected', picked.has(id));
  renderWhoValue();
});
$('#fWho').addEventListener('keydown', e => {
  const opts = [...$('#fWho').querySelectorAll('.who-opt')], i = opts.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); opts.at((i + (e.key === 'ArrowDown' ? 1 : -1)) % opts.length)?.focus(); }
  else if (e.key === 'Escape' || e.key === 'Tab') {
    if (e.key === 'Escape') e.preventDefault(); // dialog yopilib ketmasin
    toggleWhoList(false); if (e.key === 'Escape') $('#fWhoBtn').focus();
  }
});
document.addEventListener('pointerdown', e => {
  if (!$('#fWho').hidden && !e.target.closest('.who-field')) toggleWhoList(false);
});
function fillSelects(colId, who = []) {
  $('#fCol').innerHTML = S.columns.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
  $('#fCol').value = colId;
  picked = new Set(who.filter(id => S.members.some(m => m.user_id === id)));
  renderWhoPick(); toggleWhoList(false);
}
function setTitleLock(locked) {
  $('#fTitle').readOnly = locked; $('#fTitleHint').hidden = !locked;
}
// Mas'ullar ro'yxatini serverda farq bo'yicha yangilash
async function saveAssignees(taskId, next) {
  const prev = new Set(whoOf(taskId));
  const add = [...next].filter(id => !prev.has(id)), del = [...prev].filter(id => !next.has(id));
  S.assignees[taskId] = [...next]; render();
  const ops = [];
  if (add.length) ops.push(sb.from('task_assignees').insert(add.map(user_id => ({ task_id: taskId, project_id: S.activeId, user_id }))));
  if (del.length) ops.push(sb.from('task_assignees').delete().eq('task_id', taskId).in('user_id', del));
  const err = (await Promise.all(ops)).find(r => r.error)?.error;
  if (err) { S.assignees[taskId] = [...prev]; render(); fail(err, "Mas'ullar saqlanmadi"); }
}

function openTask(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  editing = { id };
  fillSelects(t.column_id, whoOf(id));
  $('#fTitle').value = t.title;
  setTitleLock(!canEditTitle(t));
  $('#fDesc').value = t.description;
  $('#fDue').value = t.due_date || '';
  $('#fPrio').value = t.priority || '';
  $('#fTags').value = t.tags.join(', ');
  $('#delTask').hidden = !canDeleteTask(t);
  resetDelete();
  dlg.showModal();
  openChat(id);
}

function openNewTask() {
  if (!S.columns.length) return toast('Avval ustun qo\'shing');
  editing = { newIn: S.columns[0].id };
  fillSelects(S.columns[0].id);
  ['#fTitle', '#fDesc', '#fDue', '#fTags'].forEach(s => $(s).value = '');
  setTitleLock(false);
  $('#fPrio').value = '';
  $('#delTask').hidden = true;
  closeChat();
  dlg.showModal();
  $('#fTitle').focus();
}

$('#taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('#fTitle').value.trim();
  if (!title) return $('#fTitle').focus();
  const data = {
    title,
    description: $('#fDesc').value.trim(),
    due_date: $('#fDue').value || null,
    priority: $('#fPrio').value || null,
    tags: [...new Set($('#fTags').value.split(',').map(s => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 6),
  };
  const colId = $('#fCol').value;
  const ed = editing, who = new Set(picked);
  dlg.close();
  if (ed.id) {
    const t = S.tasks.find(x => x.id === ed.id);
    if (t && !canEditTitle(t)) delete data.title; // nomni faqat yaratuvchi o'zgartiradi
    if (t && t.column_id !== colId) { data.column_id = colId; data.position = nextPosition(colId); }
    await Promise.all([updateTask(ed.id, data), saveAssignees(ed.id, who)]);
    toast('Saqlandi');
  } else {
    const created = await createTask(colId, data);
    if (created && who.size) await saveAssignees(created.id, who);
    if (created) toast('Vazifa qo\'shildi');
  }
});

let delArmed = false;
const resetDelete = () => { delArmed = false; $('#delTask').textContent = "O'chirish"; $('#delTask').classList.remove('armed'); };
$('#delTask').addEventListener('click', () => {
  if (!delArmed) { delArmed = true; $('#delTask').textContent = 'Tasdiqlash'; $('#delTask').classList.add('armed'); return; }
  const id = editing.id; dlg.close(); deleteTask(id);
});
$('#cancelTask').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { resetDelete(); closeChat(); flushPendingReload(); });
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
// Esc: avval mas'ullar ro'yxati yopilsin, dialog emas
dlg.addEventListener('cancel', e => { if (!$('#fWho').hidden) { e.preventDefault(); toggleWhoList(false); $('#fWhoBtn').focus(); } });

// ---------- task chat ----------
const chatList = $('#chatList');
const chatInput = $('#chatInput');

function authorProfile(uid) {
  if (uid && uid === S.user?.id) {
    const meta = S.user.user_metadata || {};
    return { id: S.user.id, email: S.user.email, full_name: meta.full_name || meta.name, avatar_url: meta.avatar_url || meta.picture };
  }
  return profileOf(uid);
}

function msgTime(iso) {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (ymd(d) === today()) return hm;
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}, ${hm}`;
}

// ---- rasmlar: yopiq bucket, ko'rish uchun vaqtinchalik (1 soat) havola
const BUCKET = 'task-files';
const MAX_RAW = 15 * 1024 * 1024;   // tanlangan fayl
const MAX_UP = 5 * 1024 * 1024;     // bucket limiti
const urlCache = new Map();         // path -> { url, exp }

async function signUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter(p => p && !(urlCache.get(p)?.exp > now + 60e3));
  if (!need.length) return;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
  if (error) return console.error(error);
  data.forEach(d => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3600e3 }); });
}

function imageHTML(m) {
  if (!m.image_path && !m.localUrl) return '';
  const url = m.localUrl || urlCache.get(m.image_path)?.url;
  const ratio = m.image_w && m.image_h ? `aspect-ratio:${m.image_w}/${m.image_h}` : '';
  if (!url) return `<span class="msg-img"><span class="ph" style="${ratio}"></span></span>`;
  return `<a class="msg-img" href="${esc(url)}" target="_blank" rel="noopener" title="Kattalashtirish">
    <img src="${esc(url)}" alt="Biriktirilgan rasm" loading="lazy" ${m.image_w ? `width="${m.image_w}" height="${m.image_h}"` : ''}></a>`;
}

// Katta rasmni brauzerda kichraytiramiz (≤1600px, JPEG): tez yuklanadi, Storage limitini tejaydi
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('Faqat JPG, PNG, WEBP yoki GIF rasm');
  if (file.size > MAX_RAW) throw new Error('Rasm juda katta (15 MB gacha)');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width: w0, height: h0 } = bmp;
  if (file.type === 'image/gif') {
    bmp.close?.();
    if (file.size > MAX_UP) throw new Error('GIF 5 MB dan oshmasin');
    return { blob: file, ext: 'gif', type: 'image/gif', w: w0, h: h0 };
  }
  const k = Math.min(1, 1600 / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG shaffofligi qora bo'lib qolmasin
  ctx.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const toBlob = q => new Promise(r => cv.toBlob(r, 'image/jpeg', q));
  let blob = await toBlob(0.85);
  if (blob && blob.size > MAX_UP) blob = await toBlob(0.65);
  if (!blob || blob.size > MAX_UP) throw new Error('Rasmni siqib bo\'lmadi');
  return { blob, ext: 'jpg', type: 'image/jpeg', w, h };
}

let attach = null; // { blob, ext, type, w, h, localUrl }
function clearAttach() {
  if (attach?.localUrl && !attach.sent) URL.revokeObjectURL(attach.localUrl);
  attach = null; $('#chatAttach').hidden = true; $('#chatFile').value = '';
}
async function setAttach(file) {
  if (!chat.taskId) return;
  try {
    $('#chatAttachInfo').textContent = 'Tayyorlanmoqda…'; $('#chatAttach').hidden = false;
    const img = await prepareImage(file);
    clearAttach();
    attach = { ...img, localUrl: URL.createObjectURL(img.blob) };
    $('#chatAttachImg').src = attach.localUrl;
    $('#chatAttachInfo').textContent = `${img.w}×${img.h} · ${(img.blob.size / 1024).toFixed(0)} KB`;
    $('#chatAttach').hidden = false;
    chatInput.focus();
  } catch (err) { clearAttach(); toast(err.message || 'Rasm qo\'shilmadi'); }
}

function renderChat({ stick = false } = {}) {
  const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
  const n = chat.messages.filter(m => !m.pending).length;
  $('#chatCount').textContent = n ? `${n}` : '';
  if (chat.loading) { chatList.innerHTML = `<div class="chat-empty"><div class="spin"></div></div>`; return; }
  if (!chat.messages.length) {
    chatList.innerHTML = `<div class="chat-empty">Hali xabar yo'q.<br>Vazifa bo'yicha savol yoki yangilikni shu yerda yozing.</div>`;
    return;
  }
  const owner = myRole() === 'owner';
  chatList.innerHTML = chat.messages.map(m => {
    const mine = m.user_id === S.user.id;
    const p = authorProfile(m.user_id);
    const canDel = !m.pending && (mine || owner);
    return `<div class="msg${mine ? ' mine' : ''}${m.pending ? ' pending' : ''}" data-mid="${m.id}">
      ${avatarHTML(p || { id: m.user_id || '0', full_name: "Sobiq a'zo" })}
      <div class="msg-body">
        <div class="msg-top"><b>${esc(p ? displayName(p) : "Sobiq a'zo")}</b><time datetime="${esc(m.created_at)}">${m.pending ? 'yuborilmoqda…' : msgTime(m.created_at)}</time>
          ${canDel ? `<button type="button" class="icon-btn" data-del-msg="${m.id}" aria-label="Xabarni o'chirish" title="O'chirish">×</button>` : ''}</div>
        ${m.body ? `<div class="msg-text">${esc(m.body)}</div>` : ''}
        ${imageHTML(m)}
      </div>
    </div>`;
  }).join('');
  if (stick || atBottom) chatList.scrollTop = chatList.scrollHeight;
}

async function openChat(taskId) {
  chat.taskId = taskId; chat.messages = []; chat.loading = true;
  $('#chat').hidden = false; dlg.classList.add('with-chat');
  chatInput.value = ''; autoGrow();
  renderChat();
  const { data, error } = await sb.from('task_messages')
    .select('id,task_id,user_id,body,created_at,image_path,image_w,image_h').eq('task_id', taskId)
    .order('created_at', { ascending: false }).limit(200);
  if (chat.taskId !== taskId) return; // boshqa vazifa ochildi
  chat.loading = false;
  if (error) { renderChat(); return fail(error, 'Chat yuklanmadi'); }
  // Realtime orqali yuklash paytida kelganlarni saqlab qolamiz
  const extra = chat.messages.filter(m => !data.some(d => d.id === m.id));
  chat.messages = [...data.reverse(), ...extra];
  await signUrls(chat.messages.map(m => m.image_path));
  if (chat.taskId !== taskId) return;
  renderChat({ stick: true });
}

function closeChat() {
  clearAttach();
  chat.messages.forEach(m => m.localUrl && URL.revokeObjectURL(m.localUrl));
  chat.taskId = null; chat.messages = []; chat.loading = false;
  $('#chat').hidden = true; dlg.classList.remove('with-chat');
}

const countedMsgs = new Set(); // har bir xabar soniga faqat bir marta qo'shiladi
function onMessageInsert(m) {
  if (!m || m.project_id !== S.activeId || countedMsgs.has(m.id)) return;
  countedMsgs.add(m.id);
  if (chat.taskId === m.task_id && !chat.messages.some(x => x.id === m.id)) {
    // o'zimiz yuborgan, hali "pending" turgan nusxani almashtiramiz
    const p = chat.messages.findIndex(x => x.pending && x.user_id === m.user_id && x.body === m.body && !!x.localUrl === !!m.image_path);
    if (p >= 0) { m.localUrl = chat.messages[p].localUrl; chat.messages[p] = m; } else chat.messages.push(m);
    renderChat();
    if (m.image_path && !m.localUrl) signUrls([m.image_path]).then(() => chat.taskId === m.task_id && renderChat());
  }
  S.msgCounts[m.task_id] = (S.msgCounts[m.task_id] || 0) + 1;
  patchCardCount(m.task_id);
}

function onMessageDelete(id) {
  if (!id) return;
  const i = chat.messages.findIndex(x => x.id === id);
  if (i >= 0) { chat.messages.splice(i, 1); renderChat(); }
  refreshCounts();
}

let countsTimer = null;
function refreshCounts() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async () => {
    const pid = S.activeId; if (!pid) return;
    const { data, error } = await sb.rpc('task_message_counts', { p_project: pid });
    if (error || pid !== S.activeId) return;
    const before = S.msgCounts;
    S.msgCounts = Object.fromEntries(data.map(r => [r.task_id, Number(r.n)]));
    new Set([...Object.keys(before), ...Object.keys(S.msgCounts)]).forEach(patchCardCount);
  }, 300);
}

async function sendMessage() {
  const body = chatInput.value.trim();
  const taskId = chat.taskId, projectId = S.activeId;
  const img = attach;
  if ((!body && !img) || !taskId || chat.sending) return;
  chat.sending = true;
  chatInput.value = ''; autoGrow();
  if (img) { img.sent = true; attach = null; $('#chatAttach').hidden = true; $('#chatFile').value = ''; }
  const tmp = { id: `tmp-${Date.now()}`, task_id: taskId, user_id: S.user.id, body, created_at: new Date().toISOString(),
                pending: true, localUrl: img?.localUrl, image_w: img?.w, image_h: img?.h };
  chat.messages.push(tmp); renderChat({ stick: true });

  const undo = (err, msg) => {
    const i = chat.messages.indexOf(tmp); if (i >= 0) chat.messages.splice(i, 1);
    if (chat.taskId === taskId) {
      chatInput.value = body; autoGrow();
      if (img) { img.sent = false; attach = img; $('#chatAttachImg').src = img.localUrl; $('#chatAttach').hidden = false; }
      renderChat();
    }
    chat.sending = false;
    fail(err, msg);
  };

  let path = null;
  if (img) {
    path = `${projectId}/${taskId}/${crypto.randomUUID()}.${img.ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, img.blob, { contentType: img.type, upsert: false });
    if (up.error) return undo(up.error, 'Rasm yuklanmadi');
  }
  const row = { task_id: taskId, project_id: projectId, body };
  if (path) Object.assign(row, { image_path: path, image_w: img.w, image_h: img.h });
  const { data, error } = await sb.from('task_messages').insert(row).select('id,task_id,user_id,body,created_at,image_path,image_w,image_h').single();
  if (error) {
    if (path) sb.storage.from(BUCKET).remove([path]); // yetim fayl qolmasin
    return undo(error, 'Xabar yuborilmadi');
  }
  chat.sending = false;
  if (chat.taskId !== taskId) return;
  data.localUrl = img?.localUrl;
  const i = chat.messages.indexOf(tmp);
  // Realtime hodisasi avval kelgan bo'lsa, dublikat qoldirmaymiz
  if (chat.messages.some(x => x.id === data.id)) { if (i >= 0) chat.messages.splice(i, 1); }
  else if (i >= 0) chat.messages[i] = data;
  renderChat();
}

function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

$('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
chatInput.addEventListener('input', autoGrow);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$('#chatPick').addEventListener('click', () => $('#chatFile').click());
$('#chatFile').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) setAttach(f); });
$('#chatAttachDel').addEventListener('click', () => { clearAttach(); chatInput.focus(); });
chatInput.addEventListener('paste', e => {
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); setAttach(f); }
});
const chatBox = $('#chat');
chatBox.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chatBox.classList.add('drop'); } });
chatBox.addEventListener('dragleave', e => { if (!chatBox.contains(e.relatedTarget)) chatBox.classList.remove('drop'); });
chatBox.addEventListener('drop', e => {
  chatBox.classList.remove('drop');
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); setAttach(f); }
});

chatList.addEventListener('click', async e => {
  const btn = e.target.closest('[data-del-msg]'); if (!btn) return;
  if (!confirm("Xabar o'chirilsinmi?")) return;
  const id = btn.dataset.delMsg;
  const path = chat.messages.find(m => m.id === id)?.image_path;
  const { error } = await sb.from('task_messages').delete().eq('id', id);
  if (error) return fail(error, "O'chirilmadi");
  if (path) { const r = await sb.storage.from(BUCKET).remove([path]); if (r.error) console.error(r.error); }
  onMessageDelete(id);
});

// ---------- name dialog ----------
const ndlg = $('#nameDlg');
let nameMode = '';
function askName(mode) {
  nameMode = mode;
  $('#nameTitle').textContent = { project: 'Yangi loyiha', column: 'Yangi ustun', rename: 'Loyiha nomi' }[mode];
  $('#nameSubmit').textContent = mode === 'rename' ? 'Saqlash' : 'Yaratish';
  $('#fName').maxLength = mode === 'column' ? 40 : 60;
  $('#fName').value = mode === 'rename' ? (activeProject()?.name || '') : '';
  ndlg.showModal(); $('#fName').focus(); $('#fName').select();
}

async function renameProject(name) {
  const p = activeProject(); if (!p || !isOwner() || p.name === name) return;
  const old = p.name; p.name = name; render();
  const { error } = await sb.from('projects').update({ name }).eq('id', p.id);
  if (error) { p.name = old; render(); return fail(error, 'Nom saqlanmadi'); }
  toast('Saqlandi');
}
$('#nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#fName').value.trim(); if (!name) return;
  ndlg.close();
  if (nameMode === 'project') await createProject(name);
  else if (nameMode === 'rename') await renameProject(name);
  else await addColumn(name);
});
$('#cancelName').addEventListener('click', () => ndlg.close());

// ---------- members dialog ----------
const mdlg = $('#memDlg');
let dangerArmed = false;

function renderMembers() {
  const owner = myRole() === 'owner';
  $('#memList').innerHTML = S.members
    .slice().sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))
    .map(m => `<div class="member">
      ${avatarHTML(m.profile)}
      <div class="info">${esc(displayName(m.profile))}${m.user_id === S.user.id ? ' (siz)' : ''}<small>${esc(m.profile?.email)}</small></div>
      <span class="role">${m.role === 'owner' ? 'egasi' : 'a\'zo'}</span>
      ${owner && m.role !== 'owner' ? `<button type="button" class="icon-btn" data-remove="${m.user_id}" aria-label="Chiqarish" title="Loyihadan chiqarish">×</button>` : ''}
    </div>`).join('');
  $('#inviteBox').hidden = !owner;
  dangerArmed = false;
  $('#projDanger').classList.remove('armed');
  $('#projDanger').textContent = owner ? 'Loyihani o\'chirish' : 'Loyihadan chiqish';
}

$('#mEditProj').addEventListener('click', () => {
  $('#menu').hidden = true;
  if (isOwner()) askName('rename');
});
$('#mMembers').addEventListener('click', () => {
  $('#menu').hidden = true;
  if (!activeProject()) return toast('Avval loyiha tanlang');
  $('#fEmail').value = '';
  renderMembers(); mdlg.showModal();
});
$('#closeMem').addEventListener('click', () => mdlg.close());
mdlg.addEventListener('click', e => { if (e.target === mdlg) mdlg.close(); });

$('#memForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#fEmail').value.trim(); if (!email) return;
  const { error } = await sb.rpc('add_member_by_email', { p_project: S.activeId, p_email: email });
  if (error) return toast(error.message);
  $('#fEmail').value = '';
  await loadBoard(); renderMembers(); toast('A\'zo qo\'shildi');
});

$('#memList').addEventListener('click', async e => {
  const uid = e.target.closest('[data-remove]')?.dataset.remove; if (!uid) return;
  const { error } = await sb.from('project_members').delete().eq('project_id', S.activeId).eq('user_id', uid);
  if (error) return fail(error, 'Chiqarilmadi');
  // unassign their tasks locally; DB keeps assignee (they may rejoin) — clear it server-side too
  // biriktirishlar FK cascade orqali o'zi o'chadi (task_assignees → project_members)
  await loadBoard(); renderMembers();
});

$('#projDanger').addEventListener('click', async () => {
  const btn = $('#projDanger');
  if (!dangerArmed) { dangerArmed = true; btn.classList.add('armed'); btn.textContent = 'Tasdiqlash — qaytarib bo\'lmaydi'; return; }
  const owner = myRole() === 'owner';
  const q = owner
    ? sb.from('projects').delete().eq('id', S.activeId)
    : sb.from('project_members').delete().eq('project_id', S.activeId).eq('user_id', S.user.id);
  const { error } = await q;
  if (error) return fail(error, 'Bajarilmadi');
  mdlg.close();
  toast(owner ? 'Loyiha o\'chirildi' : 'Loyihadan chiqdingiz');
  S.activeId = null;
  await loadProjects();
});

// ---------- header events ----------
$('#tabs').addEventListener('click', e => {
  if (e.target.closest('#addProject')) return askName('project');
  const t = e.target.closest('[data-pid]'); if (!t || t.dataset.pid === S.activeId) return;
  filter.who = '';
  selectProject(t.dataset.pid);
});
$('#firstProject').addEventListener('click', () => askName('project'));
$('#q').addEventListener('input', e => { filter.q = e.target.value.trim(); render(); });
$('#who').addEventListener('change', e => { filter.who = e.target.value; render(); });
$('#newTask').addEventListener('click', openNewTask);
$('#meBtn').addEventListener('click', e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
document.addEventListener('click', e => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
$('#mLogout').addEventListener('click', logout);

// ---------- board events ----------
const board = $('#board');
let suppressClick = false;

board.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  if (e.target.closest('#addCol')) return askName('column');
  const colEl = e.target.closest('.col');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'quick') return openQuick(colEl);
  if (act === 'del-col') return deleteColumn(colEl.dataset.col);
  const card = e.target.closest('.card');
  if (card && !e.target.closest('.grip')) openTask(card.dataset.id);
});
board.addEventListener('keydown', e => {
  if (e.target.classList.contains('col-title')) { if (e.key === 'Enter') e.target.blur(); return; }
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(card.dataset.id); }
});
board.addEventListener('change', e => {
  if (!e.target.classList.contains('col-title')) return;
  const id = e.target.closest('.col').dataset.col;
  const v = e.target.value.trim();
  if (v) renameColumn(id, v); else e.target.value = S.columns.find(c => c.id === id)?.title || '';
});

// ---------- drag & drop (mouse: whole card, touch: grip) ----------
let drag = null;

board.addEventListener('pointerdown', e => {
  const card = e.target.closest('.card');
  if (!card || e.button !== 0) return;
  const onGrip = !!e.target.closest('.grip');
  if (e.pointerType !== 'mouse' && !onGrip) return;
  drag = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, active: false };
  if (onGrip) e.preventDefault();
});

function startDrag(e) {
  const r = drag.card.getBoundingClientRect();
  drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
  const g = drag.card.cloneNode(true);
  g.classList.add('ghost'); g.style.width = r.width + 'px'; g.style.left = '0px'; g.style.top = '0px';
  document.body.appendChild(g);
  drag.ghost = g;
  drag.card.classList.add('placeholder');
  document.body.classList.add('dragging');
  drag.active = true;
}

function moveDrag(e) {
  const { ghost, card } = drag;
  ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px) rotate(2deg)`;
  const br = board.getBoundingClientRect();
  if (e.clientX < br.left + 50) board.scrollLeft -= 14;
  else if (e.clientX > br.right - 50) board.scrollLeft += 14;

  const el = document.elementFromPoint(e.clientX, e.clientY);
  const list = el?.closest('.list') || el?.closest('.col')?.querySelector('.list');
  document.querySelectorAll('.list.over').forEach(l => l !== list && l.classList.remove('over'));
  if (!list) return;
  list.classList.add('over');
  list.querySelector('.empty')?.remove();
  const siblings = [...list.querySelectorAll('.card:not(.placeholder)')];
  const next = siblings.find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  if (next) { if (card.nextElementSibling !== next) list.insertBefore(card, next); }
  else if (list.lastElementChild !== card) list.appendChild(card);
  const lr = list.getBoundingClientRect();
  if (e.clientY < lr.top + 30) list.scrollTop -= 10;
  else if (e.clientY > lr.bottom - 30) list.scrollTop += 10;
}

function endDrag(cancelled) {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.active) return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
  d.ghost.remove();
  document.body.classList.remove('dragging');
  const list = d.card.parentElement;
  const toColId = list?.dataset.col;
  let next = d.card.nextElementSibling;
  while (next && !next.classList.contains('card')) next = next.nextElementSibling;
  const t = S.tasks.find(x => x.id === d.id);
  const origNext = (() => {
    if (!t) return null;
    const l = colTasks(t.column_id); const i = l.findIndex(x => x.id === t.id);
    return l[i + 1]?.id || null;
  })();
  const unchanged = t && toColId === t.column_id && (next?.dataset.id || null) === origNext;
  if (cancelled || !toColId || !t || unchanged) render();
  else moveTask(d.id, toColId, next?.dataset.id || null);
  flushPendingReload();
}

window.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    startDrag(e);
  }
  e.preventDefault();
  moveDrag(e);
}, { passive: false });
window.addEventListener('pointerup', () => endDrag(false));
window.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('keydown', e => { if (e.key === 'Escape' && drag?.active) endDrag(true); });

// ---------- boot ----------
show('loading');
sb.auth.getSession().then(({ data }) => { if (!booted) handleSession(data.session); });
})();
