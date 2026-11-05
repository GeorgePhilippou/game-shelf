'use strict';

/* The repo is the shared copy of the library: library.json plus one JPEG per cover in covers/.
   Each device keeps a working copy in IndexedDB and merges by newest edit, so a failed
   sync loses nothing and is simply repeated later. Removed games stay as small "deleted"
   records so a removal on one device isn't undone by another. */

const REPO = { owner: 'GeorgePhilippou', name: 'game-shelf', branch: 'main' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}`;
const LIBRARY_PATH = 'library.json';
const TOKEN_KEY = 'gameShelfToken';
const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'Game Shelf',
  description: 'Lets Game Shelf save to the game-shelf repo',
  target_name: REPO.owner,
  expires_in: '365',
  contents: 'write',
});

const stamp = record => record.updated || record.added || 0;
const isConnected = () => Boolean(store.get(TOKEN_KEY));

function mergeRecords(local, remote) {
  const merged = new Map(remote.map(r => [r.id, r]));
  for (const record of local) {
    const other = merged.get(record.id);
    if (!other || stamp(record) > stamp(other)) merged.set(record.id, record);
  }
  return [...merged.values()];
}

/* Sorted keys and ids, so an unchanged library always produces identical text and no commit. */
function libraryJson(records) {
  const games = records
    .map(({ cover, isNew, ...rest }) => Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ app: 'game-shelf', version: 2, games }, null, 1);
}

class GitHubError extends Error {
  constructor(status, path) {
    super(`GitHub answered ${status} for ${path}`);
    this.status = status;
  }
}

async function github(path, { method = 'GET', body, accept = 'application/vnd.github+json', token = store.get(TOKEN_KEY) } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GitHubError(res.status, path);
  return res;
}
const githubJson = async (path, options) => (await github(path, options)).json();

async function readRemoteLibrary(commit) {
  try {
    const res = await github(`/contents/${LIBRARY_PATH}?ref=${commit}`, { accept: 'application/vnd.github.raw+json' });
    const data = await res.json();
    return Array.isArray(data.games) ? data.games : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function uploadNewCovers(records) {
  const entries = [];
  const uploaded = [];
  for (const record of records) {
    if (record.deleted || !record.cover || record.coverPath) {
      uploaded.push(record);
      continue;
    }
    const content = (await blobToDataUrl(record.cover)).split(',')[1];
    const { sha } = await githubJson('/git/blobs', { method: 'POST', body: { content, encoding: 'base64' } });
    const path = `covers/${record.id}-${Date.now().toString(36)}.jpg`;
    entries.push({ path, mode: '100644', type: 'blob', sha });
    uploaded.push({ ...record, coverPath: path });
  }
  return { entries, uploaded };
}

async function pushCommit(head, entries) {
  const { tree: { sha: baseTree } } = await githubJson(`/git/commits/${head}`);
  const tree = await githubJson('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
  const commit = await githubJson('/git/commits', {
    method: 'POST',
    body: { message: 'Update game library', tree: tree.sha, parents: [head] },
  });
  await github(`/git/refs/heads/${REPO.branch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
}

async function downloadRepoCover(path) {
  const res = await github(`/contents/${path}?ref=${REPO.branch}`, { accept: 'application/vnd.github.raw+json' });
  return res.blob();
}

/* Writes the merged result back, skipping anything edited on this device during the sync. */
async function storeMerged(records) {
  const current = new Map((await dbAll()).map(r => [r.id, r]));
  const pending = records.filter(r => {
    const mine = current.get(r.id);
    return !mine || stamp(mine) <= stamp(r);
  });
  for (let i = 0; i < pending.length; i += 5) {
    await Promise.all(pending.slice(i, i + 5).map(async record => {
      const mine = current.get(record.id);
      let cover = record.cover || (mine?.coverPath === record.coverPath ? mine?.cover : null) || null;
      if (!record.deleted && record.coverPath && !cover) {
        cover = await downloadRepoCover(record.coverPath).catch(() => null);
      }
      await dbPut({ ...record, cover: record.deleted ? null : cover });
    }));
  }
}

async function syncOnce() {
  const { object: { sha: head } } = await githubJson(`/git/ref/heads/${REPO.branch}`);
  const remote = await readRemoteLibrary(head);
  const merged = mergeRecords(await dbAll(), remote);
  const { entries, uploaded } = await uploadNewCovers(merged);

  const text = libraryJson(uploaded);
  if (text !== libraryJson(remote)) {
    const kept = new Set(uploaded.map(r => r.coverPath));
    const removed = remote.map(r => r.coverPath).filter(path => path && !kept.has(path));
    await pushCommit(head, [
      ...entries,
      { path: LIBRARY_PATH, mode: '100644', type: 'blob', content: text },
      ...[...new Set(removed)].map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
    ]);
  }
  await storeMerged(uploaded);
}

let syncTimer = null;
let syncing = false;
let syncAgain = false;
let lastSync = 0;

function scheduleSync(delay = 5000) {
  if (!isConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (!isConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  setSyncNote('Syncing');
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await syncOnce();
        break;
      } catch (err) {
        // 422 here means another device committed first, so merge again on top of that.
        if (err.status !== 422 || attempt === 3) throw err;
      }
    }
    lastSync = Date.now();
    setSyncNote(`Synced at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    await reloadGames();
  } catch (err) {
    console.error(err);
    setSyncNote(err.status === 401 || err.status === 403
      ? 'GitHub refused the token. Your games are safe here; reconnect to sync.'
      : 'Sync failed. Your games are safe here and it will try again.');
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(1000);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (syncTimer) syncNow();
  } else if (Date.now() - lastSync > 30000) {
    syncNow();
  }
});
window.addEventListener('online', () => syncNow());
