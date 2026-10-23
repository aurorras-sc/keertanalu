// Admin API: fetch a Suno song's details, and publish a song into songs.js on GitHub.
// Protected by the ADMIN_PASSWORD environment variable (sent as header x-admin-key).
// Needs GITHUB_TOKEN (fine-grained, Contents: read/write on the repo) and GITHUB_REPO ("owner/name").
const { app } = require("@azure/functions");

const ID = /\/song\/([0-9a-f-]{36})/i;
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

app.http("adminfetch", {
  methods: ["GET", "POST"], authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "GET") return { jsonBody: { ok: true, function: "adminfetch", passwordSet: !!process.env.ADMIN_PASSWORD, repoSet: !!process.env.GITHUB_REPO, tokenSet: !!process.env.GITHUB_TOKEN } };
    if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
    let { url } = await req.json();
    url = String(url || "").trim();
    // Short links (suno.com/s/xxxx) redirect to the full song page; follow them.
    if (!ID.test(url) && /suno\.com\/s\//i.test(url)) {
      const rr = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      url = rr.url;
    }
    const m = ID.exec(url);
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
});

app.http("adminpublish", {
  methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    if (!authed(req)) return { status: 401, jsonBody: { error: "wrong password" } };
    const s = await req.json();
    if (!ID.test(s.url || "") || !s.title) return { status: 400, jsonBody: { error: "link and title are required" } };
    const repo = process.env.GITHUB_REPO, token = process.env.GITHUB_TOKEN;
    if (!repo || !token) return { status: 500, jsonBody: { error: "GITHUB_REPO / GITHUB_TOKEN not set on the Static Web App" } };
    const gh = (path, opt = {}) => fetch("https://api.github.com/repos/" + repo + "/contents/" + path, {
      ...opt, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "keertanalu-admin", ...(opt.headers || {}) } });
    const cur = await (await gh("songs.js")).json();
    if (!cur.content) return { status: 500, jsonBody: { error: "could not read songs.js: " + (cur.message || "") } };
    let text = Buffer.from(cur.content, "base64").toString("utf8");
    const id = ID.exec(s.url)[1];
    if (text.includes(id)) return { status: 409, jsonBody: { error: "This song is already on the site" } };
    const block = [
      "  {",
      "    url: " + JSON.stringify(s.url) + ",",
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
});
