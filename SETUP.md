# Setup. Do these in order.
You need: a Rista API key + secret, a free Cloudflare account, Node.js on your computer.
NEVER paste the key or secret in chat, in GitHub, or in the HTML.

1. Rista: ask admin to create API key + secret (Access menu). Needs Sales Enterprise + API licence.
2. GitHub: make a new repo for THIS folder (private is fine). Name it e.g. `rr-durbar-api`.
   Check `.gitignore` is there. Upload the folder.
3. On your computer, open a terminal in this folder:
   `npm install`
   `npx wrangler login`
4. Open `wrangler.toml`:
   - ALLOWED_ORIGINS = your Cloudflare Pages address. Example: `https://rr-durbar.pages.dev` (no path, no slash at the end).
   - CHANNEL = the exact name of the new website channel in Rista (now "Website", confirm it).
5. Add the secrets. Each command asks you to type the value:
   `npx wrangler secret put RISTA_KEY`
   `npx wrangler secret put RISTA_SECRET`
   `npx wrangler secret put DEBUG_TOKEN`   (long random text, 30+ letters. Protects the debug link.)
6. Deploy: `npx wrangler deploy`
   It prints an address like `https://rr-durbar-api.YOURNAME.workers.dev`
7. Check it works. Open in browser:
   - `.../api/health`  should show `"configured":true`
   - `.../api/outlets` should show 6 outlets. Each has `status`: open / closed / call / unknown.
8. Debug links. Replace TOKEN with your DEBUG_TOKEN. Replace CHANNEL with your channel name (space = %20).
   Open each one, copy the whole reply, send it to me. Prices are fine. Never send the token, key or secret.
   1) `.../api/debug?token=TOKEN&path=/branch/list`
      (shows each outlet's address, lat/lng, status and its CHANNELS. This also tells us the exact channel name.)
   2) `.../api/debug?token=TOKEN&path=/branch&branchCode=MR`
      (business hours)
   3) `.../api/debug?token=TOKEN&path=/catalog&branch=MR&channel=CHANNEL`
      (the dishes. This one is the most important.)
   4) `.../api/debug?token=TOKEN&path=/stockStatus&branch=MR&channel=CHANNEL`
      (sold-out list)
   5) `.../api/debug?token=TOKEN&path=/catalog/enterprise`
      (dish PHOTOS. Look for `imageURL` inside `displayBooks`. This reply is big. Send me only `displayBooks` if it is too long,
       with 3 or 4 dishes, and tell me which dishes you see photos for in Rista.)
   6) `.../api/debug?token=TOKEN&path=/catalog/item/list`
      (business-level item list. Look for any image field.)
   Optional, only if the channel is linked to an aggregator (needs `orderSource`):
   `.../api/debug?token=TOKEN&path=/outlet/status&branch=MR&channel=CHANNEL&orderSource=zomato`
9. If the channel name is wrong, change CHANNEL in `wrangler.toml` and deploy again.
10. Test on your computer: `npm test` (24 tests, no Rista needed).

Later: to stop everything fast, delete the Worker in Cloudflare or rotate the key in Rista.
Safety: if the key was ever pasted somewhere public, make a new key in Rista.
