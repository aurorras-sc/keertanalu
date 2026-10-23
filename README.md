# కీర్తనలు — Telugu Christian songs portal

Static site. No build tools needed to edit it.

## Add a song
Open `songs.js`, copy the first `{ ... },` block, paste it at the top of the list, change `url` to the new Suno share link, set title / english / tags / date, optionally paste lyrics. Commit. The site redeploys itself.

The song must be Public on Suno for the embedded player to work.

## Share links
`build.js` creates one small page per song in `s/` with the song title and artwork as link-preview tags, so a shared link shows the song in WhatsApp, Facebook, X etc. It runs automatically on every deploy (the workflow has a `node build.js` step). Share links look like `https://your-site/s/<song-id>.html`.

## Comments
Comments use Cusdis. Sign up at https://cusdis.com, add a website, copy the App ID into `window.SETTINGS.cusdisAppId` in `songs.js`. Approve comments in the Cusdis dashboard; they appear under the song once approved.

## Reactions (🙏 Amen etc.)
Counts are stored by a small API in `api/` (Azure Functions, included free with Static Web Apps) in an Azure Table.
One-time setup after the Static Web App exists:
1. Azure portal → Storage accounts → Create (name e.g. `keertanalu`, region East US 2, Standard, LRS). Open it → Security + networking → Access keys → copy "Connection string".
2. Static Web App → Environment variables (or Configuration) → Add: name `TABLE_CONNECTION_STRING`, value = the connection string → Save.
3. In the GitHub workflow file, set `api_location: "api"`.
Until this is done the buttons still work but counts are per device only.

## Adding songs the easy way (admin page)
Open `https://<your-site>/admin.html`, enter the admin password, paste the Suno link, check the details, Publish. The song is committed to `songs.js` on GitHub and the site redeploys in ~2 minutes.
One-time setup — three environment variables on the Static Web App:
- `ADMIN_PASSWORD` — any strong password you choose
- `GITHUB_REPO` — `aurorras-sc/keertanalu`
- `GITHUB_TOKEN` — a fine-grained GitHub token for that repo with Contents: Read and write (set a long expiry; renew when it expires)
