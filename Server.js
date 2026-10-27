require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const path = require('path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const security = require('./security');
const billing = require('./billing');
const { initDocuments, checkWaiver, documentRoutes } = require('./documents');
const { initProfile, profileRoutes } = require('./gym-profile');
const { initMemberDetails, contactDetails, signupPhoto, memberPhotoRoutes } = require('./member-details');

// Return NUMERIC columns as JS numbers (pg returns strings by default)
types.setTypeParser(1700, (v) => parseFloat(v));

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('A SESSION_SECRET of at least 32 characters is required.');

// Platform fee percentage collected on transactions (Default: 5%)
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || 5);

// Stripe (secret key from env)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Neon Postgres connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
pool.on('error', err => console.error('Database pool error', {code: err.code}));

// Wrap async routes so errors don't crash the server
const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((err) => {
    console.error('Request failed', {type:err.type || err.name,code:err.code});
    res.status(500).json({ error: 'Server error' });
  });

// -----------------------------------------------------------------------------
// DATABASE SETUP (tables are created automatically on startup)
// -----------------------------------------------------------------------------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gyms (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      "stripeAccountId" TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "gymId" TEXT NOT NULL,
      "requiresPasswordChange" BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      "gymId" TEXT NOT NULL,
      "planName" TEXT NOT NULL,
      "monthlyPrice" NUMERIC(10,2) NOT NULL,
      "signupFee" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "yearlyFee" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "stripePriceId" TEXT,
      "stripeSignupPriceId" TEXT,
      "stripeYearlyPriceId" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      "fullName" TEXT NOT NULL,
      email TEXT,
      phone TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      "planId" TEXT,
      "stripeCustomerId" TEXT,
      "stripeSubscriptionId" TEXT,
      "gymId" TEXT NOT NULL,
      UNIQUE ("gymId", barcode)
    );
  `);

  await pool.query(fs.readFileSync(path.join(__dirname,'migrations','001-launch.sql'),'utf8'));
  await pool.query('DELETE FROM login_attempts WHERE expires_at < now()');
  await initDocuments(pool);
  await initProfile(pool);
  await initMemberDetails(pool);

  // First-time admin account: set ADMIN_USERNAME and ADMIN_PASSWORD in env
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM admins');
  if (rows[0].n === 0) {
    if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await pool.query(
        'INSERT INTO gyms (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        ['gym_001', 'Default Gym']
      );
      await pool.query(
        'INSERT INTO admins (username, "passwordHash", "gymId", "requiresPasswordChange") VALUES ($1, $2, $3, false)',
        [process.env.ADMIN_USERNAME, hash, 'gym_001']
      );
      console.log(`Created first admin "${process.env.ADMIN_USERNAME}"`);
    } else {
      console.warn('No admins exist. Set ADMIN_USERNAME and ADMIN_PASSWORD env vars, or run migrate.js.');
    }
  }
}

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.set('trust proxy', 1); // needed behind Render's proxy for secure cookies
app.disable('x-powered-by');
app.use(security.headers);
app.post('/stripe/webhook', express.raw({type:'application/json',limit:'1mb'}), billing.webhook(pool,stripe));
app.use(security.sameOrigin);
app.use('/create-subscription', express.json({ limit: '2mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Set it in your env before going live.');
}

app.use(
  session({
    store: new pgSession({ pool, createTableIfMissing: true }), // sessions survive restarts
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
    },
  })
);

const requireLogin = security.requireLogin;
const privatePages = new Set(['dashboard','scan','signup','members','edit-member','plans','documents','gym-profile','admins','payments','getting-started','billing','check-ins']);
app.use((req,res,next) => {
  const page = req.path.replace(/^\//,'').replace(/\.html$/,'');
  if (privatePages.has(page)) return requireLogin(req,res,next);
  next();
});
app.use(express.static(path.join(__dirname,'public'), {index:false}));

app.use('/api/documents', documentRoutes(pool));
app.use('/api/gym-profile', profileRoutes(pool));
app.use('/api/member', memberPhotoRoutes(pool));

// -----------------------------------------------------------------------------
// PAGE NAVIGATION ROUTES
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => res.send('ok')); // for UptimeRobot

app.get('/', (req, res) => {
  if (req.session.admin) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const pages = ['dashboard', 'scan', 'signup', 'members', 'edit-member', 'plans', 'documents', 'gym-profile', 'admins'];
pages.forEach((page) => {
  app.get(`/${page}`, requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

// -----------------------------------------------------------------------------
// API & ACTION ENDPOINTS
// -----------------------------------------------------------------------------

['getting-started','billing','check-ins'].forEach(page=>app.get('/'+page,requireLogin,(req,res)=>res.sendFile(path.join(__dirname,'public','workspace.html'))));
app.get('/api/check-ins',requireLogin,wrap(async(req,res)=>{
  const {rows}=await pool.query('SELECT c.id,c.access,c."createdAt",m."fullName" FROM check_ins c LEFT JOIN members m ON m.id=c."memberId" AND m."gymId"=c."gymId" WHERE c."gymId"=$1 ORDER BY c."createdAt" DESC LIMIT 100',[req.session.admin.gymId]);
  res.json(rows);
}));

// Gym provisioning is restricted to the authenticated operator CLI, never a public URL.
app.all('/provision-gym', (req,res) => res.status(410).json({error:'Public provisioning is disabled. Contact gymvelto@gmail.com for beta access.'}));

// Admin login
app.post(
  '/login',
  security.loginLimiter(pool),
  wrap(async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || Buffer.byteLength(password,'utf8') > 72) return res.status(400).send('Enter a valid username and password.');
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    const admin = rows[0];

    if (admin && (await bcrypt.compare(password || '', admin.passwordHash))) {
      await new Promise((resolve,reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      
      if (admin.requiresPasswordChange) {
        req.session.pendingAdmin = { id: admin.id, username: admin.username, gymId: admin.gymId };
        return res.send(`
          <div style="font-family: sans-serif; max-width: 400px; margin: 50px auto; text-align: center;">
            <h3>Welcome! Please set your permanent secure password.</h3>
            <form action="/api/setup-password" method="POST" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="password" name="newPassword" placeholder="New Password (12+ characters)" minlength="12" maxlength="72" required style="padding: 10px; font-size: 16px;">
              <button type="submit" style="padding: 10px; font-size: 16px; background-color: #007bff; color: white; border: none; cursor: pointer;">Save & Login</button>
            </form>
          </div>
        `);
      }

      req.session.admin = { id: admin.id, username: admin.username, gymId: admin.gymId };
      await new Promise((resolve,reject) => req.session.save(err => err ? reject(err) : resolve()));
      return res.redirect('/dashboard');
    }
    res.status(401).send('<h3>Invalid Username or Password. <a href="/">Try Again</a></h3>');
  })
);

// Setup new password on first login
app.post(
  '/api/setup-password',
  wrap(async (req, res) => {
    if (!req.session.pendingAdmin) {
      return res.redirect('/');
    }

    const { newPassword } = req.body;
    const admin = req.session.pendingAdmin;

    if (!security.validPassword(newPassword)) return res.status(400).send('Use at least 12 characters and at most 72 UTF-8 bytes.');
    const newHash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      `UPDATE admins 
       SET "passwordHash" = $1, "requiresPasswordChange" = false 
       WHERE id = $2 AND "gymId" = $3`,
      [newHash, admin.id, admin.gymId]
    );

    await new Promise((resolve,reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.admin = { id:admin.id, username: admin.username, gymId: admin.gymId };
    await new Promise((resolve,reject) => req.session.save(err => err ? reject(err) : resolve()));

    res.redirect('/dashboard');
  })
);

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Add new admin account
app.post(
  '/add-admin',
  requireLogin,
  wrap(async (req, res) => {
    const { newUsername, newPassword } = req.body;
    const currentGymId = req.session.admin.gymId;

    if (typeof newUsername !== 'string' || !newUsername.trim() || newUsername.length > 100 ||
        !security.validPassword(newPassword)) {
      return res.status(400).send('<h3>Enter a username and a password of 8â€“200 characters. <a href="/admins">Back to Admins</a></h3>');
    }

    const existing = await pool.query('SELECT 1 FROM admins WHERE username = $1', [newUsername]);
    if (existing.rowCount > 0) {
      return res.send('<h3>Username already exists! <a href="/admins">Back to Admins</a></h3>');
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'INSERT INTO admins (username, "passwordHash", "gymId", "requiresPasswordChange") VALUES ($1, $2, $3, false)',
      [newUsername, hash, currentGymId]
    );
    res.send('<h3>Admin Created Successfully! <a href="/admins">Back to Admins</a></h3>');
  })
);

// Publishable Stripe key
app.get('/stripe-key', (req, res) => {
  res.json({ publicKey: billing.mode().publicKey, mode:billing.mode().mode });
});

app.get('/api/billing-status',requireLogin,wrap(async(req,res) => {
  const {mode,ready,reason}=await billing.readiness(pool,req.session.admin.gymId);
  res.json({mode,ready,reason,webhooksConfigured:Boolean(process.env.STRIPE_WEBHOOK_SECRET)});
}));

// -----------------------------------------------------------------------------
// PLAN MANAGEMENT ENDPOINTS
// -----------------------------------------------------------------------------

app.get(
  '/api/plans',
  requireLogin,
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM plans WHERE "gymId" = $1 ORDER BY "createdAt"',
      [req.session.admin.gymId]
    );
    res.json(rows);
  })
);

app.post('/api/plans', requireLogin, async (req, res) => {
  const gymId = req.session.admin.gymId;
  const { planName, monthlyPrice, signupFee, yearlyFee } = req.body;

  if (typeof planName !== 'string' || !planName.trim() || planName.length > 120 || billing.money(monthlyPrice,true) === null || billing.money(signupFee) === null || billing.money(yearlyFee) === null) {
    return res.status(400).json({ error: 'Enter a plan name and valid prices with at most two decimal places. Monthly price must be positive.' });
  }

  try {
    // 1. Recurring monthly price in Stripe
    const stripePrice = await stripe.prices.create({
      unit_amount: Math.round(parseFloat(monthlyPrice) * 100),
      currency: 'usd',
      recurring: { interval: 'month' },
      product_data: { name: `${planName} (Monthly)` },
    });

    // 2. Optional one-time sign up fee
    let signupFeePriceId = null;
    if (signupFee && parseFloat(signupFee) > 0) {
      const p = await stripe.prices.create({
        unit_amount: Math.round(parseFloat(signupFee) * 100),
        currency: 'usd',
        product_data: { name: `${planName} - Sign Up Fee` },
      });
      signupFeePriceId = p.id;
    }

    // 3. Optional annual fee
    let yearlyFeePriceId = null;
    if (yearlyFee && parseFloat(yearlyFee) > 0) {
      const p = await stripe.prices.create({
        unit_amount: Math.round(parseFloat(yearlyFee) * 100),
        currency: 'usd',
        recurring: { interval: 'year' },
        product_data: { name: `${planName} - Annual Maintenance Fee` },
      });
      yearlyFeePriceId = p.id;
    }

    const { rows } = await pool.query(
      `INSERT INTO plans
        (id, "gymId", "planName", "monthlyPrice", "signupFee", "yearlyFee",
         "stripePriceId", "stripeSignupPriceId", "stripeYearlyPriceId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        `plan_${crypto.randomUUID()}`,
        gymId,
        planName,
        parseFloat(monthlyPrice),
        signupFee ? parseFloat(signupFee) : 0,
        yearlyFee ? parseFloat(yearlyFee) : 0,
        stripePrice.id,
        signupFeePriceId,
        yearlyFeePriceId,
      ]
    );

    res.json({ success: true, plan: rows[0] });
  } catch (err) {
    console.error('Error creating plan:', err);
    res.status(500).json({ error: 'Could not create this plan. Please contact Gymvelto support.' });
  }
});

