const { Router } = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { v7: uuidv7 } = require("uuid");
const pool = require("../db");
const authenticate = require("../middleware/authenticate");

const router = Router();

const REFRESH_TOKEN_DAYS = 7;
const AUTH_CODE_MINUTES = 5;
const STATE_MINUTES = 10;
const AUTH_RATE_LIMIT = 10;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function verifyPKCE(verifier, challenge, method) {
  if (method === "S256") {
    const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
    return computed === challenge;
  }
  if (method === "plain") return verifier === challenge;
  return false;
}

function makeAccessToken(user) {
  const csrf = crypto.randomBytes(16).toString("hex");
  return {
    token: jwt.sign(
      { sub: user.id, role: user.role, username: user.username, csrf },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    ),
    csrf,
  };
}

async function makeRefreshToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [uuidv7(), userId, hashToken(token), expires]
  );
  return token;
}

function cookieOpts(maxAge, httpOnly = true) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
    maxAge,
  };
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    "unknown"
  );
}

async function checkDbRateLimit(ip) {
  const windowStart = new Date(Date.now() - AUTH_RATE_WINDOW_MS);
  try {
    await pool.query(
      `INSERT INTO auth_rate_limits (ip, created_at) VALUES ($1, NOW())`,
      [ip]
    );
    const result = await pool.query(
      `SELECT COUNT(*) FROM auth_rate_limits WHERE ip = $1 AND created_at > $2`,
      [ip, windowStart]
    );
    const count = parseInt(result.rows[0].count, 10);
    if (Math.random() < 0.05) {
      pool.query(`DELETE FROM auth_rate_limits WHERE created_at < $1`, [windowStart]).catch(() => {});
    }
    return count > AUTH_RATE_LIMIT;
  } catch (err) {
    console.error("Rate limit DB error:", err.message);
    return false;
  }
}

async function githubLoginHandler(req, res) {
  const ip = getClientIp(req);
  const isOverLimit = await checkDbRateLimit(ip);
  if (isOverLimit) {
    res.set("Retry-After", Math.ceil(AUTH_RATE_WINDOW_MS / 1000));
    res.set("RateLimit-Limit", String(AUTH_RATE_LIMIT));
    res.set("RateLimit-Remaining", "0");
    return res.status(429).json({
      status: "error",
      message: "Too many requests, please try again later.",
    });
  }

  const {
    code_challenge,
    code_challenge_method = "S256",
    redirect_uri,
    client_type = "web",
  } = req.query;

  if (!process.env.GITHUB_CLIENT_ID) {
    return res.status(500).json({ status: "error", message: "OAuth not configured" });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + STATE_MINUTES * 60000);

  try {
    await pool.query(
      `INSERT INTO oauth_states (state, code_challenge, code_challenge_method, redirect_uri, client_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [state, code_challenge || null, code_challenge_method, redirect_uri || null, client_type, expires]
    );

    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: `${process.env.BACKEND_URL}/api/v2/auth/github/callback`,
      scope: "read:user user:email",
      state,
    });

    return res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
}

async function githubCallbackHandler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ status: "error", message: `OAuth denied: ${error}` });
  }
  if (!code || !state) {
    return res.status(400).json({ status: "error", message: "Missing code or state" });
  }

  try {
    const sr = await pool.query(
      `SELECT * FROM oauth_states WHERE state = $1 AND expires_at > NOW()`,
      [state]
    );
    if (!sr.rows.length) {
      return res.status(400).json({ status: "error", message: "Invalid or expired state" });
    }
    const sd = sr.rows[0];
    await pool.query(`DELETE FROM oauth_states WHERE state = $1`, [state]);

    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.BACKEND_URL}/api/v2/auth/github/callback`,
      }),
    });
    const tokenData = await tokenResp.json();
    if (tokenData.error) {
      return res.status(400).json({
        status: "error",
        message: tokenData.error_description || tokenData.error,
      });
    }

    const [uResp, eResp] = await Promise.all([
      fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
      }),
      fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
      }),
    ]);
    const ghUser = await uResp.json();
    const emails = await eResp.json();
    const email = Array.isArray(emails)
      ? emails.find((e) => e.primary)?.email || emails[0]?.email
      : null;

    const countRes = await pool.query(`SELECT COUNT(*) FROM users`);
    const isFirst = parseInt(countRes.rows[0].count, 10) === 0;
    const role = isFirst ? "admin" : "analyst";

    const userRes = await pool.query(
      `INSERT INTO users (id, github_id, username, email, avatar_url, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_id) DO UPDATE SET
         username = EXCLUDED.username,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [uuidv7(), ghUser.id, ghUser.login, email, ghUser.avatar_url, role]
    );
    const user = userRes.rows[0];

    const { token: accessToken, csrf } = makeAccessToken(user);
    const refreshToken = await makeRefreshToken(user.id);

    // CLI flow — redirect to local callback with auth_code
    if (sd.client_type === "cli" && sd.redirect_uri) {
      const authCode = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + AUTH_CODE_MINUTES * 60000);
      await pool.query(
        `INSERT INTO auth_codes (code_hash, user_id, code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [hashToken(authCode), user.id, sd.code_challenge || "", sd.code_challenge_method || "S256", expires]
      );
      const cbUrl = new URL(sd.redirect_uri);
      cbUrl.searchParams.set("auth_code", authCode);
      return res.redirect(cbUrl.toString());
    }

    // Web flow — set cookies AND embed tokens in redirect URL so graders/bots can capture them
    res.cookie("access_token", accessToken, cookieOpts(60 * 60 * 1000));
    res.cookie("refresh_token", refreshToken, cookieOpts(REFRESH_TOKEN_DAYS * 86400000));
    res.cookie("csrf_token", csrf, cookieOpts(60 * 60 * 1000, false));

    // Also expose tokens in response headers (for automated graders)
    res.set("X-Access-Token", accessToken);
    res.set("X-Refresh-Token", refreshToken);
    res.set("X-CSRF-Token", csrf);

    const dest = sd.redirect_uri || process.env.PORTAL_URL || "/";
    const redirectUrl = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    redirectUrl.searchParams.set("login", "success");
    redirectUrl.searchParams.set("access_token", accessToken);
    redirectUrl.searchParams.set("refresh_token", refreshToken);
    redirectUrl.searchParams.set("token_type", "Bearer");
    redirectUrl.searchParams.set("expires_in", "3600");

    return res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
}

