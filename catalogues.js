'use strict';

/* Wikipedia alone misses smaller games and only has logos for some big ones, so a search also
   asks three catalogues a web page is allowed to read without a key: Wikidata and CheapShark
   for Steam IDs (Steam's own search blocks browsers), and the Microsoft Store for upright art. */

const SKIP_PRODUCT = /bundle|add-?ons?|\bdlc\b|upgrade|soundtrack|artbook|season pass/i;

/* "Minecraft: Java & Bedrock Edition for PC" and "Roblox - Xbox" are one game under two names. */
function baseTitle(title) {
  return title
    .replace(/\s+(?:for|-|–)\s+(?:windows|pc|xbox).*$/i, '')
    .replace(/:\s[^:]*\bedition$/i, '')
    .replace(/\s(?:standard|deluxe|premium|ultimate|gold|complete|definitive)\sedition$/i, '')
    .trim();
}

const steamImages = (steamId, ...others) => [{ url: steamArt(steamId), upright: true }, ...others];

async function wikidataGames(query) {
  const WIKIDATA = 'https://www.wikidata.org/w/api.php';
  const { search = [] } = await apiJson(WIKIDATA, {
    action: 'wbsearchentities', search: query, language: 'en', type: 'item', limit: '12',
  });
  const hits = search.filter(s => /\bgame\b/i.test(s.description || '') && !NOT_A_GAME.test(s.description));
  if (!hits.length) return [];
  const { entities = {} } = await apiJson(WIKIDATA, { action: 'wbgetentities', ids: hits.map(s => s.id).join('|'), props: 'claims' });
  return hits.flatMap(hit => {
    const steamId = entities[hit.id]?.claims?.P1733?.[0]?.mainsnak?.datavalue?.value;
    return steamId ? [{
      title: hit.label,
      wikidataId: hit.id,
      steamId,
      year: Number(hit.description.match(/\b(19|20)\d{2}\b/)?.[0]) || null,
      description: hit.description,
      images: steamImages(steamId),
    }] : [];
  });
}

async function steamGames(query) {
  const res = await fetch(`https://www.cheapshark.com/api/1.0/games?${new URLSearchParams({ title: query, limit: '12' })}`);
  if (!res.ok) return [];
  return (await res.json())
    .filter(g => g.steamAppID && !SKIP_PRODUCT.test(g.external))
    .map(g => ({
      title: g.external,
      steamId: g.steamAppID,
      year: null,
      description: 'On Steam',
      images: steamImages(g.steamAppID, { url: g.thumb, upright: false }),
    }));
}

async function xboxGames(query) {
  const CATALOGUE = 'https://displaycatalog.mp.microsoft.com/v7.0';
  const market = { market: 'GB', languages: 'en-GB' };
  const res = await fetch(`${CATALOGUE}/productFamilies/autosuggest?${new URLSearchParams({ ...market, query, productFamilyNames: 'Games' })}`);
  if (!res.ok) return [];
  const { Results = [] } = await res.json();
  const ids = Results.flatMap(r => r.Products)
    .filter(p => p.Type === 'Game' && !SKIP_PRODUCT.test(p.Title))
    .map(p => p.ProductId)
    .slice(0, 10);
  if (!ids.length) return [];
  const details = await fetch(`${CATALOGUE}/products?${new URLSearchParams({ ...market, bigIds: ids.join(',') })}`);
  if (!details.ok) return [];
  const { Products = [] } = await details.json();
  return Products.flatMap(product => {
    const { ProductTitle, Images = [] } = product.LocalizedProperties?.[0] || {};
    const poster = Images.find(image => image.ImagePurpose === 'Poster');
    return poster && ProductTitle ? [{
      title: baseTitle(ProductTitle),
      year: null,
      description: 'Microsoft Store',
      genres: product.Properties?.Categories || [product.Properties?.Category].filter(Boolean),
      images: [{ url: `https:${poster.Uri}?w=600`, upright: true }],
    }] : [];
  });
}

/* Folds matching names into one result, upright art first. Pages that name a year in brackets,
   like Doom (1993 video game), stay apart because the stores can't tell remakes from originals. */
function mergeFound(items) {
  const byName = new Map();
  const merged = [];
  for (const item of items) {
    const key = plainName(baseTitle(item.title));
    const twin = byName.get(key);
    if (!twin) {
      merged.push(item);
      if (!/\(\d{4}\b/.test(item.pageTitle || '')) byName.set(key, item);
      continue;
    }
    twin.steamId ||= item.steamId;
    twin.wikidataId ||= item.wikidataId;
    twin.year ||= item.year;
    twin.genres ||= item.genres;
    twin.images = [...twin.images, ...item.images].sort((a, b) => b.upright - a.upright);
  }
  return merged;
}

const askCatalogues = query => Promise.all(
  [wikidataGames, steamGames, xboxGames].map(ask => ask(query).catch(err => {
    console.warn(err);
    return [];
  })));

async function searchGames(query) {
  const [wiki, firstTry] = await Promise.all([searchWikipedia(query), askCatalogues(query)]);
  // A misspelt name often still reaches a series page, whose title spells it properly.
  const stores = (firstTry.flat().length || !wiki.seriesTitle ? firstTry : await askCatalogues(wiki.seriesTitle)).flat();

  const merged = mergeFound([...wiki.games, ...stores]);
  const wanted = query.toLowerCase();
  const found = (merged.length ? merged : wiki.others)
    .sort((a, b) => closeness(a.title, wanted) - closeness(b.title, wanted))
    .slice(0, 15);
  await Promise.all(found.filter(item => !item.images.length).map(async item => {
    const url = await infoboxImage(item.pageTitle).catch(() => null);
    if (url) item.images.push({ url, upright: false });
  }));
  return found.filter(item => item.images.length || closeness(item.title, wanted) === 0);
}
