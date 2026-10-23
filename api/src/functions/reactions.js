// Reaction counts per song, stored in an Azure Table called "reactions".
// GET  /api/reactions?song=<id>            -> { "🙏": 12, "❤️": 4, ... }
// POST /api/reactions { song, emoji, delta } -> same, after applying +1 / -1
const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");

const ALLOWED = ["🙏", "❤️", "✝️", "🕊️", "🙌", "😢"];
const ID = /^[0-9a-f-]{36}$/i;
let client;
function table() {
  if (!client) {
    client = TableClient.fromConnectionString(process.env.TABLE_CONNECTION_STRING, "reactions");
  }
  return client;
}
async function counts(song) {
  const out = {};
  for await (const e of table().listEntities({ queryOptions: { filter: `PartitionKey eq '${song}'` } })) {
    out[e.rowKey] = e.count || 0;
  }
  return out;
}


// ---------- Admin operations, routed through this function as ?op=... ----------
const SONG = /\/song\/([0-9a-f-]{36})/i;
function authed(req) {
  const pw = process.env.ADMIN_PASSWORD;
  return pw && req.headers.get("x-admin-key") === pw;
}
function decodeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'");
}
function cleanLyrics(raw) {
  // Drop Suno production notes like [Intro], [Pallavi] (Theme), (Acoustic guitar...), and collapse repeats.
  return raw
    .split("\n")
    .map(l => l.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").trim())
    .filter((l, i, a) => l === "" ? (a[i - 1] !== "") : true)
    .filter((l, i, a) => !(l && l === a[i - 1]))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


// Copy a song's MP3 from Suno into our own Blob container and return its public URL.
async function storeAudio(id) {
  const svc = BlobServiceClient.fromConnectionString(process.env.TABLE_CONNECTION_STRING);
  const container = svc.getContainerClient("songs");
  await container.createIfNotExists({ access: "blob" });
  const blob = container.getBlockBlobClient(id + ".mp3");
  if (!(await blob.exists())) {
    const hdr = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Referer": "https://suno.com/", "Origin": "https://suno.com", "Accept": "audio/mpeg,*/*" };
    let r = null, status = 0;
    for (const u of ["https://cdn1.suno.ai/" + id + ".mp3", "https://audiopipe.suno.ai/?item_id=" + id]) {
      try { const x = await fetch(u, { headers: hdr, redirect: "follow" }); if (x.ok) { r = x; break; } status = x.status; } catch (e) {}
    }
    if (!r) throw new Error("Suno audio returned " + status + " (upload the MP3 in the admin page instead)");
    const buf = Buffer.from(await r.arrayBuffer());
    await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: "audio/mpeg", blobCacheControl: "public, max-age=31536000" } });
  }
  return blob.url;
}
// Copy the song's current cover from Suno into our Blob container (always overwrites, so a changed cover is picked up).
async function storeCover(id) {
  const page = await fetch("https://suno.com/song/" + id, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!page.ok) throw new Error("Suno page returned " + page.status);
  const html = await page.text();
  const m = /property="og:image"\s+content="([^"]+)"/.exec(html) || /content="([^"]+)"\s+property="og:image"/.exec(html);
  const src = m ? m[1].replace(/&amp;/g, "&") : "https://cdn2.suno.ai/image_large_" + id + ".jpeg";
  const img = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!img.ok) throw new Error("cover returned " + img.status);
  const svc = BlobServiceClient.fromConnectionString(process.env.TABLE_CONNECTION_STRING);
  const container = svc.getContainerClient("songs");
  await container.createIfNotExists({ access: "blob" });
  const blob = container.getBlockBlobClient(id + ".jpeg");
  await blob.uploadData(Buffer.from(await img.arrayBuffer()), { blobHTTPHeaders: { blobContentType: "image/jpeg", blobCacheControl: "public, max-age=86400" } });
  return blob.url + "?v=" + Date.now().toString(36);
}
async function adminAudioOp(req) {
  if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
  // Backfill: give every song in songs.js an audio file, commit once.
  const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
  const gh = (path, opt = {}) => fetch("https://api.github.com/repos/" + repo + "/contents/" + path, {
    ...opt, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "keertanalu-admin", ...(opt.headers || {}) } });
  const cur = await (await gh("songs.js")).json();
  let text = Buffer.from(cur.content, "base64").toString("utf8");
  const ids = [...text.matchAll(/url: "https:\/\/suno\.com\/song\/([0-9a-f-]{36})/g)].map(m => m[1]);
  const done = [], failed = [];
  for (const id of ids) {
    try {
      const line = new RegExp('(url: "https:\\/\\/suno\\.com\\/song\\/' + id + '[^\n]*\n)');
      if (!new RegExp('audio: "[^"]*' + id).test(text)) {
        const url = await storeAudio(id);
        text = text.replace(line, '$1    audio: ' + JSON.stringify(url) + ',\n');
      }
      const img = await storeCover(id);
      text = text.replace(new RegExp('\n\\s*image: "[^"]*' + id + '[^"]*",'), "");
      text = text.replace(line, '$1    image: ' + JSON.stringify(img) + ',\n');
      done.push(id);
    } catch (e) { failed.push(id + ": " + e.message); }
  }
  if (done.length) {
    const put = await (await gh("songs.js", { method: "PUT", body: JSON.stringify({ message: "Sync audio and covers for " + done.length + " song(s)", content: Buffer.from(text, "utf8").toString("base64"), sha: cur.sha }) })).json();
    if (!put.commit) return { status: 500, jsonBody: { error: "GitHub refused the update: " + (put.message || "") } };
  }
  return { jsonBody: { stored: done.length, failed } };
}
async function adminUploadOp(req) {
  if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
  const id = req.query.get("song");
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) return { status: 400, jsonBody: { error: "bad song id" } };
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 50000) return { status: 400, jsonBody: { error: "That file is too small to be a song" } };
  const svc = BlobServiceClient.fromConnectionString(process.env.TABLE_CONNECTION_STRING);
  const container = svc.getContainerClient("songs");
  await container.createIfNotExists({ access: "blob" });
  const blob = container.getBlockBlobClient(id + ".mp3");
  await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: "audio/mpeg", blobCacheControl: "public, max-age=31536000" } });
  // write audio: into songs.js
  const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
  const gh = (path, opt = {}) => fetch("https://api.github.com/repos/" + repo + "/contents/" + path, {
    ...opt, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "keertanalu-admin", ...(opt.headers || {}) } });
  const cur = await (await gh("songs.js")).json();
  let text = Buffer.from(cur.content, "base64").toString("utf8");
  const line = new RegExp('(url: "https:\\/\\/suno\\.com\\/song\\/' + id + '[^\n]*\n)');
  if (!line.test(text)) return { status: 404, jsonBody: { error: "That song is not in songs.js" } };
  text = text.replace(new RegExp('\n\\s*audio: "[^"]*",(?=[\\s\\S]*' + id + ')'), (m, off) => m); // keep
  text = text.replace(new RegExp('(url: "https:\\/\\/suno\\.com\\/song\\/' + id + '[^\n]*\n)(\\s*audio: "[^"]*",\n)?'), '$1    audio: ' + JSON.stringify(blob.url + "?v=" + Date.now().toString(36)) + ',\n');
  const put = await (await gh("songs.js", { method: "PUT", body: JSON.stringify({ message: "Upload audio for " + id, content: Buffer.from(text, "utf8").toString("base64"), sha: cur.sha }) })).json();
  if (!put.commit) return { status: 500, jsonBody: { error: "GitHub refused the update: " + (put.message || "") } };
  return { jsonBody: { ok: true, size: buf.length } };
}
async function adminFetchOp(req) {
    if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
    let { url } = await req.json();
    url = String(url || "").trim();
    // Short links (suno.com/s/xxxx) redirect to the full song page; follow them.
    if (!SONG.test(url) && /suno\.com\/s\//i.test(url)) {
      const rr = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      url = rr.url;
    }
    const m = SONG.exec(url);
    if (!m) return { status: 400, jsonBody: { error: "That is not a Suno song link (expected suno.com/song/… or suno.com/s/…)" } };
    const id = m[1];
    const r = await fetch("https://suno.com/song/" + id, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return { status: 502, jsonBody: { error: "Suno returned " + r.status + ". Is the song public?" } };
    const html = await r.text();
    const og = (p) => { const x = new RegExp('property="og:' + p + '"\\s+content="([^"]*)"').exec(html) || new RegExp('content="([^"]*)"\\s+property="og:' + p + '"').exec(html); return x ? decodeHtml(x[1]) : ""; };
    let lyrics = "";
    const pm = /\\"prompt\\":\\"((?:[^"\\]|\\.)*?)\\"/.exec(html) || /"prompt":"((?:[^"\\]|\\.)*?)"/.exec(html);
    if (pm) { try { lyrics = JSON.parse('"' + pm[1].replace(/\\\\/g, "\\") + '"'); } catch (e) { lyrics = pm[1].replace(/\\n/g, "\n"); } }
    return { jsonBody: { id, url: "https://suno.com/song/" + id, title: og("title"), image: og("image") || `https://cdn2.suno.ai/image_large_${id}.jpeg`, lyrics: cleanLyrics(lyrics), rawLyrics: lyrics } };
}
async function adminPublishOp(req) {
    if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
    const s = await req.json();
    if (!SONG.test(s.url || "") || !s.title) return { status: 400, jsonBody: { error: "link and title are required" } };
    const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
    if (!repo || !token) return { status: 500, jsonBody: { error: "GITHUB_REPO / GITHUB_TOKEN not set on the Static Web App" } };
    const gh = (path, opt = {}) => fetch("https://api.github.com/repos/" + repo + "/contents/" + path, {
      ...opt, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "keertanalu-admin", ...(opt.headers || {}) } });
    const cur = await (await gh("songs.js")).json();
    if (!cur.content) return { status: 500, jsonBody: { error: "could not read songs.js: " + (cur.message || "") } };
    let text = Buffer.from(cur.content, "base64").toString("utf8");
    const id = SONG.exec(s.url)[1];
    if (text.includes(id)) return { status: 409, jsonBody: { error: "This song is already on the site" } };
    let audio = "", image = "";
    try { audio = await storeAudio(id); } catch (e) { audio = ""; }
    try { image = await storeCover(id); } catch (e) { image = ""; }
    const block = [
      "  {",
      "    url: " + JSON.stringify(s.url) + ",",
      "    audio: " + JSON.stringify(audio) + ",",
      "    image: " + JSON.stringify(image) + ",",
      "    title: " + JSON.stringify(s.title) + ",",
      "    english: " + JSON.stringify(s.english || "") + ",",
      "    tags: " + JSON.stringify((s.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)) + ",",
      "    date: " + JSON.stringify(s.date || new Date().toISOString().slice(0, 10)) + ",",
      "    lyrics: " + JSON.stringify(s.lyrics || ""),
      "  },\n"
    ].join("\n");
    const marker = "window.SONGS = [\n";
    if (!text.includes(marker)) return { status: 500, jsonBody: { error: "songs.js has an unexpected format" } };
    text = text.replace(marker, marker + block);
    const put = await (await gh("songs.js", { method: "PUT", body: JSON.stringify({ message: "Add song: " + s.title, content: Buffer.from(text, "utf8").toString("base64"), sha: cur.sha }) })).json();
    if (!put.commit) return { status: 500, jsonBody: { error: "GitHub refused the update: " + (put.message || "") } };
    return { jsonBody: { ok: true, id } };
}

app.http("reactions", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    const op = req.query.get("op");
    if (op === "health") return { jsonBody: { ok: true, passwordSet: !!process.env.ADMIN_PASSWORD, repoSet: !!process.env.GITHUB_REPO, tokenSet: !!process.env.GITHUB_TOKEN } };
    if (op === "fetch") return adminFetchOp(req);
    if (op === "publish") return adminPublishOp(req);
    if (op === "audio") return adminAudioOp(req);
    if (op === "upload") return adminUploadOp(req);
    if (op === "songs") { const t = await (await fetch("https://raw.githubusercontent.com/" + process.env.GITHUB_REPO + "/main/songs.js")).text(); const list = [...t.matchAll(/url: "https:\/\/suno\.com\/song\/([0-9a-f-]{36})[^\n]*\n(?:\s*audio: "([^"]*)",\n)?(?:\s*image: "[^"]*",\n)?\s*title: "([^"]*)"/g)].map(m => ({ id: m[1], audio: !!m[2], title: m[3] })); return { jsonBody: list, headers: { "Cache-Control": "no-store" } }; }
    try {
      await table().createTable().catch(() => {});
      if (req.method === "GET") {
        const song = req.query.get("song");
        if (!ID.test(song || "")) return { status: 400, jsonBody: { error: "bad song id" } };
        return { jsonBody: await counts(song), headers: { "Cache-Control": "no-store" } };
      }
      const body = await req.json();
      const { song, emoji } = body;
      const delta = body.delta === -1 ? -1 : 1;
      if (!ID.test(song || "") || !ALLOWED.includes(emoji)) return { status: 400, jsonBody: { error: "bad request" } };
      let current = 0;
      try { current = (await table().getEntity(song, emoji)).count || 0; } catch (e) {}
      await table().upsertEntity({ partitionKey: song, rowKey: emoji, count: Math.max(0, current + delta) }, "Merge");
      return { jsonBody: await counts(song), headers: { "Cache-Control": "no-store" } };
    } catch (err) {
      const detail = process.env.TABLE_CONNECTION_STRING ? (err && err.message ? String(err.message).slice(0, 200) : "unknown error") : "TABLE_CONNECTION_STRING is not set";
      return { status: 500, jsonBody: { error: "storage error", detail } };
    }
  }
});
