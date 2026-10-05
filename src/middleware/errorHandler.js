/**
 * Boundary Error Handling Middleware
 * Ensures bad requests, syntax errors, and missing parameters return clean 4xx responses,
 * never unexpected 500 errors.
 */

export function errorHandler(err, req, res, next) {
  // If headers already sent, delegate to default express handler
  if (res.headersSent) {
    return next(err);
  }

  // Handle JSON parse errors from invalid body payloads
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'InvalidJSON',
      code: 400,
      message: 'The request body contains malformed JSON syntax.'
    });
  }

  // Handle custom validation or boundary errors
  const statusCode = err.statusCode || err.status || 500;
  
  if (statusCode >= 400 && statusCode < 500) {
    return res.status(statusCode).json({
      error: err.name || 'BadRequest',
      code: statusCode,
      message: err.message || 'Invalid request boundary payload.'
    });
  }

  // Log unexpected errors securely without leaking sensitive info
  console.error('[Internal Error Catch]', err.message);

  return res.status(500).json({
    error: 'InternalServerError',
    code: 500,
    message: 'An unexpected internal error occurred. Please contact support.'
  });
}
