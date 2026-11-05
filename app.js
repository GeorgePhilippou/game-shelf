'use strict';

const STATUSES = [
  ['playing', 'Playing now'],
  ['finished', 'Finished'],
  ['played', 'Played'],
  ['unplayed', 'Not played yet'],
  ['dropped', 'Gave up on'],
];
const FORMATS = [
  ['physical', 'Physical copy'],
  ['digital', 'Digital'],
  ['former', 'Used to own'],
  ['other', 'Borrowed or played elsewhere'],
];
const PLATFORMS = ['PS5', 'PS4', 'PS3', 'PS2', 'PS1', 'PSP', 'Xbox Series', 'Xbox One', 'Xbox 360', 'Xbox',
  'Switch 2', 'Switch', 'Wii U', 'Wii', 'GameCube', 'N64', 'DS', '3DS', 'Game Boy', 'PC', 'Mac', 'Mobile'];

const $ = id => document.getElementById(id);
const label = (list, key) => (list.find(([k]) => k === key) || [key, key])[1];

/* ---------- Storage: IndexedDB keeps the downloaded cover images with each game ---------- */
const DB_NAME = 'game-shelf';
const STORE = 'games';
let dbPromise;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = work(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = game => tx('readwrite', s => s.put(game));

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* preference only */ } },
};

/* ---------- Covers ---------- */
async function wikipediaPages(search) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: search, gsrlimit: '16',
    prop: 'pageimages|description', piprop: 'thumbnail', pithumbsize: '500', pilicense: 'any',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
  const data = await res.json();
  return Object.values(data.query?.pages || {}).sort((a, b) => a.index - b.index);
}

const NOT_A_GAME = /character|music|soundtrack|series|film|franchise|company|developer|designer|director|producer|composer|award|television|novel|magazine|person/i;
const NOT_A_GAME_TITLE = /^(list of|characters of|music of|development of|history of)\b/i;

function closeness(title, query) {
  const t = title.toLowerCase();
  if (t === query) return 0;
  if (t.startsWith(query)) return 1;
  return t.includes(query) ? 2 : 3;
}

/* Two searches: the plain name finds exact titles, the suffixed one rescues names like Hades. */
async function searchWikipedia(query) {
  const [plain, suffixed] = await Promise.all([wikipediaPages(query), wikipediaPages(`${query} video game`)]);
  const pages = [...new Map([...plain, ...suffixed].map(p => [p.pageid, p])).values()]
    .filter(p => p.thumbnail?.source);
  const games = pages.filter(p => /\bgame\b/i.test(p.description || '')
    && !NOT_A_GAME.test(p.description || '') && !NOT_A_GAME_TITLE.test(p.title));
  const wanted = query.toLowerCase();
  return (games.length ? games : pages)
    .map(p => ({
      title: p.title.replace(/\s*\((?:[^)]*\b)?(?:video )?game\)$/i, ''),
      pageTitle: p.title,
      year: Number((p.description || '').match(/\b(19|20)\d{2}\b/)?.[0]) || null,
      description: p.description || '',
      image: p.thumbnail.source,
    }))
    .sort((a, b) => closeness(a.title, wanted) - closeness(b.title, wanted))
    .slice(0, 15);
}

/* Shrinks any source image to a consistent JPEG so backups stay a sensible size. */
async function toCoverBlob(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, 600 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(
    b => (b ? resolve(b) : reject(new Error('Could not encode the cover'))), 'image/jpeg', 0.86));
}

async function downloadCover(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  return toCoverBlob(await res.blob());
}

const coverUrls = new WeakMap();
function coverUrl(blob) {
  if (!coverUrls.has(blob)) coverUrls.set(blob, URL.createObjectURL(blob));
  return coverUrls.get(blob);
}
const coverSrc = game => (game.cover ? coverUrl(game.cover) : game.coverPath || null);

/* ---------- Shelf ---------- */
let games = [];
let publicView = false;  // a visitor looking at the published shelf, so nothing is editable

