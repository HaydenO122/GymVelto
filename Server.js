require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const path = require('path');
const { initDocuments, checkWaiver, documentRoutes } = require('./documents');
const { initProfile, profileRoutes } = require('./gym-profile');
const { initMemberDetails, contactDetails, signupPhoto, memberPhotoRoutes } = require('./member-details');

// Return NUMERIC columns as JS numbers (pg returns strings by default)
types.setTypeParser(1700, (v) => parseFloat(v));

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Platform fee percentage collected on transactions (Default: 5%)
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || 5);

// Stripe (secret key from env)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Neon Postgres connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Wrap async routes so errors don't crash the server
const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((err) => {
    console.error(err);
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
app.use('/create-subscription', express.json({ limit: '2mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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

function requireLogin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/index.html');
}

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

// Provision new gym accounts
app.get(
  '/provision-gym',
  wrap(async (req, res) => {
    const { gymId, gymName, username } = req.query;

    if (!gymId || !gymName || !username) {
      return res.send('Missing parameters. Format: ?gymId=...&gymName=...&username=...');
    }

    await pool.query(
      'INSERT INTO gyms (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [gymId, gymName]
    );

    const hash = await bcrypt.hash('1234', 10);
    await pool.query(
      `INSERT INTO admins (username, "passwordHash", "gymId", "requiresPasswordChange") 
       VALUES ($1, $2, $3, true)`,
      [username, hash, gymId]
    );

    res.send(`Successfully provisioned ${gymName}! Tell them to log in with username: ${username} and password: 1234`);
  })
);

// Admin login
app.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    const admin = rows[0];

    if (admin && (await bcrypt.compare(password || '', admin.passwordHash))) {
      
      if (admin.requiresPasswordChange) {
        req.session.pendingAdmin = { id: admin.id, username: admin.username, gymId: admin.gymId };
        return res.send(`
          <div style="font-family: sans-serif; max-width: 400px; margin: 50px auto; text-align: center;">
            <h3>Welcome! Please set your permanent secure password.</h3>
            <form action="/api/setup-password" method="POST" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="password" name="newPassword" placeholder="New Password" required style="padding: 10px; font-size: 16px;">
              <button type="submit" style="padding: 10px; font-size: 16px; background-color: #007bff; color: white; border: none; cursor: pointer;">Save & Login</button>
            </form>
          </div>
        `);
      }

      req.session.admin = { username: admin.username, gymId: admin.gymId };
      return res.redirect('/dashboard');
    }
    res.send('<h3>Invalid Username or Password. <a href="/">Try Again</a></h3>');
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

    const newHash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `UPDATE admins 
       SET "passwordHash" = $1, "requiresPasswordChange" = false 
       WHERE id = $2`,
      [newHash, admin.id]
    );

    req.session.admin = { username: admin.username, gymId: admin.gymId };
    delete req.session.pendingAdmin;

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
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
      return res.status(400).send('<h3>Enter a username and a password of 8–200 characters. <a href="/admins">Back to Admins</a></h3>');
    }

    const existing = await pool.query('SELECT 1 FROM admins WHERE username = $1', [newUsername]);
    if (existing.rowCount > 0) {
      return res.send('<h3>Username already exists! <a href="/admins">Back to Admins</a></h3>');
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'INSERT INTO admins (username, "passwordHash", "gymId", "requiresPasswordChange") VALUES ($1, $2, $3, false)',
      [newUsername, hash, currentGymId]
    );
    res.send('<h3>Admin Created Successfully! <a href="/admins">Back to Admins</a></h3>');
  })
);

