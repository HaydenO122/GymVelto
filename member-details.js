const express = require('express');
const limits = { addressLine1:200, addressLine2:200, city:100, region:100, postalCode:30, country:100, emergencyName:150, emergencyPhone:50, emergencyRelationship:100 };
function contactDetails(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid member contact details.');
  const result = {};
  for (const [key, max] of Object.entries(limits)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].trim().length > max) throw new Error(`Please shorten the ${key} field.`);
    result[key] = value[key].trim();
  }
  return result;
}
function readPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 1024 * 1024) throw new Error('Member photo must be a PNG or JPG, up to 1 MB.');
  const png = buffer.length >= 24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (!png && !jpeg) throw new Error('Member photo must be a PNG or JPG, up to 1 MB.');
  return { content:buffer, type:png ? 'image/png' : 'image/jpeg' };
}
function signupPhoto(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid member photo. Choose a PNG or JPG, up to 1 MB.');
  return readPhoto(Buffer.from(value, 'base64'));
}
async function initMemberDetails(pool) {
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS "contactDetails" JSONB NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS member_photos (
      "memberId" INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      "gymId" TEXT NOT NULL, content BYTEA NOT NULL, "contentType" TEXT NOT NULL
    );`);
}
function memberPhotoRoutes(pool) {
  const router = express.Router();
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!req.session?.admin?.gymId) return res.status(401).json({error:'Please log in again.'});
    next();
  });
  const run = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
  router.get('/:barcode/photo',run(async(req,res) => {
    const {rows} = await pool.query(`SELECT p.content, p."contentType" FROM member_photos p
      JOIN members m ON m.id = p."memberId" AND m."gymId" = p."gymId"
      WHERE m.barcode = $1 AND m."gymId" = $2`,[req.params.barcode,req.session.admin.gymId]);
    if (!rows[0]) return res.sendStatus(404);
    res.set('X-Content-Type-Options','nosniff');res.type(rows[0].contentType).send(rows[0].content);
  }));
  router.post('/:barcode/photo',express.raw({type:['image/png','image/jpeg'],limit:'1mb'}),run(async(req,res) => {
    let photo;
    try { photo = readPhoto(req.body); } catch(error) { return res.status(400).json({error:error.message}); }
    const result = await pool.query(`INSERT INTO member_photos ("memberId", "gymId", content, "contentType")
      SELECT id, "gymId", $3, $4 FROM members WHERE barcode = $1 AND "gymId" = $2
      ON CONFLICT ("memberId") DO UPDATE SET content = EXCLUDED.content, "contentType" = EXCLUDED."contentType"
      RETURNING "memberId"`,[req.params.barcode,req.session.admin.gymId,photo.content,photo.type]);
    if (!result.rowCount) return res.sendStatus(404);
    res.json({success:true});
  }));
  router.delete('/:barcode/photo',run(async(req,res) => {
    await pool.query(`DELETE FROM member_photos p USING members m
      WHERE p."memberId" = m.id AND p."gymId" = $2 AND m."gymId" = $2 AND m.barcode = $1`,
    [req.params.barcode,req.session.admin.gymId]);
    res.json({success:true});
  }));
  router.use((err,req,res,next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({error:'Member photo must be 1 MB or smaller.'});
    console.error('Member photo error:',err);res.status(500).json({error:'Could not save or load the member photo.'});
  });
  return router;
}
module.exports = {contactDetails,readPhoto,signupPhoto,initMemberDetails,memberPhotoRoutes};