function brandColour(platform = '') {
  const p = platform.toLowerCase();
  if (/ps\d|playstation|psp|vita/.test(p)) return '#1f5fb4';
  if (/xbox/.test(p)) return '#2c7d32';
  if (/switch|wii|gamecube|n64|nintendo|\bds\b|3ds|game boy|snes|nes/.test(p)) return '#c5302b';
  if (/pc|steam|windows/.test(p)) return '#3d4a57';
  if (/mac|ios|iphone|mobile|android/.test(p)) return '#6a5a7d';
  return '#5c5048';
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

function blankCover(title) {
  return el('div', { className: 'blank', textContent: title });
}

function caseButton(game) {
  const button = el('button', {
    type: 'button',
    className: `case${game.format === 'former' ? ' gone' : ''}`,
    title: game.title,
  });
  const details = [game.platform, label(STATUSES, game.status), game.rating ? `${game.rating} out of 5` : ''];
  button.setAttribute('aria-label', [game.title, ...details].filter(Boolean).join(', '));
  button.style.setProperty('--brand', brandColour(game.platform));
  button.append(el('span', { className: 'banner', textContent: game.platform || 'Game' }));
  const src = coverSrc(game);
  if (src) {
    button.append(el('img', { src, alt: '', className: 'fill', loading: 'lazy' }), el('img', { src, alt: '', loading: 'lazy' }));
  } else {
    button.append(blankCover(game.title));
  }
  if (game.rating) button.append(el('span', { className: 'score', textContent: `★ ${game.rating}` }));
  button.addEventListener('click', () => openEditor(game));
  return button;
}

const sorters = {
  added: (a, b) => b.added - a.added,
  title: (a, b) => a.title.localeCompare(b.title),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title),
  year: (a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title),
};

function sections(list, groupBy) {
  if (groupBy === 'none') return [['All games', list]];
  if (groupBy === 'status') return STATUSES.map(([k, name]) => [name, list.filter(g => g.status === k)]);
  if (groupBy === 'format') return FORMATS.map(([k, name]) => [name, list.filter(g => g.format === k)]);
  const names = [...new Set(list.map(g => g.platform || 'No platform set'))].sort((a, b) => a.localeCompare(b));
  return names.map(name => [name, list.filter(g => (g.platform || 'No platform set') === name)]);
}

function render() {
  const query = $('filter').value.trim().toLowerCase();
  const list = games
    .filter(g => !query || [g.title, g.platform, g.notes].join(' ').toLowerCase().includes(query))
    .sort(sorters[$('sortBy').value]);

  const finished = games.filter(g => g.status === 'finished').length;
  const physical = games.filter(g => g.format === 'physical').length;
  const platforms = new Set(games.map(g => g.platform).filter(Boolean)).size;
  $('stats').textContent = games.length
    ? `${plural(games.length, 'game')} · ${finished} finished · ${physical} physical · ${plural(platforms, 'platform')}`
    : 'Your shelf is ready';

  const library = $('library');
  library.replaceChildren();
  if (!games.length) {
    const start = el('button', { type: 'button', className: 'primary', textContent: 'Add your first game' });
    start.addEventListener('click', () => openEditor());
    library.append(el('div', { className: 'empty' },
      el('h2', { textContent: 'Nothing on the shelf yet' }),
      el('p', { textContent: 'Type a game’s name and its box art is saved with your entry.' }),
      start));
  } else if (!list.length) {
    library.append(el('div', { className: 'empty' }, el('h2', { textContent: 'No games match that search' })));
  }
  for (const [name, items] of list.length ? sections(list, $('groupBy').value) : []) {
    if (!items.length) continue;
    library.append(
      el('div', { className: 'section-head' }, el('h2', { textContent: name }), el('span', { textContent: items.length })),
      el('div', { className: 'shelf' }, ...items.map(caseButton)));
  }
  $('addBtn').hidden = publicView;
  for (const id of ['backupBtn', 'restoreBtn']) $(id).hidden = publicView;
  $('connectBtn').textContent = isConnected() ? 'GitHub sync settings' : 'Connect to GitHub';
  renderBackupNote();
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
}

/* ---------- Add and edit ---------- */
let draft = null;        // the entry being edited
let coverOnly = false;   // search step is replacing the cover of an open entry
let searchRun = 0;
let confirmingDelete = false;

