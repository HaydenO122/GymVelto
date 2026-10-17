const express = require('express');
async function initProfile(pool) {
  await pool.query(`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS "dashboardTitle" TEXT;
    ALTER TABLE gyms ADD COLUMN IF NOT EXISTS "logoContent" BYTEA;
    ALTER TABLE gyms ADD COLUMN IF NOT EXISTS "logoType" TEXT;`);
}
function profileRoutes(pool) {
  const router = express.Router();
  const run = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session?.admin?.gymId) return res.status(401).json({ error: 'Please log in again.' });
    next();
  });
  router.get('/', run(async (req, res) => {
    const { rows } = await pool.query(`SELECT name, "dashboardTitle", ("logoContent" IS NOT NULL) AS "hasLogo"
      FROM gyms WHERE id = $1`, [req.session.admin.gymId]);
    if (!rows[0]) return res.status(404).json({ error: 'Gym profile not found.' });
    res.json({ ...rows[0], dashboardTitle: rows[0].dashboardTitle || 'Facility Command Center' });
  }));
  router.post('/', run(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const title = typeof req.body.dashboardTitle === 'string' ? req.body.dashboardTitle.trim() : '';
    if (!name || name.length > 100 || title.length > 100) {
      return res.status(400).json({ error: 'Enter a gym name and keep each field under 101 characters.' });
    }
    const result = await pool.query(`UPDATE gyms SET name = $1, "dashboardTitle" = $2 WHERE id = $3 RETURNING id`,
      [name, title || null, req.session.admin.gymId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Gym profile not found.' });
    res.json({ success: true });
  }));
  router.post('/logo', express.raw({ type: ['image/png', 'image/jpeg'], limit: '1mb' }), run(async (req, res) => {
    const data = req.body;
    const png = Buffer.isBuffer(data) && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = Buffer.isBuffer(data) && data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255;
    if (!png && !jpeg) return res.status(400).json({ error: 'Choose a PNG or JPG logo, up to 1 MB.' });
    const result = await pool.query(`UPDATE gyms SET "logoContent" = $1, "logoType" = $2 WHERE id = $3 RETURNING id`,
      [data, png ? 'image/png' : 'image/jpeg', req.session.admin.gymId]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json({ success: true });
  }));
  router.get('/logo', run(async (req, res) => {
    const { rows } = await pool.query(`SELECT "logoContent", "logoType" FROM gyms WHERE id = $1`, [req.session.admin.gymId]);
    if (!rows[0]?.logoContent) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(rows[0].logoType).send(rows[0].logoContent);
  }));
  router.delete('/logo', run(async (req, res) => {
    await pool.query(`UPDATE gyms SET "logoContent" = NULL, "logoType" = NULL WHERE id = $1`, [req.session.admin.gymId]);
    res.json({ success: true });
  }));
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Logo must be 1 MB or smaller.' });
    console.error('Gym profile request failed:', err);
    res.status(500).json({ error: 'Could not save or load your gym profile.' });
  });
  return router;
}
module.exports = { initProfile, profileRoutes };
