// Reaction counts per song, stored in an Azure Table called "reactions".
// GET  /api/reactions?song=<id>            -> { "🙏": 12, "❤️": 4, ... }
// POST /api/reactions { song, emoji, delta } -> same, after applying +1 / -1
const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");

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

app.http("reactions", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (req) => {
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
      return { status: 500, jsonBody: { error: "storage not configured" } };
    }
  }
});