function blankDraft() {
  return {
    id: crypto.randomUUID(), title: '', platform: store.get('lastPlatform') || '', year: null,
    status: 'finished', format: store.get('lastFormat') || 'physical',
    finished: '', rating: 0, notes: '', cover: null, sourcePage: '', added: Date.now(), isNew: true,
  };
}

function showStep(step) {
  $('searchStep').hidden = step !== 'search';
  $('gameForm').hidden = step !== 'form';
}

function openEditor(game) {
  draft = game ? { ...game, isNew: false } : blankDraft();
  coverOnly = false;
  $('editorTitle').textContent = game ? game.title : 'Add a game';
  if (game) { fillForm(); showStep('form'); } else { openSearch(''); }
  if (!$('editor').open) $('editor').showModal();
  if (!game) $('gameSearch').focus();
}

function openSearch(query) {
  $('gameSearch').value = query;
  $('results').replaceChildren();
  $('searchStatus').textContent = '';
  $('manualBtn').hidden = coverOnly;
  showStep('search');
  if (query) runSearch();
}

function fillForm() {
  $('fTitle').value = draft.title;
  $('fPlatform').value = draft.platform;
  $('fYear').value = draft.year || '';
  $('fStatus').value = draft.status;
  $('fFormat').value = draft.format;
  $('fFinished').value = draft.finished;
  $('fNotes').value = draft.notes;
  $('formError').hidden = true;
  confirmingDelete = false;
  $('deleteBtn').hidden = draft.isNew || publicView;
  $('saveBtn').hidden = publicView;
  $('findCover').hidden = publicView;
  $('uploadCover').hidden = publicView;
  for (const id of ['fTitle', 'fPlatform', 'fYear', 'fStatus', 'fFormat', 'fFinished', 'fNotes']) $(id).disabled = publicView;
  $('deleteBtn').textContent = 'Remove from shelf';
  renderStars();
  renderCover();
}

function readForm() {
  draft.title = $('fTitle').value.trim();
  draft.platform = $('fPlatform').value.trim();
  draft.year = Number($('fYear').value) || null;
  draft.status = $('fStatus').value;
  draft.format = $('fFormat').value;
  draft.finished = $('fFinished').value;
  draft.notes = $('fNotes').value.trim();
}

