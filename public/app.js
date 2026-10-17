// Automatically inject the top-left Gymvelto brand link on every page
document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("rack-access-brand")) {
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