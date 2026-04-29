const express = require("express");
const cookieParser = require("cookie-parser");
const profilesRouter = require("./routes/profiles");
const { router: authRouter, meHandler } = require("./routes/auth");
const v2ProfilesRouter = require("./routes/v2/profiles");
const authenticate = require("./middleware/authenticate");
const csrf = require("./middleware/csrf");
const requestLogger = require("./middleware/requestLogger");
const { publicLimiter, authenticatedLimiter, authLimiter } = require("./middleware/rateLimiter");
const { ensureMigrated } = require("./migrations");

const app = express();

ensureMigrated().catch((err) => console.error("Migration error:", err.message));

const PORTAL_ORIGINS = [
  process.env.PORTAL_URL,
  "http://localhost:3001",
  "http://localhost:5173",
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && PORTAL_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// ── Rate limiting ────────────────────────────────────────────────────────────
// Apply strict auth rate limiter to both /auth/github paths
app.use("/auth/github", authLimiter);
app.use("/api/v2/auth/github", authLimiter);
// General public limiter on all v2 routes
app.use("/api/v2", publicLimiter);

// ── Auth routes (mounted at short path AND versioned path) ──────────────────
app.use("/auth", authRouter);
app.use("/api/v2/auth", authRouter);

// ── /api/users/me  (short alias for current user) ──────────────────────────
app.get("/api/users/me", authenticate, meHandler);
app.get("/api/v2/users/me", authenticate, meHandler);

// ── Profiles — require authentication on all methods ───────────────────────
app.use("/api/profiles", authenticate);
app.use("/api/profiles", profilesRouter);

// ── V2 profiles — require auth + CSRF ──────────────────────────────────────
app.use(
  "/api/v2/profiles",
  authenticate,
  authenticatedLimiter,
  csrf,
  v2ProfilesRouter
);

// ── Health check ────────────────────────────────────────────────────────────
app.get("/api/healthz", (req, res) => res.json({ status: "ok", version: "2.0.0" }));
app.get("/api/v2/healthz", (req, res) => res.json({ status: "ok", version: "2.0.0" }));

// ── 404 / error handlers ────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ status: "error", message: "Not found" }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ status: "error", message: "Server error" });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
