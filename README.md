# HNG Internship — Backend Stage 3

  **Live API:** https://hng-internship-ivory.vercel.app  
  **Stage-3 Source:** backend/stage-2/  

  ---

  ## Stage 3 — Authentication & Authorization API

  A production-grade REST API built with **Node.js / Express** featuring:

  - **GitHub OAuth 2.0 + PKCE** for both Web and CLI flows
  - **JWT Access Tokens** (1 hour) + **Refresh Tokens** (7 days, rotated on use)
  - **RBAC** — first user to sign in becomes `admin`, all subsequent users become `analyst`
  - **API Versioning** — all routes available under `/api/v2/` prefix
  - **DB-backed Rate Limiting** — 10 requests / 15 min per IP on `/auth/github` (works across serverless instances)
  - **Request Logging** — every request logged to PostgreSQL
  - **CSRF Protection** on state-mutating endpoints
  - **CSV Export** of profiles (admin only)

  ---

  ## Base URL

  ```
  https://hng-internship-ivory.vercel.app
  ```

  ---

  ## Authentication Endpoints

  | Method | Path | Description |
  |--------|------|-------------|
  | GET | `/auth/github` | Start GitHub OAuth (redirects to GitHub) |
  | GET | `/api/v2/auth/github` | Same — versioned alias |
  | GET | `/api/v2/auth/github/callback` | OAuth callback (handled by server) |
  | POST | `/auth/token` | CLI: exchange `auth_code` + `code_verifier` for tokens |
  | POST | `/auth/refresh` | Rotate refresh token, get new access token |
  | POST | `/auth/logout` | Revoke refresh token, clear cookies |

  ### Web OAuth Flow

  1. `GET /auth/github` → redirects to GitHub
  2. User authorises → GitHub redirects to `/api/v2/auth/github/callback`
  3. Server issues tokens:
     - **Cookies:** `access_token` (httpOnly), `refresh_token` (httpOnly)
     - **Response headers:** `X-Access-Token`, `X-Refresh-Token`
     - **Redirect URL query params:** `?access_token=...&refresh_token=...&token_type=Bearer&expires_in=3600`

  ### CLI / PKCE Flow

  ```
  GET /auth/github?client_type=cli&code_challenge=BASE64URL_SHA256&redirect_uri=http://localhost:PORT/cb
  ```
  After OAuth → server redirects to `redirect_uri?auth_code=XXX`  
  Then: `POST /auth/token` with `{ auth_code, code_verifier }` → JSON with `access_token` + `refresh_token`

  ---

  ## Protected Endpoints

  All require `Authorization: Bearer <access_token>` header (or `access_token` cookie).

  | Method | Path | Role | Description |
  |--------|------|------|-------------|
  | GET | `/api/users/me` | any | Current user profile |
  | GET | `/api/v2/auth/me` | any | Same — versioned alias |
  | GET | `/api/profiles` | any | List all 2026 profiles (paginated) |
  | GET | `/api/v2/profiles` | any | Same — versioned alias |
  | GET | `/api/profiles/export` | admin | Download profiles as CSV |
  | GET | `/api/v2/auth/users` | admin | List all users |
  | PATCH | `/api/v2/auth/users/:id/role` | admin | Change a user's role |

  ---

  ## RBAC

  - First user to complete GitHub OAuth → **admin**
  - All subsequent users → **analyst**
  - Admin can promote/demote any user via `PATCH /api/v2/auth/users/:id/role`

  ---

  ## Rate Limiting

  - **Endpoint:** `GET /auth/github` (and `/api/v2/auth/github`)
  - **Limit:** 10 requests per 15 minutes per IP
  - **Storage:** PostgreSQL (works across serverless instances)
  - **Response on exceed:** `429 Too Many Requests` + `Retry-After` header

  ---

  ## Token Lifecycle

  | Token | Expiry | Storage |
  |-------|--------|---------|
  | Access Token (JWT) | 1 hour | httpOnly cookie + response header |
  | Refresh Token | 7 days | httpOnly cookie; rotated on use |
  | CSRF Token | 1 hour | Non-httpOnly cookie |

  Refresh: `POST /auth/refresh` with `{ "refresh_token": "..." }` (or cookie)  
  Logout: `POST /auth/logout` — revokes the refresh token server-side

  ---

  ## Tech Stack

  - **Runtime:** Node.js 20 (pure JavaScript, no TypeScript)
  - **Framework:** Express 4
  - **Database:** PostgreSQL via Neon (serverless)
  - **Auth:** jsonwebtoken, GitHub OAuth 2.0 + PKCE
  - **Deploy:** Vercel (serverless functions)
  - **CI/CD:** GitHub Actions (`.github/workflows/ci.yml`) — lint + test on every push

  ---

  ## Project Structure

  ```
  backend/stage-2/
  ├── index.js              # Entry point — mounts all routes
  ├── db.js                 # Neon PostgreSQL pool
  ├── migrations.js         # Table creation (runs on cold start)
  ├── middleware/
  │   ├── authenticate.js   # JWT verification (Bearer + cookie)
  │   ├── authorize.js      # RBAC role check
  │   ├── rateLimiter.js    # express-rate-limit (general)
  │   ├── csrf.js           # CSRF token validation
  │   └── requestLogger.js  # Logs all requests to DB
  ├── routes/
  │   ├── auth.js           # GitHub OAuth, token exchange, refresh, logout
  │   ├── profiles.js       # Profiles CRUD + CSV export
  │   └── users.js          # /api/users/me
  └── .github/workflows/
      └── ci.yml            # GitHub Actions CI pipeline
  ```

  ---

  ## Environment Variables

  | Variable | Description |
  |----------|-------------|
  | `DATABASE_URL` | Neon PostgreSQL connection string |
  | `JWT_SECRET` | Secret for signing JWTs |
  | `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
  | `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
  | `BACKEND_URL` | Public API base URL |
  | `PORTAL_URL` | Frontend portal URL (post-login redirect) |
  | `SESSION_SECRET` | Express session secret |
  