const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
test('two real gym sessions isolate every operational resource and migration is repeatable',{skip:process.env.RUN_DB_TESTS!=='1'},async()=>{
  require('dotenv').config();
  // This suite is intentionally restricted to the isolated launch-validation branch.
  if(!process.env.DATABASE_URL?.includes(process.env.TEST_DATABASE_HOST || 'INVALID_TEST_HOST'))throw new Error('Set the explicit isolated TEST_DATABASE_HOST.');
  const {app,pool,initDb}=require('../Server');const bcrypt=require('bcryptjs');
  await initDb();await initDb();
  const suffix=randomUUID();const gyms=['qa-a-'+suffix,'qa-b-'+suffix];const password='Integration-Test-Password-123';
  const hash=await bcrypt.hash(password,10);let server;
  try{
    for(const g of gyms){
      await pool.query('INSERT INTO gyms (id,name) VALUES ($1,$2)',[g,g]);
      await pool.query('INSERT INTO admins (username,"passwordHash","gymId") VALUES ($1,$2,$1)',[g,hash]);
      await pool.query('INSERT INTO plans (id,"gymId","planName","monthlyPrice","stripePriceId") VALUES ($1,$1,$2,20,$3)',[g,'Plan '+g,'price_'+g]);
      await pool.query('INSERT INTO members ("fullName",email,phone,barcode,status,"gymId","planId") VALUES ($1,$2,$3,$4,$5,$1,$1)',[g,'qa@example.invalid','8035550100','same-barcode','active']);
    }
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const send=(path,cookie,method='GET',body)=>fetch(base+path,{method,redirect:'manual',headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const cookies=[];
    for(const g of gyms){const r=await send('/login',null,'POST',{username:g,password});assert.equal(r.status,302);cookies.push(r.headers.get('set-cookie').split(';')[0]);}
    assert.notEqual(cookies[0],cookies[1]);
    for(const path of ['/api/members','/api/plans','/api/documents','/api/gym-profile','/api/check-ins','/api/billing-status'])assert.equal((await send(path)).status,401);
    for(const path of ['/dashboard.html','/signup.html','/members.html','/billing','/check-ins'])assert.equal((await send(path)).status,302);
    assert.equal((await send('/provision-gym?gymId='+gyms[0]+'&username=hijack')).status,410);
    for(let i=0;i<2;i++){
      const roster=await (await send('/api/members?gymId='+gyms[1-i],cookies[i])).json();assert.equal(roster.length,1);assert.equal(roster[0].gymId,gyms[i]);
      const plans=await (await send('/api/plans?gymId='+gyms[1-i],cookies[i])).json();assert.equal(plans.length,1);assert.equal(plans[0].gymId,gyms[i]);
      const member=await (await send('/api/member/same-barcode',cookies[i])).json();assert.equal(member.fullName,gyms[i]);
    }
    await send('/api/gym-profile',cookies[0],'POST',{name:'Gym A only',dashboardTitle:'A dashboard',gymId:gyms[1]});
    assert.equal((await (await send('/api/gym-profile',cookies[1])).json()).name,gyms[1]);
    const scan=await (await send('/api/verify-scan',cookies[0],'POST',{barcode:'same-barcode',gymId:gyms[1]})).json();assert.equal(scan.memberName,gyms[0]);
    assert.equal((await (await send('/api/check-ins',cookies[0])).json()).length,1);assert.equal((await (await send('/api/check-ins',cookies[1])).json()).length,0);
    const foreignPlan=await send('/create-subscription',cookies[0],'POST',{enrollmentId:randomUUID(),paymentMethodId:'pm_test',fullName:'Test',email:'qa@example.invalid',phone:'8035550100',planId:gyms[1]});assert.equal(foreignPlan.status,400);assert.match((await foreignPlan.json()).error,/belonging/);
    // Exercise actual enrollment persistence with a fake payment provider: no real Stripe calls.
    const express=require('express');const billing=require('../billing');let creates=0;let sub;
    const provider={customers:{async create(){return {id:'cus_qa'};}},paymentMethods:{async attach(){}},subscriptions:{
      async create(payload){creates++;sub={id:'sub_qa_'+suffix,customer:payload.customer,status:'incomplete',metadata:payload.metadata,latest_invoice:{confirmation_secret:{client_secret:'test_secret'}}};return sub;},
      async retrieve(){return sub;}
    }};
    const billingApp=express();billingApp.use(express.json({limit:'2mb'}));billingApp.use((req,res,next)=>{req.session={admin:{gymId:gyms[0]}};next();});
    billingApp.post('/enroll',billing.enrollment(pool,provider));billingApp.post('/confirm',billing.confirmEnrollment(pool,provider));
    const bs=billingApp.listen(0,'127.0.0.1');await new Promise(r=>bs.once('listening',r));
    try{
      const doc=randomUUID();await pool.query('INSERT INTO gym_documents (id,"gymId",title,filename,content,sha256,kind) VALUES ($1,$2,$3,$4,$5,$6,$7)',[doc,gyms[0],'QA waiver','qa.pdf',Buffer.from('%PDF-1.7\n%%EOF'),'test','waiver']);
      const payload={enrollmentId:randomUUID(),paymentMethodId:'pm_qa',fullName:'Pending QA',email:'qa@example.invalid',phone:'8035550100',planId:gyms[0],barcode:'pending-qa'};
      const post=(route,body)=>fetch(`http://127.0.0.1:${bs.address().port}`+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal((await post('/enroll',payload)).status,400);assert.equal(creates,0);
      Object.assign(payload,{waiverDocumentId:doc,waiverAccepted:true,waiverSignedName:'Pending QA',contactDetails:{city:'Columbia'},photo:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16)]).toString('base64')});
      const first=await (await post('/enroll',payload)).json();assert.equal(first.success,false);assert.equal(first.clientSecret,'test_secret');assert.equal(creates,1);
      const pending=(await pool.query('SELECT * FROM members WHERE "gymId"=$1 AND "enrollmentId"=$2',[gyms[0],payload.enrollmentId])).rows[0];assert.equal(pending.status,'unpaid');assert.equal(pending.waiverDocumentId,doc);assert.equal(pending.contactDetails.city,'Columbia');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_photos WHERE "memberId"=$1 AND "gymId"=$2',[pending.id,gyms[0]])).rows[0].n,1);
      await post('/enroll',payload);assert.equal(creates,1);
      assert.equal((await post('/enroll',{...payload,fullName:'Changed'})).status,409);
      sub.status='active';assert.equal((await (await post('/confirm',{enrollmentId:payload.enrollmentId})).json()).success,true);
      assert.equal((await pool.query('SELECT status FROM members WHERE id=$1',[pending.id])).rows[0].status,'active');
      assert.equal((await send('/api/enrollment/confirm',cookies[1],'POST',{enrollmentId:payload.enrollmentId})).status,404);
    }finally{bs.closeAllConnections();await new Promise(r=>bs.close(r));}
    assert.equal((await send('/api/enrollment/confirm',cookies[0],'POST',{enrollmentId:randomUUID(),gymId:gyms[1]})).status,404);
    const update=await send('/api/update-member',cookies[0],'POST',{originalBarcode:'same-barcode',fullName:'Only A changed',email:'qa@example.invalid',phone:'8035550100',barcode:'same-barcode',status:'unpaid',gymId:gyms[1]});assert.equal(update.status,200);
    assert.equal((await (await send('/api/member/same-barcode',cookies[1])).json()).fullName,gyms[1]);
    const del=await send('/api/member/same-barcode',cookies[0],'DELETE');assert.equal(del.status,200);assert.equal((await send('/api/member/same-barcode',cookies[1])).status,200);
    const csrf=await fetch(base+'/api/verify-scan',{method:'POST',headers:{Cookie:cookies[1],Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
  }finally{
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    for(const table of ['check_ins','members','gym_documents','plans','admins','gyms'])await pool.query(`DELETE FROM ${table} WHERE ${table==='gyms'?'id':'"gymId"'}=ANY($1::text[])`,[gyms]);
    await pool.end();
  }
});
