// Wraps an async Express route handler so any rejected promise (a failed
// DB query, a thrown error, anything) is passed to next() instead of
// becoming an unhandled rejection. Express 4 does NOT do this automatically
// for async handlers — without this wrapper, one bad request (e.g. a query
// against a column that doesn't exist yet) crashes the entire Node process,
// taking down every other in-flight request with it. This is what was
// causing the production crash loop and the wishlist/cart failures.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