// -----------------------------------------------------------------------------
// MEMBER ENROLLMENT & MANAGEMENT ENDPOINTS
// -----------------------------------------------------------------------------

// Persist pending enrollment before contacting Stripe; retries use stable idempotency keys.
app.post('/create-subscription',requireLogin,billing.enrollment(pool,stripe));
app.post('/api/enrollment/confirm',requireLogin,billing.confirmEnrollment(pool,stripe));
app.post('/api/member/:barcode/cancel-subscription',requireLogin,wrap(async(req,res)=>{
  const gymId=req.session.admin.gymId;
  if(req.body.confirm !== true) return res.status(400).json({error:'Confirm cancellation before continuing.'});
  const member=(await pool.query('SELECT * FROM members WHERE "gymId"=$1 AND barcode=$2',[gymId,req.params.barcode])).rows[0];
  if(!member?.stripeSubscriptionId) return res.status(404).json({error:'No linked subscription found for this member.'});
  let sub=await stripe.subscriptions.retrieve(member.stripeSubscriptionId);
  if((typeof sub.customer === 'string' ? sub.customer : sub.customer?.id) !== member.stripeCustomerId || sub.metadata?.gymId !== gymId) return res.status(409).json({error:'Subscription ownership needs a support review before cancellation.'});
  if(!['canceled','incomplete_expired'].includes(sub.status)) sub=await stripe.subscriptions.cancel(sub.id,{invoice_now:false,prorate:false});
  await billing.syncMember(pool,gymId,member,sub);
  res.json({success:true});
}));