function renderCover() {
  const preview = $('coverPreview');
  const save = $('saveCover');
  const src = coverSrc(draft);
  preview.replaceChildren(src
    ? el('img', { src, alt: `Cover of ${draft.title}` })
    : blankCover(draft.title || 'No cover yet'));
  save.hidden = !src;
  if (src) {
    save.href = src;
    save.download = `${(draft.title || 'cover').replace(/[^\w -]+/g, '').trim() || 'cover'}.jpg`;
  }
  const source = $('sourceLink');
  source.hidden = !draft.sourcePage;
  if (draft.sourcePage) source.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(draft.sourcePage.replace(/ /g, '_'))}`;
}

function renderStars() {
  const box = $('stars');
  box.replaceChildren(...[1, 2, 3, 4, 5].map(n => {
    const star = el('button', { type: 'button', className: `star${n <= draft.rating ? ' on' : ''}`, textContent: '★', disabled: publicView });
    star.setAttribute('aria-label', `${n} out of 5`);
    star.setAttribute('aria-pressed', String(n === draft.rating));
    star.addEventListener('click', () => {
      draft.rating = draft.rating === n ? 0 : n;
      renderStars();
    });
    return star;
  }));
}

async function runSearch() {
  const query = $('gameSearch').value.trim();
  const run = ++searchRun;
  const status = $('searchStatus');
  if (query.length < 2) {
    status.textContent = '';
    $('results').replaceChildren();
    return;
  }
  status.textContent = 'Looking for covers';
  try {
    const found = await searchWikipedia(query);
    if (run !== searchRun) return;
    status.textContent = found.length ? 'Pick the right game' : 'No covers found. You can add it by hand below.';
    $('results').replaceChildren(...found.map(resultButton));
  } catch (err) {
    if (run !== searchRun) return;
    console.error(err);
    status.textContent = 'Could not reach Wikipedia. You can still add the game by hand below.';
  }
}

function resultButton(item) {
  const button = el('button', { type: 'button', className: 'result' },
    el('img', { src: item.image, alt: '' }),
    el('b', { textContent: item.title }),
    el('small', { textContent: item.year || item.description }));
  button.addEventListener('click', () => chooseResult(item));
  return button;
}

async function chooseResult(item) {
  $('searchStatus').textContent = `Downloading the cover of ${item.title}`;
  try {
    draft.cover = await downloadCover(item.image);
    draft.coverPath = null;
    draft.sourcePage = item.pageTitle;
  } catch (err) {
    console.error(err);
    $('searchStatus').textContent = 'That cover would not download. Try another, or carry on without it.';
    if (coverOnly) return;
  }
  if (!coverOnly) {
    draft.title = item.title;
    draft.year = item.year;
    $('editorTitle').textContent = item.title;
    fillForm();
  } else {
    renderCover();
  }
  coverOnly = false;
  showStep('form');
  if (draft.isNew) $('fPlatform').focus();
}

async function saveDraft(event) {
  event.preventDefault();
  readForm();
  if (!draft.title) return;
  const { isNew, ...game } = draft;
  game.updated = Date.now();
  try {
    await dbPut(game);
  } catch (err) {
    console.error(err);
    const error = $('formError');
    error.textContent = 'This browser refused to save the game, so it has not been added.';
    error.hidden = false;
    return;
  }
  games = games.filter(g => g.id !== game.id).concat(game);
  if (game.platform) store.set('lastPlatform', game.platform);
  store.set('lastFormat', game.format);
  store.set('unsaved', String(Number(store.get('unsaved') || 0) + 1));
  $('editor').close();
  render();
  scheduleSync();
  toast(isNew ? `${game.title} is on the shelf` : `${game.title} updated`);
}

async function deleteDraft() {
  if (!confirmingDelete) {
    confirmingDelete = true;
    $('deleteBtn').textContent = 'Press again to remove';
    return;
  }
  const { id, title } = draft;
  await dbPut({ id, deleted: true, updated: Date.now() });
  games = games.filter(g => g.id !== id);
  store.set('unsaved', String(Number(store.get('unsaved') || 0) + 1));
  $('editor').close();
  render();
  scheduleSync();
  toast(`${title} removed`);
}

/* ---------- Backup ---------- */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadBackup() {
  const entries = await Promise.all(games.map(async g => ({
    ...g, cover: g.cover ? await blobToDataUrl(g.cover) : null,
  })));
  const file = new Blob([JSON.stringify({ app: 'game-shelf', version: 1, games: entries })], { type: 'application/json' });
  const today = new Date().toISOString().slice(0, 10);
  const link = el('a', { href: URL.createObjectURL(file), download: `game-shelf-backup-${today}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  store.set('lastBackup', today);
  store.set('unsaved', '0');
  renderBackupNote();
}

async function restoreBackup(file) {
  let incoming;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.app !== 'game-shelf' || !Array.isArray(parsed.games)) throw new Error('Not a Game Shelf backup');
    incoming = parsed.games;
  } catch (err) {
    console.error(err);
    toast('That file is not a Game Shelf backup');
    return;
  }
  let restored = 0;
  for (const entry of incoming) {
    if (!entry.id || !entry.title) continue;
    const isImage = typeof entry.cover === 'string' && entry.cover.startsWith('data:image/');
    const cover = isImage ? await (await fetch(entry.cover)).blob() : null;
    const game = { ...entry, cover, coverPath: null, updated: Date.now() };
    await dbPut(game);
    games = games.filter(g => g.id !== game.id).concat(game);
    restored += 1;
  }
  render();
  scheduleSync(500);
  toast(`Restored ${plural(restored, 'game')}`);
}

function renderBackupNote() {
  const last = store.get('lastBackup');
  const changes = Number(store.get('unsaved') || 0);
  $('backupNote').textContent = !games.length || publicView || isConnected() ? ''
    : last ? `Last backup ${last}${changes ? `, ${plural(changes, 'change')} since` : ''}`
    : 'Not backed up yet';
}

/* ---------- Sync screen ---------- */
function setSyncNote(text) { $('syncNote').textContent = text; }

