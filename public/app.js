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
};
const filter = { q: '', who: '' };
let loadSeq = 0;
let channel = null;
let userChannel = null;

const activeProject = () => S.projects.find(p => p.id === S.activeId) || null;
const myRole = () => S.members.find(m => m.user_id === S.user?.id)?.role || null;
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
  ['#q', '#who', '#newTask'].forEach(s => $(s).disabled = !has);
  if (!has) { teardownProjectChannel(); return; }
  await loadBoard();
  subscribeProject(id);
}

async function loadBoard() {
  const id = S.activeId; if (!id) return;
  const seq = ++loadSeq;
  const [m, c, t] = await Promise.all([
    sb.from('project_members').select('user_id, role, profile:profiles(id,email,full_name,avatar_url)').eq('project_id', id),
    sb.from('columns').select('*').eq('project_id', id).order('position'),
    sb.from('tasks').select('*').eq('project_id', id).order('position'),
  ]);
  if (seq !== loadSeq || id !== S.activeId) return; // stale response
  const error = m.error || c.error || t.error;
  if (error) return fail(error, 'Board\'ni yuklab bo\'lmadi');
  S.members = m.data; S.columns = c.data; S.tasks = t.data;
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
  if (filter.who && (filter.who === '_none' ? t.assignee_id : t.assignee_id !== filter.who)) return false;
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
      ${avatarHTML(profileOf(t.assignee_id))}
    </div>
  </article>`;
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
  $('#board').innerHTML = S.columns.map(c => {
    const all = colTasks(c.id), vis = all.filter(matches);
    return `<section class="col" data-col="${c.id}">
      <div class="col-head">
        <input class="col-title" value="${esc(c.title)}" maxlength="40" aria-label="Ustun nomi" id="ct-${c.id}">
        <span class="count">${filtering ? `${vis.length}/${all.length}` : all.length}</span>
        <button class="icon-btn" data-act="del-col" aria-label="Ustunni o'chirish" title="Ustunni o'chirish">×</button>
      </div>
      <div class="list" data-col="${c.id}">
        ${vis.length ? vis.map(t => cardHTML(t, c.is_done)).join('') : `<div class="empty">${all.length ? 'Filtrga mos vazifa yo\'q' : 'Bu yerga vazifa torting'}</div>`}
      </div>
      <div class="col-foot"><button class="add-task" data-act="quick">+ Vazifa qo'shish</button></div>
    </section>`;
  }).join('') + `<button class="add-col" id="addCol">+ Ustun qo'shish</button>`;

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
  const c = S.columns.find(x => x.id === id); if (!c || c.title === title) return;
  const old = c.title; c.title = title;
  const { error } = await sb.from('columns').update({ title }).eq('id', id);
  if (error) { c.title = old; render(); fail(error, 'Nom saqlanmadi'); }
}

async function deleteColumn(id) {
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

function fillSelects(colId) {
  $('#fCol').innerHTML = S.columns.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
  $('#fCol').value = colId;
  $('#fWho').innerHTML = `<option value="">Tayinlanmagan</option>` +
    S.members.map(m => `<option value="${m.user_id}">${esc(displayName(m.profile))}</option>`).join('');
}

function openTask(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  editing = { id };
  fillSelects(t.column_id);
  $('#fTitle').value = t.title;
  $('#fDesc').value = t.description;
  $('#fWho').value = t.assignee_id || '';
  $('#fDue').value = t.due_date || '';
  $('#fPrio').value = t.priority || '';
  $('#fTags').value = t.tags.join(', ');
  $('#delTask').hidden = false;
  resetDelete();
  dlg.showModal();
}

function openNewTask() {
  if (!S.columns.length) return toast('Avval ustun qo\'shing');
  editing = { newIn: S.columns[0].id };
  fillSelects(S.columns[0].id);
  ['#fTitle', '#fDesc', '#fDue', '#fTags'].forEach(s => $(s).value = '');
  $('#fWho').value = ''; $('#fPrio').value = '';
  $('#delTask').hidden = true;
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
    assignee_id: $('#fWho').value || null,
    due_date: $('#fDue').value || null,
    priority: $('#fPrio').value || null,
    tags: [...new Set($('#fTags').value.split(',').map(s => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 6),
  };
  const colId = $('#fCol').value;
  const ed = editing;
  dlg.close();
  if (ed.id) {
    const t = S.tasks.find(x => x.id === ed.id);
    if (t && t.column_id !== colId) { data.column_id = colId; data.position = nextPosition(colId); }
    await updateTask(ed.id, data);
    toast('Saqlandi');
  } else {
    await createTask(colId, data);
    toast('Vazifa qo\'shildi');
  }
});

let delArmed = false;
const resetDelete = () => { delArmed = false; $('#delTask').textContent = "O'chirish"; $('#delTask').classList.remove('armed'); };
$('#delTask').addEventListener('click', () => {
  if (!delArmed) { delArmed = true; $('#delTask').textContent = 'Tasdiqlash'; $('#delTask').classList.add('armed'); return; }
  const id = editing.id; dlg.close(); deleteTask(id);
});
$('#cancelTask').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { resetDelete(); flushPendingReload(); });
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

// ---------- name dialog ----------
const ndlg = $('#nameDlg');
let nameMode = '';
function askName(mode) {
  nameMode = mode;
  $('#nameTitle').textContent = mode === 'project' ? 'Yangi loyiha' : 'Yangi ustun';
  $('#fName').maxLength = mode === 'project' ? 60 : 40;
  $('#fName').value = '';
  ndlg.showModal(); $('#fName').focus();
}
$('#nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#fName').value.trim(); if (!name) return;
  ndlg.close();
  if (nameMode === 'project') await createProject(name); else await addColumn(name);
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
  await sb.from('tasks').update({ assignee_id: null }).eq('project_id', S.activeId).eq('assignee_id', uid);
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
