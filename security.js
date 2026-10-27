'use strict';
const { createHash } = require('node:crypto');

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72;
}
function requireLogin(req, res, next) {
  if (req.session?.admin?.gymId) return next();
  if (req.path.startsWith('/api/') || req.path === '/create-subscription') {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
  res.redirect('/index.html');
}
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = new URL(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).origin;
  const origin = req.get('origin');
  if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expected)) {
    return res.status(403).json({ error: 'This request must come from your Gymvelto dashboard.' });
  }
  // Browser form posts carry Origin; non-browser API clients must authenticate with a session.
  if (!origin && req.is('application/x-www-form-urlencoded')) {
    return res.status(403).json({ error: 'Missing request origin. Reload the page and try again.' });
  }
  next();
}
function loginLimiter(pool) {
  return async (req, res, next) => {
    try {
      const key = createHash('sha256').update(req.ip || 'unknown').digest('hex');
      const { rows } = await pool.query(`INSERT INTO login_attempts (key, attempts, expires_at)
        VALUES ($1, 1, now() + interval '15 minutes') ON CONFLICT (key) DO UPDATE
        SET attempts = CASE WHEN login_attempts.expires_at < now() THEN 1 ELSE login_attempts.attempts + 1 END,
            expires_at = CASE WHEN login_attempts.expires_at < now() THEN now() + interval '15 minutes' ELSE login_attempts.expires_at END
        RETURNING attempts`, [key]);
      if (rows[0].attempts > 20) {
        res.set('Retry-After', '900');
        return res.status(429).send('Too many sign-in attempts. Please wait 15 minutes.');
      }
      next();
    } catch (err) { next(err); }
  };
}
function headers(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/') || req.path.endsWith('.html') || !req.path.includes('.')) res.set('Cache-Control', 'no-store');
  next();
}
module.exports = { validPassword, requireLogin, sameOrigin, loginLimiter, headers };
