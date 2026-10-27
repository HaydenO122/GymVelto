// A consistent sign-in redirect for expired sessions, including JSON API calls.
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const target = new URL(typeof args[0] === 'string' ? args[0] : args[0].url,location.href);
  if (target.origin === location.origin && response.status === 401) {
    location.assign('/index.html?expired=1');
    throw new Error('Your session expired. Please sign in again.');
  }
  return response;
};
// Automatically inject the top-left Gymvelto brand link on every page
document.addEventListener("DOMContentLoaded", () => {
  const nav = document.querySelector('nav');
  if (nav && !/^(\/|\/index.html|\/login.html)$/.test(location.pathname)) {
    nav.replaceChildren();
    [['/getting-started','Get started'],['/dashboard','Dashboard'],['/billing','Billing'],['/check-ins','Check-ins'],['/scan','Barcode Scanner'],['/members','Members'],['/signup','Sign Up Member'],['/plans','Plans'],['/documents','Documents'],['/gym-profile','Gym Profile'],['/admins','Admins'],['/logout','Logout']].forEach(([href,label]) => {
      const link = document.createElement('a'); link.href = href; link.textContent = label;
      if (location.pathname.replace(/\.html$/, '') === href) { link.className = 'active'; link.setAttribute('aria-current','page'); }
      nav.append(link);
    });
  }
  const heading = document.getElementById('gym-dashboard-title');
  if (heading) fetch('/api/gym-profile').then(res => {
    if (!res.ok) throw new Error('Could not load gym profile');
    return res.json();
  }).then(profile => {
    heading.textContent = profile.dashboardTitle;
    const name = document.getElementById('gym-dashboard-name');
    name.textContent = profile.name; name.hidden = false;
    const logo = document.getElementById('gym-dashboard-logo');
    if (profile.hasLogo) { logo.src = '/api/gym-profile/logo'; logo.hidden = false; }
  }).catch(() => { /* Keep the default dashboard heading if profile loading fails. */ });
  const existingBrand = document.querySelector('.brand-header');
  if (existingBrand) existingBrand.id = 'rack-access-brand';
  if (!existingBrand) {
    const brand = document.createElement("a");
    brand.id = "rack-access-brand";
    brand.href = "/dashboard";
    brand.textContent = "Gymvelto";
    brand.className = "brand-header";
    
    document.body.prepend(brand);
  }
});


document.addEventListener('DOMContentLoaded',async () => {
  if (/^(\/|\/index.html|\/login.html)$/.test(location.pathname)) return;
  const notice=document.createElement('aside');notice.className='beta-notice';notice.setAttribute('role','status');
  notice.textContent='Gymvelto beta';document.body.prepend(notice);
  try {
    const profile=await (await fetch('/api/gym-profile')).json();
    const config=await (await fetch('/api/billing-status')).json();
    notice.textContent=profile.name + ' • Gymvelto beta • ' + (config.mode === 'test' ? 'Sandbox payments — test cards only. No real charges.' : config.ready ? 'Live payments' : 'Billing setup required');
    const help=document.createElement('a');help.href='mailto:gymvelto@gmail.com';help.textContent=' Get help';notice.append(help);
  } catch { notice.textContent='Gymvelto beta • Unable to load account status. Refresh or contact gymvelto@gmail.com.'; }
});
