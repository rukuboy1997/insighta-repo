const rateLimit = require("express-rate-limit");

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { status: "error", message: "Too many requests, please try again later." },
  skip: (req) => !!req.user,
});

const authenticatedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip || "unknown",
  message: { status: "error", message: "Too many requests, please try again later." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { status: "error", message: "Too many requests, please try again later." },
});

module.exports = { publicLimiter, authenticatedLimiter, authLimiter };