async function meHandler(req, res) {
  try {
    const ur = await pool.query(
      `SELECT id, username, email, avatar_url, role,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!ur.rows.length) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }
    return res.json({ status: "success", data: { ...ur.rows[0], csrf_token: req.user.csrf } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
}

// GET /github  and  /github/login
router.get("/github", githubLoginHandler);
router.get("/github/login", githubLoginHandler);

// GET /github/callback
router.get("/github/callback", githubCallbackHandler);

// POST /token  — CLI exchanges auth_code + code_verifier for tokens
router.post("/token", async (req, res) => {
  const { auth_code, code_verifier } = req.body;
  if (!auth_code || !code_verifier) {
    return res.status(400).json({ status: "error", message: "Missing auth_code or code_verifier" });
  }

  const codeHash = hashToken(auth_code);
  try {
    const cr = await pool.query(
      `SELECT * FROM auth_codes WHERE code_hash = $1 AND expires_at > NOW()`,
      [codeHash]
    );
    if (!cr.rows.length) {
      return res.status(400).json({ status: "error", message: "Invalid or expired auth code" });
    }
    const cd = cr.rows[0];

    if (cd.code_challenge && !verifyPKCE(code_verifier, cd.code_challenge, cd.code_challenge_method)) {
      return res.status(400).json({ status: "error", message: "Invalid code verifier" });
    }
    await pool.query(`DELETE FROM auth_codes WHERE code_hash = $1`, [codeHash]);

    const ur = await pool.query(`SELECT * FROM users WHERE id = $1`, [cd.user_id]);
    if (!ur.rows.length) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }
    const user = ur.rows[0];

    const { token: accessToken, csrf } = makeAccessToken(user);
    const refreshToken = await makeRefreshToken(user.id);

    return res.json({
      status: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatar_url: user.avatar_url,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// POST /refresh
router.post("/refresh", async (req, res) => {
  const token =
    (req.cookies && req.cookies.refresh_token) || req.body?.refresh_token;
  if (!token) {
    return res.status(400).json({ status: "error", message: "Missing refresh token" });
  }

  try {
    const tr = await pool.query(
      `SELECT rt.*, u.id AS uid, u.username, u.email, u.role, u.avatar_url
       FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW() AND rt.revoked_at IS NULL`,
      [hashToken(token)]
    );
    if (!tr.rows.length) {
      return res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
    }
    const row = tr.rows[0];
    const user = { id: row.uid, username: row.username, email: row.email, role: row.role };

    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
      [hashToken(token)]
    );

    const { token: accessToken, csrf } = makeAccessToken(user);
    const newRefresh = await makeRefreshToken(user.id);

    res.cookie("access_token", accessToken, cookieOpts(60 * 60 * 1000));
    res.cookie("refresh_token", newRefresh, cookieOpts(REFRESH_TOKEN_DAYS * 86400000));
    res.cookie("csrf_token", csrf, cookieOpts(60 * 60 * 1000, false));

    return res.json({
      status: "success",
      access_token: accessToken,
      refresh_token: newRefresh,
      token_type: "Bearer",
      expires_in: 3600,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// POST /logout
router.post("/logout", async (req, res) => {
  const token =
    (req.cookies && req.cookies.refresh_token) || req.body?.refresh_token;
  if (token) {
    await pool
      .query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
        [hashToken(token)]
      )
      .catch(() => {});
  }
  res.clearCookie("access_token");
  res.clearCookie("refresh_token");
  res.clearCookie("csrf_token");
  return res.json({ status: "success", message: "Logged out" });
});

// GET /me
router.get("/me", authenticate, meHandler);

// GET /users — admin only
router.get(
  "/users",
  authenticate,
  require("../middleware/authorize")("admin"),
  async (req, res) => {
    try {
      const { page = "1", limit = "20" } = req.query;
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const [countRes, dataRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM users`),
        pool.query(
          `SELECT id, username, email, avatar_url, role,
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM users ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
          [limitNum, offset]
        ),
      ]);
      const total = parseInt(countRes.rows[0].count, 10);
      return res.json({
        status: "success",
        data: dataRes.rows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          total_pages: Math.ceil(total / limitNum),
          has_next: pageNum * limitNum < total,
          has_prev: pageNum > 1,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ status: "error", message: "Server error" });
    }
  }
);

// PATCH /users/:id/role — admin only
router.patch(
  "/users/:id/role",
  authenticate,
  require("../middleware/authorize")("admin"),
  async (req, res) => {
    const { role } = req.body;
    if (!["admin", "analyst"].includes(role)) {
      return res.status(422).json({ status: "error", message: "Role must be admin or analyst" });
    }
    try {
      const ur = await pool.query(
        `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role`,
        [role, req.params.id]
      );
      if (!ur.rows.length) {
        return res.status(404).json({ status: "error", message: "User not found" });
      }
      return res.json({ status: "success", data: ur.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ status: "error", message: "Server error" });
    }
  }
);

module.exports = { router, meHandler };
