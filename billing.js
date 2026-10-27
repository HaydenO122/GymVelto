'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { checkWaiver } = require('./documents');
const { contactDetails, signupPhoto } = require('./member-details');

const idOf = value => typeof value === 'string' ? value : value?.id;
const active = status => ['active', 'trialing'].includes(status);
function mode() {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const publicKey = process.env.STRIPE_PUBLISHABLE_KEY || process.env.stripe_public_key || '';
  const secretMode = /^(sk|rk)_test_/.test(secret) ? 'test' : /^(sk|rk)_live_/.test(secret) ? 'live' : 'unconfigured';
  const matches = publicKey.startsWith(`pk_${secretMode}_`);
  return { mode: secretMode, publicKey, matches };
}
async function readiness(pool, gymId) {
  const config = mode();
  const { rows } = await pool.query('SELECT "stripeAccountId" FROM gyms WHERE id = $1', [gymId]);
  const destination = rows[0]?.stripeAccountId;
  let reason = '';
  if (!config.matches) reason = 'Payment keys are missing or do not use the same Stripe mode. Contact Gymvelto support.';
  else if (config.mode === 'live' && !destination) reason = 'Live billing is not enabled: this gym needs its own connected Stripe account.';
  else if (config.mode === 'live' && !process.env.STRIPE_WEBHOOK_SECRET) reason = 'Live billing is not enabled until payment status notifications are configured.';
  return { ...config, destination, ready: !reason, reason };
}
function money(value, required = false) {
  if (value === '' || value === undefined || value === null) return required ? null : 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= (required ? 0.01 : 0) && number <= 999999.99 ? number : null;
}
function subscriptionPayload(plan, customer, paymentMethod, gymId, memberId, destination) {
  const fee = Number(process.env.PLATFORM_FEE_PERCENT ?? 5);
  if (!Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error('Platform billing configuration is invalid.');
  return {
    customer, default_payment_method: paymentMethod,
    items: [{ price: plan.stripePriceId }, ...(plan.stripeYearlyPriceId ? [{ price: plan.stripeYearlyPriceId }] : [])],
    ...(plan.stripeSignupPriceId ? { add_invoice_items: [{ price: plan.stripeSignupPriceId }] } : {}),
    billing_mode: { type: 'flexible' }, payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    metadata: { gymId, memberId: String(memberId) },
    expand: ['latest_invoice.confirmation_secret'],
    ...(destination ? { transfer_data: { destination }, application_fee_percent: fee } : {}),
  };
}
async function syncMember(db, gymId, member, subscription) {
  if (idOf(subscription.customer) !== member.stripeCustomerId ||
      (subscription.metadata?.gymId && subscription.metadata.gymId !== gymId)) {
    throw new Error('Subscription ownership mismatch');
  }
  await db.query(`UPDATE members SET "stripeSubscriptionId"=$1, "billingStatus"=$2, status=$3
    WHERE id=$4 AND "gymId"=$5`, [subscription.id, subscription.status, active(subscription.status) ? 'active' : 'unpaid', member.id, gymId]);
}
function enrollment(pool, stripe) {
  return async (req, res, next) => {
    const gymId = req.session.admin.gymId;
    const b = req.body || {};
    let client;
    try {
      const config = await readiness(pool, gymId);
      if (!config.ready) return res.status(409).json({ error: config.reason });
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(b.enrollmentId || '') ||
          typeof b.paymentMethodId !== 'string' || !/^pm_\w+$/.test(b.paymentMethodId) ||
          typeof b.fullName !== 'string' || !b.fullName.trim() || b.fullName.length > 200 ||
          typeof b.email !== 'string' || b.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) ||
          typeof b.phone !== 'string' || b.phone.trim().length < 5 || b.phone.length > 50 ||
          typeof b.planId !== 'string' || (b.barcode && (typeof b.barcode !== 'string' || b.barcode.length > 100))) {
        return res.status(400).json({ error: 'Enter valid member details, a plan, and payment information.' });
      }
      const plan = (await pool.query('SELECT * FROM plans WHERE id=$1 AND "gymId"=$2', [b.planId, gymId])).rows[0];
      if (!plan?.stripePriceId) return res.status(400).json({ error: 'Select a valid plan belonging to your gym.' });
      const details = contactDetails(b.contactDetails);
      const photo = signupPhoto(b.photo);
      const hash = createHash('sha256').update(JSON.stringify([b.fullName,b.email,b.phone,b.barcode,b.planId,b.waiverDocumentId,b.waiverAccepted,b.waiverSignedName,details,b.photo])).digest('hex');
      client = await pool.connect();
      // Transaction locks also work through Neon's transaction-pooled connections.
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${gymId}:${b.enrollmentId}`]);
      let member = (await client.query('SELECT * FROM members WHERE "gymId"=$1 AND "enrollmentId"=$2', [gymId,b.enrollmentId])).rows[0];
      if (member && member.enrollmentHash !== hash) return res.status(409).json({ error: 'This enrollment has already started with different details. Refresh before starting a different enrollment.' });
      if (!member) {
        const waiver = await checkWaiver(client,gymId,b);
        const barcode = b.barcode?.trim() || `BC-${randomUUID().slice(0,12).toUpperCase()}`;
        try {
          member = (await client.query(`INSERT INTO members ("fullName",email,phone,barcode,status,"planId","gymId","waiverDocumentId","waiverAcceptedAt","waiverSignedName","contactDetails","enrollmentId","enrollmentHash")
            VALUES ($1,$2,$3,$4,'unpaid',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [b.fullName.trim(),b.email.trim(),b.phone.trim(),barcode,plan.id,gymId,waiver?.documentId || null,waiver?.acceptedAt || null,waiver?.signedName || null,JSON.stringify(details),b.enrollmentId,hash])).rows[0];
          if (photo) await client.query('INSERT INTO member_photos ("memberId","gymId",content,"contentType") VALUES ($1,$2,$3,$4)',[member.id,gymId,photo.content,photo.type]);
        } catch (err) { await client.query('ROLLBACK'); throw err; }
      }
      await client.query('COMMIT');
      // The pending record is durable before Stripe calls. A row lock serializes retries.
      await client.query('BEGIN');
      member=(await client.query('SELECT * FROM members WHERE "gymId"=$1 AND "enrollmentId"=$2 FOR UPDATE',[gymId,b.enrollmentId])).rows[0];
      if (!member.stripeSubscriptionId && Date.now()-new Date(member.createdAt).getTime()>23*60*60*1000) {
        return res.status(409).json({error:'This pending enrollment needs a support review before retrying, to prevent a duplicate payment.'});
      }
      const key = `gymvelto:${gymId}:${b.enrollmentId}`;
      if (!member.stripeCustomerId) {
        const customer = await stripe.customers.create({ email:member.email,name:member.fullName,metadata:{gymId,memberId:String(member.id)} },{idempotencyKey:`${key}:customer`});
        await client.query('UPDATE members SET "stripeCustomerId"=$1 WHERE id=$2 AND "gymId"=$3',[customer.id,member.id,gymId]);
        member.stripeCustomerId = customer.id;
      }
      let subscription;
      if (member.stripeSubscriptionId) {
        subscription = await stripe.subscriptions.retrieve(member.stripeSubscriptionId,{expand:['latest_invoice.confirmation_secret']});
      } else {
        // The same payment method must be retained by the browser when retrying an interrupted request.
        await stripe.paymentMethods.attach(b.paymentMethodId,{customer:member.stripeCustomerId},{idempotencyKey:`${key}:attach`});
        subscription = await stripe.subscriptions.create(subscriptionPayload(plan,member.stripeCustomerId,b.paymentMethodId,gymId,member.id,config.destination),{idempotencyKey:`${key}:subscription`});
      }
      await syncMember(client,gymId,member,subscription);
      await client.query('COMMIT');
      res.json({success:active(subscription.status),barcode:member.barcode,enrollmentId:b.enrollmentId,
        clientSecret:subscription.latest_invoice?.confirmation_secret?.client_secret || null,
        status:subscription.status,error:active(subscription.status) ? undefined : 'Complete payment authentication to activate this membership.'});
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error:'This barcode is already assigned. Use a different barcode.' });
      console.error('Enrollment failed', {type:err.type || err.name,code:err.code});
      res.status(400).json({error:err.type === 'StripeCardError' ? err.message : 'Enrollment could not be completed. Your pending record is saved. Retry without changing the form, or contact Gymvelto support.'});
    } finally {
      if (client) {
        try { await client.query('ROLLBACK'); client.release(); }
        catch (err) { client.release(err); }
      }
    }
  };
}
function confirmEnrollment(pool,stripe) {
  return async (req,res,next) => {
    try {
      const gymId=req.session.admin.gymId;
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(req.body.enrollmentId || '')) return res.status(400).json({error:'Invalid enrollment.'});
      const member=(await pool.query('SELECT * FROM members WHERE "gymId"=$1 AND "enrollmentId"=$2',[gymId,req.body.enrollmentId])).rows[0];
      if (!member?.stripeSubscriptionId) return res.status(404).json({error:'Enrollment not found.'});
      const sub=await stripe.subscriptions.retrieve(member.stripeSubscriptionId);
      await syncMember(pool,gymId,member,sub);
      res.json({success:active(sub.status),barcode:member.barcode,status:sub.status});
    } catch(err) { next(err); }
  };
}
function webhook(pool,stripe) {
  return async (req,res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
    let event;
    try { event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.sendStatus(400); }
    try {
      if (event.livemode !== (mode().mode === 'live')) return res.sendStatus(400);
      const obj=event.data.object;
      const subscriptionId=event.type.startsWith('customer.subscription.') ? obj.id : idOf(obj.parent?.subscription_details?.subscription || obj.subscription);
      if (!subscriptionId) return res.json({received:true});
      // Fetch current state; repeated or out-of-order events cannot restore stale access.
      const sub=await stripe.subscriptions.retrieve(subscriptionId);
      const gymId=sub.metadata?.gymId;
      if (!gymId) return res.json({received:true});
      const member=(await pool.query('SELECT * FROM members WHERE "gymId"=$1 AND ("stripeSubscriptionId"=$2 OR (id::text=$3 AND "stripeCustomerId"=$4))',
        [gymId,sub.id,sub.metadata.memberId || '',idOf(sub.customer)])).rows[0];
      if (member) await syncMember(pool,gymId,member,sub);
      res.json({received:true});
    } catch(err) { console.error('Billing notification failed',{type:err.type || err.name,code:err.code}); res.sendStatus(500); }
  };
}
module.exports={mode,readiness,money,subscriptionPayload,syncMember,enrollment,confirmEnrollment,webhook};
