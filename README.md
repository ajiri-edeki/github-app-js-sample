# Connect & Listen GitHub Connector Wrapper

A local-first GitHub connector fixture based on the archived
[`github/github-app-js-sample`](https://github.com/github/github-app-js-sample) project. A GitHub App installation becomes a **Connection**, an installation grant becomes a safe **Grant**, and each selected repository becomes one **Source**. Signed GitHub webhooks are recorded, correlated, queued, and processed by a small local worker.

This project is a QA fixture and demonstration application. It does not represent production INK behavior, must not be connected to customer data, and does not contain test cases or release acceptance logic.

## Requirements

- Node.js 20 or newer
- npm
- A disposable GitHub account or organization for real-provider use
- A GitHub App and a webhook tunnel for real deliveries

## Local setup

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm start
```

Open <http://localhost:3000>. For provider-free local exploration, set `TEST_MODE=true`, restart, and use <http://localhost:3000/diagnostics> to seed fixtures.

The SQLite database and its parent directory are created automatically. To reset fixture data, use `POST /api/diagnostics/reset` or the Diagnostics page while local test mode is enabled.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port; defaults to `3000` |
| `APP_BASE_URL` | Yes for GitHub | Public application origin, or the local origin when using a tunnel |
| `GITHUB_APP_ID` | Yes for GitHub | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes for GitHub | PEM private key. Escaped `\n` line breaks are supported. Never expose it in browser code. |
| `GITHUB_CLIENT_ID` | Only if later adding OAuth | Reserved for GitHub OAuth configuration |
| `GITHUB_CLIENT_SECRET` | Only if later adding OAuth | Reserved; never returned or persisted |
| `GITHUB_WEBHOOK_SECRET` | Yes for GitHub | Secret used for `X-Hub-Signature-256` verification |
| `DATABASE_PATH` | No | SQLite path; defaults to `./data/connect-listen.sqlite` |
| `TEST_MODE` | No | Enables loopback-only diagnostic controls when exactly `true` |
| `WEBHOOK_PROXY_URL` | No | Documents the selected Smee/tunnel endpoint |
| `ENTERPRISE_HOSTNAME` | No | GitHub Enterprise Server hostname |

Do not commit `.env`, private keys, access tokens, webhook secrets, or provider account information. Installation access tokens are obtained in memory by Octokit and are never returned to the browser or stored in SQLite.

## GitHub App configuration

1. Create a GitHub App in a disposable account or organization.
2. Set the homepage URL to `APP_BASE_URL`.
3. Set the setup URL to `${APP_BASE_URL}/api/github/callback` and enable redirect-on-update if desired.
4. Set the webhook URL to `${APP_BASE_URL}/api/github/webhooks` and use the same secret as `GITHUB_WEBHOOK_SECRET`.
5. Grant read access to repository metadata and to the event families you intend to exercise. Add write permissions only if a separate fixture scenario truly requires them.
6. Subscribe to the desired repository events. The supported activity catalog is: issues, issue comments, sub-issues, issue dependencies, pull requests, pull request reviews, pull request review comments and threads, discussions and comments, releases, milestones, pushes, branch/tag create and delete, commit comments, wiki (`gollum`), forks, and public events.
7. Install the app on a disposable personal account or organization, for all repositories or selected repositories.

Select **Add GitHub** in the application. The callback creates or reuses the Connection and Grant; the Connection page discovers repositories available to the installation.

## Local webhook setup

Choose one tunnel and use its public URL for `APP_BASE_URL` and the GitHub App webhook URL.

Smee:

```powershell
npx smee-client -u https://smee.io/YOUR_CHANNEL -t http://localhost:3000/api/github/webhooks
```

ngrok:

```powershell
ngrok http 3000
```

Cloudflare Tunnel:

```powershell
cloudflared tunnel --url http://localhost:3000
```

GitHub must send the webhook directly (or through a byte-preserving proxy) because signature verification uses the raw request body. Smee forwards the GitHub headers and body to the local endpoint.

## State model

- **Connection:** one GitHub App installation. States: `Active`, `Reauth required`, `Disabled`.
- **Source:** exactly one GitHub repository, identified across rename by its numeric repository ID and `node_id`. States: `Working`, `Broken`, `Disabled`, `Reauth required`.
- **Grant:** safe installation authorization metadata only. It never contains a private key, OAuth token, installation token, or webhook secret.
- **Identity:** the minimum safe sender ID/login observed from a signed webhook, scoped to its Connection.
- **Delivery:** safe webhook envelope metadata, correlation ID, queue status, retries, and processing attempts. Full webhook payloads are not persisted.

Installation and repository lifecycle events update reach and health machinery but are filtered from ordinary Source activity. Repository rename events update names while preserving Source identity. Transfer events update ownership metadata and should be followed by a repository refresh or reauthorization if the installation changed.

## UI routes

| Route | Purpose |
| --- | --- |
| `/` | Dashboard and recent activity |
| `/connections` | Connection list and health counts |
| `/connections/new` | Add GitHub flow |
| `/connections/:id` | Connection, Grant, Source, and repository discovery details |
| `/sources/:id` | Source health, activity, and lifecycle controls |
| `/events` | Webhook delivery history |
| `/diagnostics` | Loopback-only controls; available only with `TEST_MODE=true` |

## API reference

All responses contain safe metadata. No endpoint returns configured secrets or provider tokens.

| Method and route | Purpose |
| --- | --- |
| `GET /health` | Process, worker, and configuration readiness |
| `GET /api/github/install` | Start GitHub App installation |
| `GET /api/github/callback?installation_id=…` | Record installation and redirect to its Connection |
| `POST /api/github/webhooks` | Verify and receive GitHub webhooks |
| `GET /api/connections` | List Connections with derived health |
| `GET /api/connections/:id` | Read Connection, Grant, Sources, and safe Identities |
| `GET /api/connections/:id/repositories` | Discover installation repositories and selection state |
| `POST /api/connections/:id/reauthorize` | Mark reauthorization required and return installation URL |
| `GET /api/sources?connection_id=…` | List Sources |
| `POST /api/sources` | Create/reuse a Source using `connection_id` and `repository_id` |
| `GET /api/sources/:id` | Read Source health and recent activity |
| `POST /api/sources/:id/disable` | Disable only this Source |
| `POST /api/sources/:id/enable` | Re-enable this Source |
| `POST /api/sources/:id/mark-broken` | Mark Source broken, with optional `cause` |
| `POST /api/sources/:id/restore` | Restore Source to Working |
| `POST /api/sources/:id/remove` | Stop listening without destroying identity/history |
| `POST /api/sources/:id/refresh` | Refresh provider repository metadata |
| `GET /api/deliveries` | List delivery history |
| `GET /api/deliveries/:id` | Read a delivery and its processing attempts |
| `POST /api/deliveries/:id/replay` | Replay in local test mode |

JSON mutation requests use `Content-Type: application/json`.

## Local diagnostic controls

Diagnostics require both `TEST_MODE=true` and a loopback client address. They are intentionally returned as 404 outside that boundary.

| Method and route | Control |
| --- | --- |
| `POST /api/diagnostics/reset` | Reset local fixture records and diagnostic state |
| `POST /api/diagnostics/seed/connection` | Seed a Connection |
| `POST /api/diagnostics/seed/source` | Seed a working Source and Connection |
| `POST /api/diagnostics/seed/broken-source` | Seed a broken Source |
| `POST /api/diagnostics/seed/disabled-source` | Seed a disabled Source |
| `POST /api/diagnostics/worker/pause` | Pause queue consumption |
| `POST /api/diagnostics/worker/resume` | Resume queue consumption |
| `POST /api/diagnostics/worker/delay` | Set `delay_ms` from 0 through 30000 |
| `POST /api/diagnostics/worker/fail-next` | Fail the next queued delivery once |
| `POST /api/diagnostics/clock/advance` | Advance using `milliseconds` or `minutes` |
| `POST /api/diagnostics/connections/:id/force-reauth` | Force reauthorization state |
| `GET /api/diagnostics/export` | Export safe persisted and derived state |

Replay is exposed beside eligible deliveries on `/events` in test mode.

## Persistence and processing

`npm run db:migrate` creates the SQLite schema. The application also migrates at startup. SQLite stores Connections, Sources, Grants, safe Identities, delivery envelopes, processing attempts, health transitions, provenance, and diagnostic state.

The worker polls locally, processes one queued delivery at a time, filters disabled Sources, records every attempt, prevents duplicate activity through GitHub's unique delivery ID, and updates persisted Source health. Retry counts and replay counts are separate. Raw webhook payloads are processed in memory and not stored.

## Known limitations

- This fixture does not implement a multi-user application login or production tenant authorization layer. Run it only on a trusted developer machine and disposable provider account.
- GitHub App setup callback data does not identify the installing user, so Identities are learned from subsequent signed webhook senders.
- Repository transfer across installations may require reauthorization and a fresh Source selection; stable IDs preserve the existing record when GitHub continues to expose the same repository ID.
- The local worker is intentionally single-process and does not provide production scheduling, dead-letter queues, or distributed locks.
- Diagnostic controls are protected by test mode plus loopback origin, not by production-grade authentication.
- OAuth client variables are reserved but OAuth user authorization is not needed for the installation-token workflow.

Test definitions, Playwright, Promptfoo, Chromatic, CI test workflows, test reports, and release acceptance decisions are intentionally left to the separate connector test plan.
