const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { documentRoutes, checkWaiver, initDocuments } = require('../documents');
const { profileRoutes, initProfile } = require('../gym-profile');
const { memberPhotoRoutes, contactDetails, signupPhoto } = require('../member-details');
const id = '11111111-1111-4111-8111-111111111111';
const pdf = Buffer.from('%PDF-1.7\nTest document\n%%EOF');

async function serve(pool, fn) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers['x-gym']) req.session = { admin: { gymId: req.headers['x-gym'] } }; next(); });
  app.use('/docs', documentRoutes(pool)); app.use('/profile', profileRoutes(pool));
  app.use('/member', memberPhotoRoutes(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (path, options = {}, gym = 'gym-a') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { ...(gym ? { 'x-gym': gym } : {}), ...options.headers }
  });
  try { await fn(request); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('documents, profile and logo require authentication before touching storage', async () => {
  await serve({ query() { throw new Error('Unauthenticated database access'); } }, async request => {
    for (const [path, method] of [['/docs','GET'], ['/docs','POST'], [`/docs/${id}/file`,'GET'], [`/docs/${id}/acceptances`,'GET'], [`/docs/${id}/archive`,'POST'], ['/profile','GET'], ['/profile','POST'], ['/profile/logo','POST'], ['/profile/logo','DELETE'], ['/profile/logo','GET']]) {
      assert.equal((await request(path, { method }, null)).status, 401);
    }
  });
});
test('another gym cannot download, archive or inspect waiver acknowledgements', async () => {
  const calls = [];
  await serve({ async query(sql, args) {
    calls.push([sql, args]);
    assert.match(sql, /"gymId" = \$2/); assert.equal(args[1], 'gym-b');
    return { rows: [], rowCount: 0 };
  } }, async request => {
    for (const [path, method] of [[`/docs/${id}/file`,'GET'], [`/docs/${id}/acceptances`,'GET'], [`/docs/${id}/archive`,'POST']]) {
      assert.equal((await request(path, { method }, 'gym-b')).status, 404);
    }
    assert.equal(calls.length, 3);
  });
});
test('document list is scoped to session gym, ignoring a supplied gymId', async () => {
  await serve({ async query(sql, args) { assert.match(sql, /WHERE d\."gymId" = \$1/); assert.deepEqual(args, ['gym-a']); return { rows: [] }; } }, async request => {
    assert.equal((await request('/docs?gymId=gym-b')).status, 200);
  });
});
test('invalid and oversized PDFs are rejected before database writes', async () => {
  await serve({ connect() { throw new Error('Invalid upload reached database'); } }, async request => {
    const options = body => ({ method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body });
    const url = '/docs?title=Waiver&kind=waiver&filename=waiver.pdf';
    assert.equal((await request(url, options(Buffer.from('<html>bad</html>')))).status, 400);
    assert.equal((await request(url, options(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 413);
  });
});
test('waiver upload archives previous version and commits immutable PDF in one transaction', async () => {
  const calls = []; let released = false;
  const client = { async query(sql, args) {
    calls.push([sql, args]);
    if (sql.includes('AS count')) return { rows: [{ count: 1, bytes: 20 }] };
    return { rows: [] };
  }, release() { released = true; } };
  await serve({ async connect() { return client; } }, async request => {
    const response = await request('/docs?title=New%20waiver&kind=waiver&filename=waiver.pdf&gymId=other', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    assert.equal(response.status, 201);
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO gym_documents'));
    assert.equal(insert[1][1], 'gym-a'); assert.deepEqual(insert[1][4], pdf);
    assert.equal(insert[1][5].length, 64);
    assert.match(calls.at(-1)[0], /COMMIT/); assert.ok(released);
    assert.ok(calls.find(([sql]) => sql.includes('UPDATE gym_documents SET active = false')));
  });
});
test('quota failure rolls back without replacing the current waiver', async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rows: [{ count: 100, bytes: 0 }] }; }, release() {} };
  await serve({ async connect() { return client; } }, async request => {
    assert.equal((await request('/docs?title=Test&kind=waiver&filename=a.pdf', { method:'POST', headers:{'Content-Type':'application/pdf'}, body:pdf })).status, 400);
    assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(sql => sql.includes('UPDATE')));
  });
});
test('waiver validation requires current version and explicit member acknowledgement', async () => {
  const pool = { async query(sql, args) { assert.deepEqual(args, ['gym-a']); return { rows: [{ id }] }; } };
  await assert.rejects(checkWaiver(pool, 'gym-a', {}), /waiver changed/);
  await assert.rejects(checkWaiver(pool, 'gym-a', { waiverDocumentId: id }), /member must review/);
  await assert.rejects(checkWaiver(pool, 'gym-a', { waiverDocumentId: id, waiverAccepted: 'true', waiverSignedName: 'Jane Doe' }), /member must review/);
  await assert.rejects(checkWaiver(pool, 'gym-a', { waiverDocumentId: 'foreign-document', waiverAccepted: true, waiverSignedName: 'Jane Doe' }), /waiver changed/);
  const result = await checkWaiver(pool, 'gym-a', { waiverDocumentId: id, waiverAccepted: true, waiverSignedName: ' Jane Doe ' });
  assert.equal(result.documentId, id); assert.equal(result.signedName, 'Jane Doe'); assert.ok(result.acceptedAt instanceof Date);
});
test('gyms without a waiver can register; a removed waiver requires refresh', async () => {
  const pool = { async query() { return { rows: [] }; } };
  assert.equal(await checkWaiver(pool, 'gym-a', {}), null);
  await assert.rejects(checkWaiver(pool, 'gym-a', { waiverDocumentId:id }), /changed/);
});
test('profile edits cannot target another gym and retain default title on blank input', async () => {
  await serve({ async query(sql, args) { assert.match(sql, /WHERE id = \$3/); assert.deepEqual(args, ['My Gym', null, 'gym-a']); return { rowCount: 1 }; } }, async request => {
    assert.equal((await request('/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:' My Gym ', dashboardTitle:' ', gymId:'other' }) })).status, 200);
  });
});
test('logo upload rejects SVG and oversized images', async () => {
  await serve({ async query() { throw new Error('Invalid logo reached storage'); } }, async request => {
    assert.equal((await request('/profile/logo', { method:'POST', headers:{'Content-Type':'image/svg+xml'}, body:'<svg/>' })).status, 400);
    assert.equal((await request('/profile/logo', { method:'POST', headers:{'Content-Type':'image/png'}, body:Buffer.alloc(1024*1024+1) })).status, 413);
  });
});
test('logo storage and retrieval are scoped to logged-in gym', async () => {
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(16)]);
  await serve({ async query(sql, args) {
    if (sql.startsWith('UPDATE')) { assert.equal(args[2], 'gym-a'); assert.equal(args[1], 'image/png'); return { rowCount: 1 }; }
    assert.deepEqual(args, ['gym-a']); return { rows:[{logoContent:png,logoType:'image/png'}] };
  } }, async request => {
    assert.equal((await request('/profile/logo', { method:'POST', headers:{'Content-Type':'image/png'}, body:png })).status, 200);
    const res = await request('/profile/logo'); assert.equal(res.headers.get('content-type'), 'image/png'); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  });
});
test('schema initialization adds new tables and fields without removing existing data', async () => {
  const queries = []; const pool = { async query(sql) { queries.push(sql); } };
  await initDocuments(pool); await initProfile(pool);
  assert.match(queries[0], /CREATE TABLE IF NOT EXISTS gym_documents/);
  assert.match(queries[0], /"waiverDocumentId" UUID REFERENCES gym_documents/);
  assert.match(queries[1], /ADD COLUMN IF NOT EXISTS "dashboardTitle"/);
  assert.ok(queries.every(sql => !/DROP |TRUNCATE |DELETE /i.test(sql)));
});
test('member contacts are bounded and unrecognized fields are not stored', () => {
  assert.deepEqual(contactDetails({city:' Columbia ',gymId:'other'}),{city:'Columbia'});
  assert.deepEqual(contactDetails(undefined),{});
  assert.throws(()=>contactDetails({addressLine1:'x'.repeat(201)}));
  assert.throws(()=>contactDetails([]));
});
test('optional signup photo accepts PNG, rejects oversized or non-image data', () => {
  assert.equal(signupPhoto(null),null);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16)]);
  assert.equal(signupPhoto(png.toString('base64')).type,'image/png');
  assert.throws(()=>signupPhoto(Buffer.from('<svg/>').toString('base64')));
  assert.throws(()=>signupPhoto('A'.repeat(1400001)));
});
test('member photos require login and another gym cannot read or replace one', async () => {
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16)]);
  await serve({async query(sql,args){assert.equal(args[1],'gym-b');assert.match(sql,/"gymId" = \$2/);return {rows:[],rowCount:0};}},async request=>{
    assert.equal((await request('/member/BC-1/photo',{},null)).status,401);
    assert.equal((await request('/member/BC-1/photo',{},'gym-b')).status,404);
    assert.equal((await request('/member/BC-1/photo',{method:'POST',headers:{'Content-Type':'image/png'},body:png},'gym-b')).status,404);
    assert.equal((await request('/member/BC-1/photo',{method:'DELETE'},'gym-b')).status,200);
  });
});
