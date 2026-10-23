// Generates s/<song-id>.html for every song: a tiny page with the song's title and
// artwork as link-preview tags (WhatsApp, Facebook, X), which then opens the player.
// Runs automatically on deploy (see .github workflow). Run locally with: node build.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync("songs.js", "utf8"), ctx);
const songs = (ctx.window.SONGS || []).filter(s => /\/song\/([0-9a-f-]{36})/i.test(s.url || ""));
fs.mkdirSync("s", { recursive: true });
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
for (const s of songs) {
  const id = /\/song\/([0-9a-f-]{36})/i.exec(s.url)[1];
  const desc = s.english ? s.english + " · Telugu Christian song" : "Telugu Christian song";
  fs.writeFileSync(path.join("s", id + ".html"), `<!doctype html><html lang="te"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)} — కీర్తనలు</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="music.song"><meta property="og:site_name" content="కీర్తనలు">
<meta property="og:title" content="${esc(s.title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://cdn2.suno.ai/image_large_${id}.jpeg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(s.title)}"><meta name="twitter:image" content="https://cdn2.suno.ai/image_large_${id}.jpeg">
<meta http-equiv="refresh" content="0; url=../#${id}">
<script>location.replace("../#${id}");</script>
</head><body style="font-family:system-ui;padding:40px;text-align:center"><p><a href="../#${id}">${esc(s.title)}</a></p></body></html>`);
}
console.log("wrote", songs.length, "share pages");
