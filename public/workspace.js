'use strict';
const content=document.getElementById('workspace-content');
const title=document.getElementById('workspace-title');
function node(tag,text,className) { const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el; }
async function get(url) { const res=await fetch(url);if(!res.ok)throw new Error('Unable to load this section. Please refresh.');return res.json(); }
function card(title,description,href,label) { const el=node('article','','workspace-card');el.append(node('h2',title),node('p',description));if(href){const a=node('a',label || 'Open','workspace-link');a.href=href;el.append(a);}return el; }
async function load() {
  const section=location.pathname;
  content.replaceChildren();
  if(section==='/billing') {
    title.textContent='Billing overview';
    const config=await get('/api/billing-status');
    content.append(card(config.mode==='test' ? 'Sandbox beta' : 'Live payment setup',config.mode==='test' ? 'Payments use Stripe test mode. Use test cards only; no real money is collected.' : config.ready ? 'Your gym is configured for live payments.' : config.reason));
    content.append(card('Payment updates',config.webhooksConfigured ? 'Stripe payment notifications are configured.' : 'Automatic payment notifications still need configuration. Sandbox results can be checked after signup. Live billing stays disabled until notifications are configured.'));
    const members=await get('/api/members');
    const table=node('table','');const head=node('thead','');const tr=node('tr','');['Member','Access','Stripe status','Action'].forEach(x=>tr.append(node('th',x)));head.append(tr);table.append(head);const body=node('tbody','');
    members.forEach(m=>{
      const row=node('tr','');[m.fullName,m.status,m.billingStatus || 'Not synchronized'].forEach(x=>row.append(node('td',x)));
      const action=node('td','');
      if(m.stripeSubscriptionId && !['canceled','incomplete_expired'].includes(m.billingStatus)) {
        const button=node('button','Cancel subscription');button.type='button';
        button.onclick=async()=>{
          if(!confirm(`Cancel ${m.fullName}'s subscription now? Future billing and gym access will stop immediately. No refund will be issued.`))return;
          button.disabled=true;
          try{const res=await fetch('/api/member/'+encodeURIComponent(m.barcode)+'/cancel-subscription',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});const result=await res.json();if(!res.ok)throw new Error(result.error);await load();}
          catch(err){alert(err.message);button.disabled=false;}
        };action.append(button);
      }
      row.append(action);body.append(row);
    });table.append(body);content.append(table);
    content.append(card('Before removing a member','Cancel their subscription in Stripe first. Removing a member record does not cancel billing.','/members','Open members'));
  } else if(section==='/check-ins') {
    title.textContent='Check-in history';
    const rows=await get('/api/check-ins');
    content.append(card('Recent visits','The latest 100 scan attempts for your gym.','/scan','Open scanner'));
    if(!rows.length){content.append(node('p','No check-ins yet. Scan a member barcode to record the first visit.'));return;}
    const table=node('table','');const head=node('thead','');const tr=node('tr','');['Time','Member','Result'].forEach(x=>tr.append(node('th',x)));head.append(tr);table.append(head);const body=node('tbody','');
    rows.forEach(r=>{const row=node('tr','');[new Date(r.createdAt).toLocaleString(),r.fullName || 'Unknown member',r.access ? 'Granted' : 'Denied'].forEach(x=>row.append(node('td',x)));body.append(row);});table.append(body);content.append(table);
  } else {
    const [profile,plans,docs,members]=await Promise.all([get('/api/gym-profile'),get('/api/plans'),get('/api/documents'),get('/api/members')]);
    title.textContent='Welcome to '+profile.name;
    const grid=node('div','','workspace-grid');
    grid.append(card('1. Make it yours','Set your gym name, logo, and dashboard title.','/gym-profile','Edit gym profile'));
    grid.append(card('2. Set up your plans',plans.length ? `${plans.length} plan(s) in your workspace. Review fees before enrolling members.` : 'Create your first membership plan with clear monthly and optional fees.','/plans','Manage plans'));
    grid.append(card('3. Add your waiver',docs.some(d=>d.kind==='waiver'&&d.active) ? 'Your gym has an active waiver. New members must acknowledge it.' : 'Upload your gym’s own waiver for members to review at signup.','/documents','Manage documents'));
    grid.append(card('4. Bring your team','Create individual administrator logins for staff. Accounts created here belong only to this gym.','/admins','Manage staff'));
    grid.append(card('5. Try an enrollment',members.length ? `${members.length} member record(s) in your gym.` : 'Register a test member and try your barcode scanner.','/signup','Register a member'));
    grid.append(card('6. Check billing readiness','Review sandbox mode, payment notifications, and member billing status.','/billing','Review billing'));
    content.append(grid);
  }
}
load().catch(err=>content.replaceChildren(node('p',err.message,'error-message')));
