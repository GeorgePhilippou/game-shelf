// Runs in GitHub Actions. Steam's store API can't be called from a browser, so this fills in
// upright box art for games that don't have any yet. Usage: node find-upright-covers.mjs [--dry-run]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const LOOKUP_VERSION = 1;
const DRY_RUN = process.argv.includes('--dry-run');
const CONTEXT = { language: 'english', country_code: 'GB' };
const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const EDITION = /^ (the )?(final cut|definitive|remaster|enhanced|complete|deluxe|director|game of the year|goty|anniversary|special edition)/;
const plain = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function steamCall(path, input) {
  const url = `https://api.steampowered.com/${path}/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()).response || {};
}

async function storeItems(appids) {
  const { store_items: items = [] } = await steamCall('IStoreBrowseService/GetItems', {
    ids: appids.map(appid => ({ appid })),
    context: CONTEXT,
    data_request: { include_assets: true, include_basic_info: true },
  });
  return items;
}

async function findItem(game) {
  if (game.steamId) {
    const [item] = await storeItems([Number(game.steamId)]);
    if (item?.assets?.library_capsule) return item;
  }
  const { ids = [] } = await steamCall('IStoreQueryService/SearchSuggestions', {
    search_term: game.title, max_results: 8, context: CONTEXT,
  });
  if (!ids.length) return null;
  const items = await storeItems(ids.map(i => i.appid));
  const withArt = items.filter(i => i.assets?.library_capsule);
  const title = plain(game.title);
  return withArt.find(i => plain(i.name || '') === title)
    || withArt.find(i => EDITION.test(plain(i.name || '').replace(title, '')) && plain(i.name || '').startsWith(`${title} `))
    || null;
}

const library = JSON.parse(readFileSync('library.json', 'utf8'));
let changed = false;

for (const game of library.games) {
  if (game.deleted || game.coverUpright || game.coverCustom || game.coverLookup === LOOKUP_VERSION) continue;
  let item = null;
  try {
    item = await findItem(game);
  } catch (err) {
    console.error(`${game.title}: ${err.message}`);
    continue;  // try again next run
  }
  if (!item) {
    console.log(`${game.title}: no upright art on Steam`);
    game.coverLookup = LOOKUP_VERSION;
    changed = true;
    continue;
  }
  // Hashed library_capsule files are half size, so prefer the 2x version of those.
  const { library_capsule: normal, library_capsule_2x: large } = item.assets;
  const file = normal.includes('600x900') ? normal : large || normal;
  const url = ASSETS + item.assets.asset_url_format.replace('${FILENAME}', file);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`${game.title}: art answered ${res.status}`);
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  console.log(`${game.title}: found ${url} (${bytes.length} bytes)`);
  if (DRY_RUN) continue;
  const path = `covers/${game.id}-upright-${Date.now().toString(36)}.jpg`;
  mkdirSync('covers', { recursive: true });
  writeFileSync(path, bytes);
  Object.assign(game, { coverPath: path, coverUpright: true, steamId: String(item.appid), updated: Date.now() });
  changed = true;
}

if (changed && !DRY_RUN) writeFileSync('library.json', JSON.stringify(library, null, 1));
