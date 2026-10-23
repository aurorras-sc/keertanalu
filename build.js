// Generates s/<song-id>.html for every song: a tiny page with the song's title and
// artwork as link-preview tags (WhatsApp, Facebook, X), which then opens the player.
// Runs automatically on deploy (see .github workflow). Run locally with: node build.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync("songs.js", "utf8"), ctx);
const songs = (ctx.window.SONGS || []).filter(s => /\/song\/([0-9a-f-]{36})/i.test(s.url || ""));

const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
songs.forEach((s, i) => { s._i = i; });
const byDate = songs.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || (b._i - a._i));
byDate.forEach((s, i) => { s.no = s.number || i + 1; });
for (const s of songs) {
  const id = /\/song\/([0-9a-f-]{36})/i.exec(s.url)[1];
  const desc = s.english ? s.english + " · Telugu Christian song" : "Telugu Christian song";
  const page = `<!doctype html><html lang="te"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)} — కీర్తనలు</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="music.song"><meta property="og:site_name" content="కీర్తనలు">
<meta property="og:title" content="${esc(s.title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(s.image || "https://cdn2.suno.ai/image_large_" + id + ".jpeg")}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(s.title)}"><meta name="twitter:image" content="${esc(s.image || "https://cdn2.suno.ai/image_large_" + id + ".jpeg")}">
<meta http-equiv="refresh" content="0; url=/#${s.no}">
<script>location.replace("/#${s.no}");</script>
</head><body style="font-family:system-ui;padding:40px;text-align:center"><p><a href="/#${s.no}">${esc(s.title)}</a></p></body></html>`;
  for (const key of [id, String(s.no)]) { fs.mkdirSync(path.join("s", key), { recursive: true }); fs.writeFileSync(path.join("s", key, "index.html"), page); }
}
console.log("wrote", songs.length, "share pages");
