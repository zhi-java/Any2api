/**
 * 统一错误处理中间件
 */

export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  const type = err.type || 'api_error';

  res.status(status).json({
    error: {
      message,
      type,
      ...(err.code && { code: err.code }),
      ...(err.param && { param: err.param }),
    }
  });
}
