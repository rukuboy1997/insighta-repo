module.exports = function csrf(req, res, next) {
  if (req.headers.authorization) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const csrfHeader = req.headers["x-csrf-token"];
  const csrfUser = req.user?.csrf;

  if (!csrfHeader || !csrfUser || csrfHeader !== csrfUser) {
    return res.status(403).json({ status: "error", message: "Invalid CSRF token" });
  }

  next();
};