// All members for current gym
app.get(
  '/api/members',
  requireLogin,
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT m.*, EXISTS (SELECT 1 FROM member_photos p WHERE p."memberId" = m.id AND p."gymId" = m."gymId") AS "hasPhoto" FROM members m WHERE m."gymId" = $1 ORDER BY m.id', [
      req.session.admin.gymId,
    ]);
    res.json(rows);
  })
);

// Single member by barcode
app.get(
  '/api/member/:barcode',
  requireLogin,
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT m.*, EXISTS (SELECT 1 FROM member_photos p WHERE p."memberId" = m.id AND p."gymId" = m."gymId") AS "hasPhoto" FROM members m WHERE m."gymId" = $1 AND m.barcode = $2', [
      req.session.admin.gymId,
      req.params.barcode,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found.' });
    res.json(rows[0]);
  })
);

// Update member profile & status
app.post(
  '/api/update-member',
  requireLogin,
  wrap(async (req, res) => {
    const gymId = req.session.admin.gymId;
    const { originalBarcode, fullName, email, phone, barcode, status } = req.body;

    if (typeof fullName !== 'string' || !fullName.trim() || fullName.length > 200 || typeof email !== 'string' || email.length > 254 || typeof phone !== 'string' || phone.length > 50 || typeof barcode !== 'string' || !barcode.trim() || barcode.length > 100 || !['active','unpaid'].includes(status)) return res.status(400).json({error:'Enter valid member details and status.'});
    const current=(await pool.query('SELECT status, "stripeSubscriptionId" FROM members WHERE "gymId"=$1 AND barcode=$2',[gymId,originalBarcode])).rows[0];
    if (!current) return res.status(404).json({error:'Member record not found.'});
    if (current.stripeSubscriptionId && status !== current.status) return res.status(409).json({error:'Billing status is managed by Stripe. Use Stripe to change or cancel the subscription.'});
    try {
      const details = req.body.contactDetails === undefined ? null : contactDetails(req.body.contactDetails);
      const result = await pool.query(
        `UPDATE members
         SET "fullName" = $1, email = $2, phone = $3, barcode = $4, status = $5,
             "contactDetails" = COALESCE($8::jsonb, "contactDetails")
         WHERE "gymId" = $6 AND barcode = $7`,
        [fullName, email, phone || '', barcode, status, gymId, originalBarcode, details === null ? null : JSON.stringify(details)]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Member record not found.' });
      }
      res.json({ success: true });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ error: 'That barcode is already assigned to another member.' });
      }
      if (err.message.startsWith('Invalid member contact') || err.message.startsWith('Please shorten the')) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  })
);

