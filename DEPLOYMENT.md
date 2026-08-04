# Cloudflare deployment and operations

Wine Night runs on Cloudflare Workers. Each room has its own Durable Object with an embedded SQLite database. There is no separate database
service to provision.

This guide covers initial deployment, updates, backups, monthly downtime, and permanent teardown. The recommended monthly workflow is to
take the app offline without deleting the Worker or its data.

## Prerequisites

Install dependencies and authenticate Wrangler:

```bash
npm install
npx wrangler login
```

For CI, provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the CI provider's secret settings.

## Deploy or update

Deploy to the default `workers.dev` address:

```bash
npm run deploy
```

The default address is `https://wine-night.<your-account-subdomain>.workers.dev`. Wrangler prints the exact address after deployment. This
is a public Cloudflare URL.

Run the same command whenever application code changes. Durable Object migrations in `wrangler.jsonc` preserve existing room data during a
normal update.

## Use a custom domain

The hostname does not need to be committed to `wrangler.jsonc`. Pass it to the deployment command:

```bash
npm run deploy:domain -- wine.example.com
```

For a repeatable local or CI command, keep the value outside the repository:

```bash
export WINE_NIGHT_DOMAIN="wine.example.com"
npm run deploy:domain -- "$WINE_NIGHT_DOMAIN"
```

`WINE_NIGHT_DOMAIN` is used only by the shell command. It is not a Worker runtime binding and is not exposed to the application. The
hostname must belong to an active Cloudflare zone and must not already have a CNAME record. Cloudflare provisions the DNS record and
certificate when the Custom Domain is attached.

Rooms use short paths such as `wine.example.com/GRAPE`. The equivalent `/?room=GRAPE` form is also supported.

## Back up a room

The host can select **Download room backup** during setup or after the full results reveal. The downloaded JSON file is a portable Wine
Night archive, not a raw SQLite database. Once a ballot has been submitted, downloads remain locked until the full reveal so the backup
cannot be used to inspect votes early.

The archive contains:

- Theme, pot contribution, and host display name
- Wine names, producers, prices, contributors, and tasting order
- Submitted participants, voting methods, numeric scales, and ratings

It intentionally excludes private tasting notes, host keys, and participant keys. Participants who joined but did not submit a ballot are
also excluded because they contributed no result data.

Keep backup files private. They contain participant names and individual ballots.

## Restore a room

From the landing page, select **Start a new night**, open **Restore a room backup**, and choose the JSON file. Enter a new room code or leave
it blank to generate one.

Restore always creates a new room and fresh credentials:

- A setup-only archive returns to setup and can be edited normally.
- An archive containing submitted ballots opens as completed, fully revealed results.

The importer accepts the current versioned Wine Night archive format, validates every reference and ballot, limits uploads to 1 MB, and
rejects restore attempts into an existing room.

## Recommended monthly downtime

Do not run `npm run destroy` merely to take the app offline. Preserve the Worker and Durable Object namespace, then remove its public routes:

1. Download backups for rooms you want to retain.
2. In the Cloudflare dashboard, open the Worker and go to **Settings > Domains & Routes**.
3. Disable the `workers.dev` route if it is enabled.
4. Detach the Custom Domain if one is attached.
5. Confirm that neither public address reaches the Worker.

An idle Durable Object that receives no requests does not accrue compute-duration usage. Keeping the deployment also preserves Cloudflare's
recovery history and avoids destructive namespace recreation. See Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [`workers.dev` routing documentation](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Wine Night automatically expires an inactive room after 90 days. Monthly downtime is comfortably inside that window, but a portable backup
is still recommended.

To bring the app back online, re-enable the `workers.dev` route or reattach the Custom Domain under **Settings > Domains & Routes**. Deploy
the latest code before the event if an update is available.

Cloudflare may leave an automatically generated Advanced Certificate after a Custom Domain is detached. If that happens, remove the unused
certificate under **SSL/TLS > Edge Certificates**.

## Cloudflare recovery versus a portable backup

SQLite-backed Durable Objects support point-in-time recovery for the previous 30 days. This is useful for recovering from an accidental data
change inside an existing object, but it is not a portable backup. Recovery history belongs to the existing Durable Object namespace and is
lost when that data is permanently deleted. See the [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Durable Object migration documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

[Cloudflare Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/) can inspect an individual Durable
Object database, but the application archive is the supported way to move a Wine Night room between deployments.

## Permanent teardown

Download any required room backups first. Then preview the target and delete it:

```bash
npm run destroy:dry-run
npm run destroy
```

This is destructive. `wrangler delete` removes the Worker and its associated Durable Object data. Cloudflare does not provide a trash or
undelete step for a deleted namespace.

After deletion, verify **Workers & Pages > Settings > Domains & Routes** and the zone's DNS records. Also remove an unused Advanced
Certificate if Cloudflare retained one.

## Public hosting safety

The Workers Free plan uses hard daily limits. Traffic beyond those limits fails instead of creating an overage charge, though abusive
traffic could make the app unavailable until limits reset. Wine Night limits room creation, restores, participants, wines, request sizes,
WebSocket connections, and inactive-room lifetime.

For a custom domain that will be broadly publicized, add a Free plan WAF rate-limiting rule for `/api/host/create` and `/api/host/restore`.
Consider Bot Fight Mode as another broad filter. A server-validated Cloudflare Turnstile challenge on room creation and restoration is the
strongest next step if automated creation appears in the logs.

If the account later moves to Workers Paid, create a Cloudflare budget alert. Budget alerts notify rather than cap usage.