// Publishable Stripe key
app.get('/stripe-key', (req, res) => {
  res.json({ publicKey: process.env.stripe_public_key });
});

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

  if (!planName || !monthlyPrice) {
    return res.status(400).json({ error: 'Plan name and monthly price are required.' });
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
        `plan_${Date.now()}`,
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
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// MEMBER ENROLLMENT & MANAGEMENT ENDPOINTS
// -----------------------------------------------------------------------------

// Register new member & attach subscription + sign-up fee with platform fee
app.post('/create-subscription', requireLogin, async (req, res) => {
  const { paymentMethodId, email, fullName, phone, barcode, planId } = req.body;
  const gymId = req.session.admin.gymId;

  try {
    // Validate the gym's current waiver before creating a customer or charging a card.
    const waiver = await checkWaiver(pool, gymId, req.body);
    const details = contactDetails(req.body.contactDetails);
    const photo = signupPhoto(req.body.photo);
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.length > 200 ||
        typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof phone !== 'string' || phone.trim().length < 5 || phone.length > 50) {
      return res.status(400).json({ error: 'Enter a full name, valid email, and phone number.' });
    }
    let assignedBarcode = barcode;
    if (assignedBarcode) {
      const dup = await pool.query('SELECT 1 FROM members WHERE "gymId" = $1 AND barcode = $2', [
        gymId,
        assignedBarcode,
      ]);
      if (dup.rowCount > 0) {
        return res.status(400).json({ error: 'That barcode is already assigned to another member.' });
      }
    } else {
      for (let i = 0; i < 10; i++) {
        const candidate = `BC-${Math.floor(1000 + Math.random() * 9000)}`;
        const dup = await pool.query('SELECT 1 FROM members WHERE "gymId" = $1 AND barcode = $2', [
          gymId,
          candidate,
        ]);
        if (dup.rowCount === 0) {
          assignedBarcode = candidate;
          break;
        }
      }
      if (!assignedBarcode) {
        return res.status(500).json({ error: 'Could not generate a unique barcode. Try again.' });
      }
    }

    // 1. Create Customer in Stripe
    const customer = await stripe.customers.create({
      payment_method: paymentMethodId,
      email,
      name: fullName,
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 2. Attach Payment Method to Customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customer.id,
    });

    let createdSubscriptionId = null;

    // 3. Create Subscription in Stripe with Platform Fee Cut & One-time Sign-up Fee
    if (planId) {
      const planRes = await pool.query('SELECT * FROM plans WHERE id = $1 AND "gymId" = $2', [
        planId,
        gymId,
      ]);

      if (planRes.rows.length > 0 && planRes.rows[0].stripePriceId) {
        const plan = planRes.rows[0];

        // Fetch connected Stripe Account ID if the gym has one set
        const gymRes = await pool.query('SELECT "stripeAccountId" FROM gyms WHERE id = $1', [gymId]);
        const connectedAccountId = gymRes.rows[0]?.stripeAccountId;

        // Build array for upfront fees (e.g., sign-up fee)
        const addInvoiceItems = [];
        if (plan.stripeSignupPriceId) {
          addInvoiceItems.push({ price: plan.stripeSignupPriceId });
        }

        const subPayload = {
          customer: customer.id,
          items: [{ price: plan.stripePriceId }],
          ...(addInvoiceItems.length > 0 && { add_invoice_items: addInvoiceItems }),
          application_fee_percent: PLATFORM_FEE_PERCENT,
          expand: ['latest_invoice.payment_intent'],
        };

        if (connectedAccountId) {
          subPayload.transfer_data = { destination: connectedAccountId };
        }

        const subscription = await stripe.subscriptions.create(subPayload);
        createdSubscriptionId = subscription.id;
      }
    }

    await pool.query(
      `WITH new_member AS (INSERT INTO members
        ("fullName", email, phone, barcode, status, "planId", "stripeCustomerId", "stripeSubscriptionId", "gymId",
         "waiverDocumentId", "waiverAcceptedAt", "waiverSignedName", "contactDetails")
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id)
       INSERT INTO member_photos ("memberId", "gymId", content, "contentType")
       SELECT id, $8, $13::bytea, $14 FROM new_member WHERE $13::bytea IS NOT NULL`,
      [
        fullName,
        email,
        phone || '',
        assignedBarcode,
        planId || null,
        customer.id,
        createdSubscriptionId,
        gymId,
        waiver?.documentId || null,
        waiver?.acceptedAt || null,
        waiver?.signedName || null,
        JSON.stringify(details),
        photo?.content || null,
        photo?.type || null,
      ]
    );

    res.json({ success: true, barcode: assignedBarcode });
  } catch (error) {
    console.error('Stripe registration error:', error);
    res.status(400).json({ error: error.message });
  }
});

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

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Gymvelto Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
