module.exports = function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ status: "error", message: "Authentication required" });
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return res.status(403).json({ status: "error", message: "Insufficient permissions" });
    }
    next();
  };
};
