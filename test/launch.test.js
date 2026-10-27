const {test}=require('node:test');
const assert=require('node:assert/strict');
const {money,subscriptionPayload,syncMember,readiness}=require('../billing');
const {validPassword,sameOrigin}=require('../security');
test('money validation rejects negative, non-finite and over-precision fees',()=>{
  for(const v of [-1,NaN,Infinity,'1.001','1e3','abc',{},'1000000'])assert.equal(money(v),null);
  assert.equal(money('19.99',true),19.99);assert.equal(money('',false),0);assert.equal(money(0,true),null);
});
test('new passwords meet length and bcrypt UTF-8 limits',()=>{
  assert.equal(validPassword('short'),false);assert.equal(validPassword('twelve-characters'),true);assert.equal(validPassword('🎉'.repeat(30)),false);
});
test('subscription includes annual and signup fees, without Connect fee in sandbox standalone flow',()=>{
  const plan={stripePriceId:'price_month',stripeYearlyPriceId:'price_year',stripeSignupPriceId:'price_signup'};
  const payload=subscriptionPayload(plan,'cus_a','pm_a','gym-a',42,null);
  assert.deepEqual(payload.items,[{price:'price_month'},{price:'price_year'}]);assert.equal(payload.billing_mode.type,'flexible');
  assert.equal(payload.application_fee_percent,undefined);assert.equal(payload.payment_behavior,'default_incomplete');assert.deepEqual(payload.metadata,{gymId:'gym-a',memberId:'42'});
  assert.equal(subscriptionPayload(plan,'cus_a','pm_a','gym-a',42,'acct_a').transfer_data.destination,'acct_a');
});
test('billing synchronization rejects a foreign customer or gym before writes',async()=>{
  const db={query(){throw new Error('Must not write');}};
  const member={id:1,stripeCustomerId:'cus_a'};
  await assert.rejects(syncMember(db,'gym-a',member,{customer:'cus_b'}),/ownership/);
  await assert.rejects(syncMember(db,'gym-a',member,{customer:'cus_a',metadata:{gymId:'gym-b'}}),/ownership/);
});
test('failed or incomplete subscriptions never grant gym access',async()=>{
  for(const status of ['incomplete','incomplete_expired','past_due','unpaid','canceled','paused']){
    await syncMember({async query(sql,args){assert.match(sql,/"gymId"=\$5/);assert.equal(args[2],'unpaid');assert.equal(args[4],'gym-a');}},'gym-a',{id:1,stripeCustomerId:'cus_a'},{id:'sub_a',customer:'cus_a',status,metadata:{gymId:'gym-a'}});
  }
});
test('live billing fails closed without gym destination or webhook',async()=>{
  const old={secret:process.env.STRIPE_SECRET_KEY,public:process.env.STRIPE_PUBLISHABLE_KEY,webhook:process.env.STRIPE_WEBHOOK_SECRET};
  try{
    process.env.STRIPE_SECRET_KEY='sk_live_mock';process.env.STRIPE_PUBLISHABLE_KEY='pk_live_mock';delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal((await readiness({async query(){return {rows:[{}]};}},'a')).ready,false);
    assert.equal((await readiness({async query(){return {rows:[{stripeAccountId:'acct_a'}]};}},'a')).ready,false);
  }finally{for(const [key,value] of [['STRIPE_SECRET_KEY',old.secret],['STRIPE_PUBLISHABLE_KEY',old.public],['STRIPE_WEBHOOK_SECRET',old.webhook]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('cross-site writes are rejected before route execution',()=>{
  let called=false;const req={method:'POST',protocol:'https',get(name){return {host:'gymvelto.onrender.com',origin:'https://evil.example'}[name];}};
  const res={status(code){assert.equal(code,403);return this;},json(){called=true;}};
  sameOrigin(req,res,()=>{throw new Error('Cross-site request passed');});assert.ok(called);
});
