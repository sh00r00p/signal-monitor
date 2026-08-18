const https = require("https");

const SUPABASE_URL = "https://yljybhpxmfaremvmdkgm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Per-query: { q: search string, geo?: locale code }
// geo present  -> &gl=XX&ceid=XX:en (US-specific topics)
// geo absent   -> global English (no gl param)
const QUERIES = [
  // === US-specific: California water rights jurisdiction ===
  { q: '"pre-1914" water rights', geo: "US" },
  { q: "CalWATRS OR eWRIMS", geo: "US" },
  { q: 'SGMA enforcement OR "groundwater sustainability plan"', geo: "US" },
  { q: '"water rights" curtailment OR senior OR junior', geo: "US" },
  { q: '"paper water" OR "wet water" water rights', geo: "US" },

  // === Global English ===
  { q: '"water rights" acquisition OR sale OR trading' },
  { q: 'aquifer depletion OR overdraft OR "groundwater decline"' },
  { q: '"water stress" crisis OR "Day Zero"' },
  { q: "drought emergency declaration" },
  { q: 'snowpack record low OR "below average"' },
  { q: '"data center" moratorium OR ban OR protest' },
  { q: '"data center" water OR cooling impact community' },
  { q: '"interconnection queue" OR "transformer shortage"' },
  { q: '"data center" "rate case" OR "large load tariff" OR "special rate class" OR "electric rate"' },
  { q: "water infrastructure attack OR sabotage OR cyberattack" },

  // === Central Asia / CIS (KZ + cascade signals) ===
  { q: "Caspian Sea level OR shrink OR shallowing" },
  { q: 'Aral Sea OR "Syr Darya" OR "Amu Darya"' },
  { q: "Kazakhstan water OR Balkhash OR Ili river" },
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SignalMonitor/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "";
    items.push({
      title: decodeEntities(title).trim(),
      link: link.trim(),
      source: decodeEntities(source).trim(),
      published_at: pubDate ? new Date(pubDate).toISOString() : null,
    });
  }
  return items;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const TITLE_STOPWORDS = new Set(
  "a an the of to in on for and or is are was were as at by with from its it this that new says say said after over amid into be been will would could can may might not no than then them they he she his her you your we our us".split(" ")
);

