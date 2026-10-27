'use strict';
require('dotenv').config();
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
const {randomUUID}=require('node:crypto');
const {validPassword}=require('./security');
// Only operators with database credentials can provision a new, isolated gym.
async function provision() {
  const {GYM_NAME, GYM_ADMIN_USERNAME, GYM_ADMIN_PASSWORD, DATABASE_URL}=process.env;
  if(!DATABASE_URL || !GYM_NAME?.trim() || GYM_NAME.length>200 || !GYM_ADMIN_USERNAME?.trim() || GYM_ADMIN_USERNAME.length>100 || !validPassword(GYM_ADMIN_PASSWORD)) throw new Error('Set DATABASE_URL, GYM_NAME, GYM_ADMIN_USERNAME, and a strong GYM_ADMIN_PASSWORD (12+ characters, max 72 UTF-8 bytes).');
  const pool=new Pool({connectionString:DATABASE_URL});const client=await pool.connect();
  try {
    await client.query('BEGIN');const gymId='gym_'+randomUUID();
    await client.query('INSERT INTO gyms (id,name) VALUES ($1,$2)',[gymId,GYM_NAME.trim()]);
    await client.query('INSERT INTO admins (username,"passwordHash","gymId","requiresPasswordChange") VALUES ($1,$2,$3,true)',[GYM_ADMIN_USERNAME.trim(),await bcrypt.hash(GYM_ADMIN_PASSWORD,12),gymId]);
    await client.query('COMMIT');console.log('Gym created. The administrator must change their temporary password at first sign-in.');
  } catch(err) { await client.query('ROLLBACK');throw err; }
  finally { client.release();await pool.end(); }
}
provision().catch(err=>{console.error('Gym provisioning failed:',err.code || err.message);process.exitCode=1;});
