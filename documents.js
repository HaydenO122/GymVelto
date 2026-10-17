const express = require('express');
const { randomUUID, createHash } = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
async function initDocuments(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS gym_documents (
    id UUID PRIMARY KEY, "gymId" TEXT NOT NULL, title TEXT NOT NULL,
    filename TEXT NOT NULL, content BYTEA NOT NULL, sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('document', 'waiver')),
    active BOOLEAN NOT NULL DEFAULT true, "uploadedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS gym_documents_gym ON gym_documents ("gymId");
  CREATE UNIQUE INDEX IF NOT EXISTS gym_one_active_waiver ON gym_documents ("gymId")
    WHERE kind = 'waiver' AND active;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS "waiverDocumentId" UUID REFERENCES gym_documents(id);
  ALTER TABLE members ADD COLUMN IF NOT EXISTS "waiverAcceptedAt" TIMESTAMPTZ;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS "waiverSignedName" TEXT;`);
}

async function checkWaiver(pool, gymId, body) {
  const { rows } = await pool.query(
    `SELECT id FROM gym_documents WHERE "gymId" = $1 AND kind = 'waiver' AND active`, [gymId]);
  const current = rows[0];
  if (!current) {
    if (body.waiverDocumentId) throw new Error('The gym waiver changed. Refresh the signup page before continuing.');
    return null;
  }
  if (body.waiverDocumentId !== current.id) throw new Error('The gym waiver changed. Refresh and review the current waiver.');
  const signedName = typeof body.waiverSignedName === 'string' ? body.waiverSignedName.trim() : '';
  if (body.waiverAccepted !== true || signedName.length < 2 || signedName.length > 200) {
    throw new Error('The member must review the waiver, enter their name, and accept it before payment.');
  }
  return { documentId: current.id, signedName, acceptedAt: new Date() };
}

function documentRoutes(pool) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session?.admin?.gymId) return res.status(401).json({ error: 'Please log in again.' });
    next();
  });
  const run = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/', run(async (req, res) => {
    const { rows } = await pool.query(`SELECT d.id, d.title, d.filename, d.kind, d.active,
      d."uploadedAt", octet_length(d.content) AS bytes,
      (SELECT count(*)::int FROM members m WHERE m."gymId" = d."gymId"
        AND m."waiverDocumentId" = d.id) AS acceptances
      FROM gym_documents d WHERE d."gymId" = $1 ORDER BY d."uploadedAt" DESC, d.id`, [req.session.admin.gymId]);
    res.json(rows);
  }));
  router.post('/', express.raw({ type: 'application/pdf', limit: MAX_BYTES }), run(async (req, res) => {
    const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    const kind = req.query.kind;
    if (!title || title.length > 150 || !['waiver', 'document'].includes(kind)) {
      return res.status(400).json({ error: 'Enter a title (up to 150 characters) and a document type.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 8 || req.body.length > MAX_BYTES ||
        req.body.subarray(0, 5).toString() !== '%PDF-' || !filename.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Choose a PDF file, up to 5 MB.' });
    }
    const gymId = req.session.admin.gymId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize uploads for one gym so quota checks and waiver replacement are atomic.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [gymId]);
      const usage = await client.query(`SELECT count(*)::int AS count,
        COALESCE(sum(octet_length(content)), 0)::int AS bytes FROM gym_documents WHERE "gymId" = $1`, [gymId]);
      if (usage.rows[0].count >= 100 || usage.rows[0].bytes + req.body.length > 50 * 1024 * 1024) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This gym has reached its document storage limit (100 files / 50 MB).' });
      }
      if (kind === 'waiver') await client.query(`UPDATE gym_documents SET active = false
        WHERE "gymId" = $1 AND kind = 'waiver' AND active`, [gymId]);
      const id = randomUUID();
      const safeFilename = filename.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(-150);
      await client.query(`INSERT INTO gym_documents (id, "gymId", title, filename, content, sha256, kind)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, gymId, title, safeFilename, req.body, createHash('sha256').update(req.body).digest('hex'), kind]);
      await client.query('COMMIT');
      res.status(201).json({ id });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
  router.get('/:id/file', run(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
    const { rows } = await pool.query('SELECT filename, content FROM gym_documents WHERE id = $1 AND "gymId" = $2',
      [req.params.id, req.session.admin.gymId]);
    if (!rows[0]) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.attachment(rows[0].filename).type('application/pdf').send(rows[0].content);
  }));
  router.get('/:id/acceptances', run(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
    const doc = await pool.query('SELECT id FROM gym_documents WHERE id = $1 AND "gymId" = $2',
      [req.params.id, req.session.admin.gymId]);
    if (!doc.rows[0]) return res.sendStatus(404);
    const { rows } = await pool.query(`SELECT "fullName", "waiverSignedName", "waiverAcceptedAt"
      FROM members WHERE "gymId" = $1 AND "waiverDocumentId" = $2 ORDER BY "waiverAcceptedAt" DESC`,
    [req.session.admin.gymId, req.params.id]);
    res.json(rows);
  }));
  router.post('/:id/archive', run(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.sendStatus(404);
    const result = await pool.query('UPDATE gym_documents SET active = false WHERE id = $1 AND "gymId" = $2 RETURNING id',
      [req.params.id, req.session.admin.gymId]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json({ success: true });
  }));
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PDF files must be 5 MB or smaller.' });
    console.error('Document request failed:', err);
    res.status(500).json({ error: 'Could not save or load the document. Please try again.' });
  });
  return router;
}
module.exports = { initDocuments, checkWaiver, documentRoutes };
