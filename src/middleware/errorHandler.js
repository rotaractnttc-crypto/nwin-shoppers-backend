// Catches anything thrown/rejected in route handlers that wasn't already
// handled locally. In production it never leaks stack traces or raw DB
// error messages to the client (which can expose schema details).
function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found.` });
}

function errorHandler(err, req, res, _next) {
  console.error("Unhandled error:", err);
  const status = err.status || 500;
  const message =
    process.env.NODE_ENV === "production" && status === 500
      ? "Something went wrong on our end. Please try again."
      : err.message;
  res.status(status).json({ error: message });
}

module.exports = { notFound, errorHandler };