// Google News titles carry a " - Outlet" suffix; strip it, then reduce to a
// content-word set so the same story filed by two outlets collapses to one.
function titleTokens(title) {
  return new Set(
    title
      .replace(/\s+-\s+[^-]{2,40}$/, "")
      .toLowerCase()
      .replace(/[\u2019']/g, "")
      .replace(/[^a-z0-9%.]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w))
  );
}

const MONTHS = new Set(
  "january february march april may june july august september october november december".split(" ")
);

// Recurring reports reuse one title and differ only by date
// ("Snow Drought ... | April 9, 2026" vs "... | March 12, 2026"). Those are
// distinct editions, so a date mismatch blocks the merge outright.
function dateMarkers(tokens) {
  const marks = new Set();
  for (const t of tokens) {
    if (MONTHS.has(t)) marks.add(t);
    else if (/^(19|20)\d{2}$/.test(t)) marks.add(t);
  }
  return marks;
}

function sameDateMarkers(a, b) {
  const ma = dateMarkers(a), mb = dateMarkers(b);
  if (ma.size !== mb.size) return false;
  for (const t of ma) if (!mb.has(t)) return false;
  return true;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// 0.7 is deliberately strict. Measured on a real day of output (1197 items):
// 0.7 drops 2.3% with no false merges observed; 0.6 drops 2.8% but merged two
// distinct state drought declarations (Colorado / Idaho). Differently-worded
// coverage of one story does NOT collapse here -- that needs content-level
// clustering, not title matching.
const TITLE_SIM_THRESHOLD = 0.7;

function supabaseDelete(olderThanDays) {
  return new Promise((resolve, reject) => {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const path = `/rest/v1/signals_raw?created_at=lt.${cutoff}&is_relevant=is.null`;
    // NOTE: rows are only ever kept by this cleanup if is_relevant has been set.
    // Nothing sets it automatically, so in practice the table is a rolling
    // RETENTION_DAYS window. Mark rows you want to keep (is_relevant = true).
    const options = {
      hostname: "yljybhpxmfaremvmdkgm.supabase.co",
      path,
      method: "DELETE",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        Prefer: "return=headers-only,count=exact",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const count = res.headers["content-range"];
          resolve(count || "ok");
        } else {
          reject(new Error(`Cleanup ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function supabasePost(records) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(records);
    const options = {
      hostname: "yljybhpxmfaremvmdkgm.supabase.co",
      path: "/rest/v1/signals_raw?on_conflict=title,source",
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let inserted = 0;
          try {
            const parsed = JSON.parse(data);
            inserted = Array.isArray(parsed) ? parsed.length : 0;
          } catch (e) {
            inserted = 0;
          }
          resolve(inserted);
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function fetchQuery({ q, geo }) {
  const encoded = encodeURIComponent(q);
  let url = `https://news.google.com/rss/search?q=${encoded}&hl=en&when=7d`;
  if (geo) url += `&gl=${geo}&ceid=${geo}:en`;
  try {
    const xml = await fetchUrl(url);
    return parseRSS(xml);
  } catch (e) {
    console.error(`Failed to fetch "${q}": ${e.message}`);
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!SUPABASE_KEY) {
    console.error("SUPABASE_KEY env var is required");
    process.exit(1);
  }

  // Cleanup: delete unreviewed signals older than RETENTION_DAYS (default 90).
  const retentionDays = Number(process.env.RETENTION_DAYS || 90);
  try {
    const result = await supabaseDelete(retentionDays);
    console.log(`Cleanup (>${retentionDays} days, unreviewed): ${result}`);
  } catch (e) {
    console.error(`Cleanup error: ${e.message}`);
  }

  console.log(`Fetching signals for ${QUERIES.length} queries...`);
  const allItems = [];
  const seenKeys = new Set();

  let totalReprints = 0;

  for (const entry of QUERIES) {
    const items = await fetchQuery(entry);
    const queryTokens = []; // reprint detection is per-query, not global
    let reprints = 0;
    for (const item of items) {
      if (!item.title) continue;
      const key = `${item.title}|||${item.source}`;
      if (seenKeys.has(key)) continue;
      const tokens = titleTokens(item.title);
      if (queryTokens.some((t) => jaccard(t, tokens) >= TITLE_SIM_THRESHOLD && sameDateMarkers(t, tokens))) {
        reprints++;
        continue;
      }
      queryTokens.push(tokens);
      seenKeys.add(key);
      allItems.push({ ...item, query: entry.q });
    }
    totalReprints += reprints;
    const tag = entry.geo ? `[${entry.geo}]` : "[global]";
    console.log(`  ${tag} "${entry.q.substring(0, 40)}..." -> ${items.length} items, ${reprints} reprints`);
    await sleep(1000); // rate limit
  }

  console.log(`Reprints collapsed: ${totalReprints}`);

  console.log(`Total unique items: ${allItems.length}`);

  if (allItems.length === 0) {
    console.log("No items to insert.");
    return;
  }

  // Insert in batches of 50
  let totalNew = 0;
  let totalSkipped = 0;
  for (let i = 0; i < allItems.length; i += 50) {
    const batch = allItems.slice(i, i + 50);
    try {
      const inserted = await supabasePost(batch);
      totalNew += inserted;
      totalSkipped += batch.length - inserted;
      console.log(`Batch ${Math.floor(i / 50) + 1}: ${inserted} new, ${batch.length - inserted} duplicates`);
    } catch (e) {
      console.error(`Batch insert error: ${e.message}`);
    }
  }

  console.log(`Done. ${totalNew} new signals, ${totalSkipped} duplicates skipped.`);
}

main();
