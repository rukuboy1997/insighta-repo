const pool = require("../db");

module.exports = function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const responseTime = Date.now() - start;
    const userId = req.user?.sub || null;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;

    pool
      .query(
        `INSERT INTO request_logs (user_id, method, path, status_code, ip, response_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, req.method, req.path, res.statusCode, ip, responseTime]
      )
      .catch(() => {});
  });

  next();
};
