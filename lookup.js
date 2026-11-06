'use strict';

/* Finds a game's genre and Steam ID from free sources that allow browser requests. */

const GENRE_RULES = [
  [/point.and.click|graphic adventure/i, 'Point & Click'],
  [/roguelike|roguelite/i, 'Roguelike'],
  [/battle royale/i, 'Shooter'],
  [/sandbox|survival game/i, 'Sandbox & Survival'],
  [/role.?playing|\brpg\b/i, 'RPG'],
  [/shooter/i, 'Shooter'],
  [/platform/i, 'Platformer'],
  [/racing|kart/i, 'Racing'],
  [/sports?\b|football|basketball|golf|tennis/i, 'Sports'],
  [/fighting|beat 'em up/i, 'Fighting'],
  [/horror/i, 'Horror'],
  [/strategy|tactic|4x|city.building|management|simulation|simulator/i, 'Strategy & Sim'],
  [/action.{1,3}adventure|open.world|stealth/i, 'Action Adventure'],
  [/puzzle/i, 'Puzzle'],
  [/adventure|visual novel|interactive fiction/i, 'Adventure'],
  [/action/i, 'Action'],
];
const GENRES = [...new Set(GENRE_RULES.map(([, name]) => name)), 'Other'];

function shelfGenre(labels) {
  for (const [rule, name] of GENRE_RULES) {
    if (labels.some(text => rule.test(text))) return name;
  }
  return null;
}

async function apiJson(base, params) {
  const res = await fetch(`${base}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`);
  if (!res.ok) throw new Error(`${base} answered ${res.status}`);
  return res.json();
}

async function wikidataId(pageTitle) {
  const wiki = await apiJson('https://en.wikipedia.org/w/api.php', {
    action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', titles: pageTitle,
  });
  return Object.values(wiki.query?.pages || {})[0]?.pageprops?.wikibase_item || null;
}

async function wikidataFacts(id) {
  if (!id) return { labels: [], steamId: null };

  const WIKIDATA = 'https://www.wikidata.org/w/api.php';
  const data = await apiJson(WIKIDATA, { action: 'wbgetentities', ids: id, props: 'claims' });
  const claims = data.entities?.[id]?.claims || {};
  const values = property => (claims[property] || []).map(c => c.mainsnak?.datavalue?.value).filter(Boolean);
  const genreIds = values('P136').map(v => v.id).slice(0, 12);
  let labels = [];
  if (genreIds.length) {
    const names = await apiJson(WIKIDATA, { action: 'wbgetentities', ids: genreIds.join('|'), props: 'labels', languages: 'en' });
    labels = genreIds.map(g => names.entities?.[g]?.labels?.en?.value).filter(Boolean);
  }
  return { labels, steamId: values('P1733')[0] || null };
}

const plainName = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function appStoreGenres(title) {
  const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term: title, entity: 'software', limit: '5' })}`);
  if (!res.ok) return [];
  const { results = [] } = await res.json();
  const match = results.find(r => plainName(r.trackName) === plainName(title));
  return (match?.genres || []).filter(g => g !== 'Games');
}

async function lookupGame({ title, sourcePage, wikidataId: knownId, storeGenres = [] }) {
  const id = knownId || (sourcePage ? await wikidataId(sourcePage).catch(() => null) : null);
  const facts = await wikidataFacts(id).catch(() => ({ labels: [], steamId: null }));
  const genre = shelfGenre(facts.labels) || shelfGenre(storeGenres) || shelfGenre(await appStoreGenres(title).catch(() => []));
  return { genre, steamId: facts.steamId };
}

/* Steam's portrait library art. Newer games use a hashed path, which the repo's robot resolves. */
const steamArt = steamId => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/library_600x900.jpg`;
const uprightCover = steamId => downloadCover(steamArt(steamId));