// Barcode scan (check-in verification)
app.post(
  '/api/verify-scan',
  requireLogin,
  wrap(async (req, res) => {
    const { barcode } = req.body;
    const { rows } = await pool.query('SELECT * FROM members WHERE "gymId" = $1 AND barcode = $2', [
      req.session.admin.gymId,
      barcode,
    ]);
    const member = rows[0];
    await pool.query('INSERT INTO check_ins ("gymId","memberId",access) VALUES ($1,$2,$3)',[req.session.admin.gymId,member?.id || null,member?.status === 'active']);

    if (!member) {
      return res.json({ access: false, message: 'Card / Barcode Not Recognized' });
    }
    if (member.status === 'active') {
      return res.json({ access: true, memberName: member.fullName, message: 'Access Granted' });
    }
    return res.json({
      access: false,
      memberName: member.fullName,
      message: 'Access Denied: Unpaid or Inactive Account',
    });
  })
);

// Delete member
app.delete(
  '/api/member/:barcode',
  requireLogin,
  wrap(async (req, res) => {
    const member = (await pool.query('SELECT "stripeCustomerId", "stripeSubscriptionId" FROM members WHERE "gymId"=$1 AND barcode=$2',[req.session.admin.gymId,req.params.barcode])).rows[0];
    if (!member) return res.status(404).json({error:'Member not found.'});
    if (member.stripeSubscriptionId) {
      const sub=await stripe.subscriptions.retrieve(member.stripeSubscriptionId);
      if (!['canceled','incomplete_expired'].includes(sub.status)) return res.status(409).json({error:'Cancel this member’s subscription in Stripe before deleting the record. Deleting a record does not stop billing.'});
    } else if (member.stripeCustomerId) {
      const subscriptions=await stripe.subscriptions.list({customer:member.stripeCustomerId,status:'all',limit:100});
      if (subscriptions.has_more || subscriptions.data.some(sub=>!['canceled','incomplete_expired'].includes(sub.status))) return res.status(409).json({error:'This customer may still have an active subscription. Cancel billing in Stripe before deleting.'});
    }
    const result = await pool.query('DELETE FROM members WHERE "gymId" = $1 AND barcode = $2', [
      req.session.admin.gymId,
      req.params.barcode,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found.' });
    res.json({ success: true });
  })
);

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------

app.use((err,req,res,next) => {
  console.error('Unhandled request error',{type:err.type || err.name,code:err.code});
  if (res.headersSent) return next(err);
  res.status(err.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500).json({error:'Unable to complete this request. Please try again or contact support.'});
});

if (require.main === module) initDb()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Gymvelto Server running on port ${PORT}`);
    });
    process.on('SIGTERM', () => {
      server.close(() => pool.end().then(() => process.exit(0)));
      setTimeout(() => process.exit(1),25000).unref();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

module.exports = { app, pool, initDb };
