# MCDR Settlement API

NestJS backend for the **MCDR Settlement** workflow: company owners submit capital-meeting
settlement requests, backoffice staff review them, set per-meeting fees, owners pay, and
backoffice uploads settlement documents — with notifications at every step.

Built with **NestJS 11 + MongoDB (Mongoose) + Keycloak (OIDC)**. All 16 spec endpoints are
implemented and verified end-to-end.

---

## Table of contents
1. [Architecture](#architecture)
2. [Tech stack](#tech-stack)
3. [Prerequisites](#prerequisites)
4. [Quick start (Docker Compose)](#quick-start-docker-compose)
5. [Local development (without Docker)](#local-development-without-docker)
6. [Environment variables](#environment-variables)
7. [Authentication & roles](#authentication--roles)
8. [API reference (16 endpoints)](#api-reference-16-endpoints)
9. [Status state machine](#status-state-machine)
10. [Data model](#data-model)
11. [File storage](#file-storage)
12. [Testing](#testing)
13. [Scripts](#scripts)
14. [Postman collection](#postman-collection)
15. [Security](#security)
16. [Out of scope (spec §17)](#out-of-scope-spec-17)
17. [Troubleshooting](#troubleshooting)

---

## Architecture

```
src/
├── auth/                  Keycloak JWT strategy, global guard, @Public, roles
├── crn/                   CRN eligibility check (injectable, stub impl)
├── settlement-requests/   Core workflow: create/review/fee/approve/reject/pay/settle + file downloads
├── notifications/         Notification emission + list/mark-read
├── files/                 Injectable file-storage service (LocalDisk impl, stream-based)
├── health/                Public health check
├── app.module.ts          Root module, global pipes & guards
└── main.ts                Bootstrap: CORS, /api prefix, body-parser limits
```

- **Global prefix**: every route is served under `/api`.
- **Auth**: a global `JwtAuthGuard` (Keycloak) + `RolesGuard` protect all routes by default;
  `@Public()` opts out (health, register).
- **DI abstractions**: `FileStorageService` and `CrnEligibilityService` are interfaces bound to
  symbol DI tokens, so the LocalDisk/stub implementations can be swapped (e.g. for S3 / a real
  CRN service) in one place.

## Tech stack
- NestJS 11 (TypeScript), Mongoose 9
- Keycloak 26 (OIDC, RS256, JWKS)
- MongoDB 7, Multer (multipart), Passport-JWT
- Docker Compose (api + mongo + keycloak), Jest (unit + e2e)

## Prerequisites
- Docker + Docker Compose (recommended), **or** Node 22.12+ and a local MongoDB
- Ports: `3000` (API), `8081` (Keycloak), `27017` (Mongo)

## Quick start (Docker Compose)

```bash
docker compose up -d --build
```

This starts:
- `mcdr-api`      → http://localhost:3000
- `mcdr-keycloak` → http://localhost:8081  (realm `mcdr` auto-imported on first start)
- `mcdr-mongo`    → localhost:27017

Verify:
```bash
curl http://localhost:3000/api/health     # {"status":"ok"}
```

The Keycloak realm (`keycloak/mcdr-realm.json`) auto-imports the test users, roles, and clients.

> **Why port 8081 for Keycloak?** On this machine port `8080` is taken by a local Apache, so the
> compose file maps Keycloak to host **8081** (container-internal is still 8080). If `8080` is free
> in your environment, change `docker-compose.yml` (`ports` + `KC_HOSTNAME_URL`) and
> `KEYCLOAK_ISSUER`/`KEYCLOAK_URL` to `8080`.

> **MongoDB split-brain warning:** if you also run a **local** `mongod` on `127.0.0.1:27017`, your
> GUI client (Compass) may connect to the **empty local** instance while the API writes to the
> **Docker** mongo. Either stop the local `mongod`, or point your client at the Docker container.
> (See [Troubleshooting](#troubleshooting).)

## Local development (without Docker)

```bash
npm install
cp .env.example .env        # then edit values
npm run start:dev           # http://localhost:3000
```

You still need MongoDB and Keycloak reachable at the URLs in `.env`. Easiest: run only mongo and
keycloak via Docker, and the API locally:
```bash
docker compose up -d mongo keycloak
npm run start:dev
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `MONGODB_URI` | `mongodb://localhost:27017/mcdr` | MongoDB connection string |
| `KEYCLOAK_URL` | — | Keycloak **base** URL (used for JWKS + Admin API). In Docker: `http://keycloak:8080` |
| `KEYCLOAK_REALM` | `mcdr` | Keycloak realm |
| `KEYCLOAK_CLIENT_ID` | `mcdr-api` | Confidential client for the Admin API (register flow) |
| `KEYCLOAK_CLIENT_SECRET` | — | Secret for `mcdr-api` |
| `KEYCLOAK_ISSUER` | `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}` | Expected token `iss`. Set to the **external** hostname Keycloak advertises (e.g. `http://localhost:8081/realms/mcdr`) when it differs from the internal URL |
| `FILE_STORAGE_PATH` | `./uploads` | Root directory for local file storage |
| `MAX_UPLOAD_SIZE_MB` | `10` | Per-file upload limit (Multer + body-parser) |
| `PAGINATION_DEFAULT_LIMIT` | `20` | Default page size for backoffice queue |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174` | Comma-separated allowed origins (defaults to the two portals if unset) |
| `SETTLED_CRNS` | _(empty)_ | Comma-separated CRNs considered already settled (CRN eligibility stub) |

## Authentication & roles

- **OIDC via Keycloak.** Two public portal clients (Authorization Code + PKCE, and password grant
  for dev): `mcdr-owner-portal` (frontend on `:5173`) and `mcdr-backoffice-portal` (`:5174`).
- **Roles**: `owner` and `backoffice_employee` (realm roles). Access tokens carry an `account`
  audience (via a realm protocol mapper) which the API validates.
- **Test users** (password `test123`): `owner1`, `owner2` (owner) · `backoffice1`, `backoffice2`
  (backoffice).

Get a token (password grant, for testing):
```bash
curl -X POST http://localhost:8081/realms/mcdr/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=mcdr-owner-portal&grant_type=password&username=owner1&password=test123"
```
Use the returned `access_token` as `Authorization: Bearer <token>`. Tokens expire after
**1 day** (set via `accessTokenLifespan` in `keycloak/mcdr-realm.json` — a dev convenience;
use the refresh token or re-authenticate).

## API reference (16 endpoints)

All under `/api`. Auth = Bearer token. **401** = token missing/invalid/expired · **403** = wrong role.

| # | Method | Path | Role | Success | Returns |
|---|---|---|---|---|---|
| 1 | GET | `/health` | public | 200 | `{ status: "ok" }` |
| 2 | GET | `/crn/:crn/eligibility` | owner | 200 | `{ crn, needsSettlement }` |
| 3 | POST | `/settlement-requests` | owner | 201 | request object (`multipart/form-data`: `payload` JSON + `attachments[]` files) |
| 4 | GET | `/settlement-requests/mine` | owner | 200 | `{ request: {...} \| null }` |
| 5 | GET | `/settlement-requests` | backoffice | 200 | `{ items[], total, page, limit }` (query: `status`, `page`, `limit`) |
| 6 | GET | `/settlement-requests/:id` | owner\* / backoffice | 200 | request object |
| 7 | PATCH | `/settlement-requests/:id/meetings/:meetingId/fee` | backoffice | 200 | `{ meetingId, fee }` |
| 8 | POST | `/settlement-requests/:id/approve` | backoffice | 200 | `{ status: "AWAITING_PAYMENT" }` |
| 9 | POST | `/settlement-requests/:id/reject` | backoffice | 201 | `{ status: "REJECTED" }` (body: `{ rejectionReason? }`) |
| 10 | GET | `/settlement-requests/:id/payment-summary` | owner | 200 | `{ meetingFees[], total }` |
| 11 | POST | `/settlement-requests/:id/pay` | owner | 200 | `{ status: "AWAITING_SETTLEMENT" }` |
| 12 | POST | `/settlement-requests/:id/meetings/:meetingId/settlement-document` | backoffice | 201 | `{ status, meetingId }` (`multipart`: `file`) — auto-settles when all meetings have docs |
| 13 | GET | `/settlement-requests/:id/meetings/:meetingId/attachment` | owner\* / backoffice | 200 | binary (stored MIME) |
| 14 | GET | `/settlement-requests/:id/meetings/:meetingId/settlement-document` | owner\* / backoffice | 200 | binary |
| 15 | GET | `/notifications` | owner / backoffice | 200 | `{ notifications[], unreadCount }` |
| 16 | PATCH | `/notifications/:id/read` | owner / backoffice | 200 | `{ id, isRead: true }` |

\* owners can only access their own requests.

Plus `POST /api/auth/register` (public) — creates a Keycloak user with the `owner` role (spec §17,
out of scope).

**Request creation body** (endpoint 3, multipart):
- `payload` (text) = `{ "crn": "CRN001", "meetings": [{ "meetingDate": "2024-01-15", "capitalAtMeeting": 100000 }] }`
- `attachments` (file) × N — one PDF/JPEG/PNG per meeting, **same order**, ≤ `MAX_UPLOAD_SIZE_MB` each.

## Status state machine

```
PENDING_REVIEW ──reject──▶ REJECTED
       │
     approve (all meetings have a fee)
       ▼
AWAITING_PAYMENT ──pay──▶ AWAITING_SETTLEMENT ──(all settlement docs uploaded)──▶ SETTLED
```

Only one **active** (non-terminal) request is allowed per owner (enforced by a partial unique index).

## Data model

**SettlementRequest** (top-level objects use `id` — no `_id`/`__v` leak):
`id, crn, ownerId, status, meetings[], reviewedBy, reviewedAt, rejectionReason, paidAt, settledAt, createdAt, updatedAt`

**Meeting** (subdocument — note it exposes **`_id`**, which is the value used as `:meetingId` in
paths):
`_id, meetingDate, capitalAtMeeting, attachmentUrl, attachmentOriginalName, attachmentMimeType, fee, settlementDocumentUrl, settlementDocumentUploadedAt`

**Notification**:
`id, recipientId, recipientRole, type, message, relatedRequestId, isRead, createdAt`

Notification `type`s: `REQUEST_SUBMITTED` (→backoffice), `REQUEST_APPROVED`, `REQUEST_REJECTED`,
`PAYMENT_RECEIVED` (→backoffice), `REQUEST_SETTLED`.

## File storage
- Abstracted behind the `FileStorageService` interface, bound to the `FILE_STORAGE_SERVICE` DI token.
  Default impl: `LocalDiskFileStorageService` (root = `FILE_STORAGE_PATH`).
- `store()` writes the file plus a `.meta.json` sidecar (original name, MIME, size); keys use
  **forward slashes** and a **path-traversal guard** (resolved path must stay under the base).
- `read()` returns a **`stream.Readable`** + original name + MIME + size; downloads pipe it to the
  response with the correct `Content-Type` and `Content-Length`.
- Swap for S3 by implementing the interface and rebinding the token in `FilesModule`.

## Testing
```bash
npm test            # unit tests (Jest, in-memory Mongo)
npm run test:e2e    # e2e (bootstraps AppModule with in-memory Mongo)
npm run test:cov    # coverage
```
- Unit tests cover services (notifications, settlement lifecycle, CRN, roles) including a
  concurrent-insert test for the partial unique index.
- HTTP/controller tests assert 403 on wrong roles and the notification auth/leak behavior.
- The e2e suite targets `GET /api/health`. (`test/jest-e2e.json` lets Jest transform the ESM-only
  `jose` package pulled in by `jwks-rsa`.)

## Scripts
```bash
npm run build       # nest build (tsc)
npm run start:dev   # watch mode
npm run start:prod  # node dist/main
npm test            # unit
npm run test:e2e    # e2e
npm run lint        # eslint
npm run format      # prettier
```

## Postman collection
A verified Postman collection **"MCDR Settlement API (verified)"** is available (id
`0f84a7f9-18e0-43e8-92bb-0cb0c61259be`). It includes:
- **Auth - get tokens**: one click fetches owner/backoffice tokens and auto-saves them to
  collection variables (`ownerToken` / `backofficeToken`).
- All 16 endpoints with auth wired (`{{ownerToken}}` for owner routes, `{{backofficeToken}}` for
  backoffice routes) and test scripts that auto-fill `requestId`, `meetingId`, `notificationId`.

## Security
- **Global auth**: every route requires a valid Keycloak JWT unless marked `@Public()`.
- **JWT validation**: RS256 via JWKS, plus `issuer` and `audience` (`account`) checks.
- **Role enforcement**: `@Roles('owner' | 'backoffice_employee')` → 403 on mismatch.
- **No privilege escalation**: Keycloak realm no longer auto-assigns `owner` to every new user.
- **Upload safety**: Multer `fileSize` limit enforced **before** buffering; MIME allow-list
  (PDF/JPEG/PNG); path-traversal guard on file reads.
- **Notification isolation**: owners can only mark their own notifications read; backoffice can mark
  broadcasts; everything else → 403.

## Out of scope (spec §17)
Not implemented by design: frontends, a real payment gateway (`pay` is a status flip), WebSocket
push (notifications are poll-based), S3 storage, and Keycloak Admin API beyond the register flow.

## Troubleshooting

**`401 Unauthorized`** — token missing, empty, malformed, or expired (5-min lifetime). Re-fetch a
token; ensure the header is exactly `Authorization: Bearer <jwt>`.

**`403 Forbidden`** — valid token but wrong role (e.g. owner token on a backoffice route).

**Token error `Missing form parameter: grant_type`** — body wasn't sent as
`application/x-www-form-urlencoded`. Use `x-www-form-urlencoded` (or the collection's token requests).

**Data "not in MongoDB"** — you likely have a **second local `mongod`** on `127.0.0.1:27017`. The API
writes to the Docker mongo; your client may be reading the empty local one. Stop the local `mongod`
or repoint your client. Check who owns 27017 and inspect the Docker DB:
```bash
docker exec mcdr-mongo mongosh mcdr --eval "db.settlement_requests.countDocuments()"
```

**Port 8080 in use** — Keycloak is mapped to host `8081` here. Change the compose `ports` and
`KC_HOSTNAME_URL` (and `KEYCLOAK_ISSUER`) if you want `8080`.

**Docker build fails at `npm ci` ("Missing … from lock file")** — regenerate the lock with the
image's npm: `docker run --rm -v "$PWD:/app" -w /app node:22-alpine npm install --package-lock-only`.