async function reloadGames() {
  games = (await dbAll()).filter(g => !g.deleted);
  render();
}

function openSyncDialog() {
  const connected = isConnected();
  $('syncIntro').hidden = connected;
  $('syncForm').hidden = connected;
  $('syncConnected').hidden = !connected;
  $('syncError').hidden = true;
  $('tokenInput').value = '';
  $('syncDialog').showModal();
}

async function connect(event) {
  event.preventDefault();
  const token = $('tokenInput').value.trim();
  const error = $('syncError');
  error.hidden = true;
  try {
    const repo = await githubJson('', { token });
    if (!repo.permissions?.push) throw new Error('read-only token');
    store.set(TOKEN_KEY, token);
    if (!isConnected()) throw new Error('browser storage blocked');
  } catch (err) {
    console.error(err.message);
    error.textContent = err.message === 'browser storage blocked'
      ? 'This browser would not save the token. Try a normal, non-private window.'
      : 'That token did not work. Check it is for game-shelf with Contents set to Read and write.';
    error.hidden = false;
    return;
  }
  $('syncDialog').close();
  publicView = false;
  await reloadGames();
  await syncNow();
  toast('This device is connected');
}

function disconnect() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
  location.reload();
}

/* Visitors see the published library; with no published games, the page works locally. */
async function loadPublished() {
  try {
    const res = await fetch(LIBRARY_PATH, { cache: 'no-cache' });
    if (!res.ok) return false;
    const published = (await res.json()).games.filter(g => !g.deleted);
    if (!published.length) return false;
    games = published;
    publicView = true;
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/* ---------- Wiring ---------- */
function fillSelect(select, options) {
  select.append(...options.map(([value, text]) => el('option', { value, textContent: text })));
}

function debounce(fn, wait) {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(fn, wait); };
}

async function start() {
  fillSelect($('fStatus'), STATUSES);
  fillSelect($('fFormat'), FORMATS);
  $('platforms').append(...PLATFORMS.map(value => el('option', { value })));
  $('groupBy').value = store.get('groupBy') || 'status';
  $('sortBy').value = store.get('sortBy') || 'added';

  $('addBtn').addEventListener('click', () => openEditor());
  $('closeEditor').addEventListener('click', () => $('editor').close());
  $('filter').addEventListener('input', render);
  for (const id of ['groupBy', 'sortBy']) {
    $(id).addEventListener('change', () => { store.set(id, $(id).value); render(); });
  }
  $('gameSearch').addEventListener('input', debounce(runSearch, 350));
  $('manualBtn').addEventListener('click', () => {
    draft.title = $('gameSearch').value.trim();
    fillForm();
    showStep('form');
    $('fTitle').focus();
  });
  $('findCover').addEventListener('click', () => {
    readForm();
    coverOnly = true;
    openSearch(draft.title);
  });
  $('uploadCover').addEventListener('click', () => $('coverFile').click());
  $('coverFile').addEventListener('change', async event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    try {
      draft.cover = await toCoverBlob(file);
      draft.coverPath = null;
      draft.sourcePage = '';
      renderCover();
    } catch (err) {
      console.error(err);
      toast('That image could not be read');
    }
  });
  $('gameForm').addEventListener('submit', saveDraft);
  $('deleteBtn').addEventListener('click', deleteDraft);
  $('backupBtn').addEventListener('click', downloadBackup);
  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) restoreBackup(file);
  });

  $('tokenLink').href = TOKEN_PAGE;
  $('connectBtn').addEventListener('click', openSyncDialog);
  $('closeSync').addEventListener('click', () => $('syncDialog').close());
  $('syncForm').addEventListener('submit', connect);
  $('syncNowBtn').addEventListener('click', () => { $('syncDialog').close(); syncNow(); });
  $('disconnectBtn').addEventListener('click', disconnect);

  if (isConnected() || !(await loadPublished())) {
    try {
      await reloadGames();
    } catch (err) {
      console.error(err);
      toast('This browser is blocking storage, so games cannot be saved here');
    }
  }
  render();
  if (isConnected()) {
    syncNow();
    navigator.storage?.persist?.();
  }
}

start();
