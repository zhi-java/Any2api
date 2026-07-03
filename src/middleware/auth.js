/**
 * API Key 认证中间件
 */

export function authMiddleware(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  // Admin 页面不需要认证
  if (req.method === 'GET' && req.path === '/admin') {
    return next();
  }

  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) {
    return next();
  }

  res.status(401).json({
    error: {
      message: 'Invalid API key'
    }
  });
}
