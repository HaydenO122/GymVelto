// Automatically inject the top-left Gymvelto brand link on every page
document.addEventListener("DOMContentLoaded", () => {
  const nav = document.querySelector('nav');
  if (nav && !/^(\/|\/index.html|\/login.html)$/.test(location.pathname)) {
    nav.replaceChildren();
    [['/dashboard','Dashboard'],['/scan','Barcode Scanner'],['/members','Members'],['/signup','Sign Up Member'],['/plans','Plans'],['/documents','Documents'],['/gym-profile','Gym Profile'],['/admins','Admins'],['/logout','Logout']].forEach(([href,label]) => {
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

// Member Form Handling Logic
const memberForm = document.getElementById('memberForm');
const membersUl = document.getElementById('membersUl');

const members = [];

if (memberForm) {
  memberForm.addEventListener('submit', function(event) {
    event.preventDefault();

    const fullName = memberForm.fullName.value.trim();
    const email = memberForm.email.value.trim();
    const phone = memberForm.phone.value.trim();

    if (fullName && email) {
      const member = { fullName, email, phone };
      members.push(member);

      // Add member to UI list if the list element exists on the page
      if (membersUl) {
        const li = document.createElement('li');
        li.textContent = `${fullName} (${email}${phone ? ', ' + phone : ''})`;
        membersUl.appendChild(li);
      }

      // Clear form fields
      memberForm.reset();
    } else {
      alert('Please complete at least name and email fields.');
    }
  });
}
