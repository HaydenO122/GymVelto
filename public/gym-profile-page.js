const profileMessage = document.getElementById('profile-message');
async function profileRequest(url, options) {
  const res = await fetch(url, options); const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not complete the request.');
  return data;
}
function showLogo(hasLogo) {
  const image = document.getElementById('logo-preview'); image.hidden = !hasLogo;
  document.getElementById('remove-logo').hidden = !hasLogo;
  if (hasLogo) image.src = `/api/gym-profile/logo?v=${Date.now()}`;
}
profileRequest('/api/gym-profile').then(profile => {
  document.getElementById('gym-name').value = profile.name;
  document.getElementById('dashboard-title').value = profile.dashboardTitle;
  showLogo(profile.hasLogo);
  document.getElementById('save-profile').disabled = false;
  document.getElementById('save-logo').disabled = false;
}).catch(err => { profileMessage.textContent = err.message; });
document.getElementById('profile-form').onsubmit = async event => {
  event.preventDefault(); const button = document.getElementById('save-profile'); button.disabled = true;
  try {
    await profileRequest('/api/gym-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('gym-name').value, dashboardTitle: document.getElementById('dashboard-title').value }) });
    profileMessage.textContent = 'Gym profile saved. Your dashboard will use this name and heading.';
  } catch (err) { profileMessage.textContent = err.message; }
  finally { button.disabled = false; }
};
document.getElementById('logo-form').onsubmit = async event => {
  event.preventDefault(); const file = document.getElementById('logo-file').files[0];
  if (!file || file.size > 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) { profileMessage.textContent = 'Choose a PNG or JPG file, up to 1 MB.'; return; }
  const button = document.getElementById('save-logo'); button.disabled = true;
  try { await profileRequest('/api/gym-profile/logo', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }); showLogo(true); event.target.reset(); profileMessage.textContent = 'Logo saved.'; }
  catch (err) { profileMessage.textContent = err.message; }
  finally { button.disabled = false; }
};
document.getElementById('remove-logo').onclick = async () => {
  try { await profileRequest('/api/gym-profile/logo', { method: 'DELETE' }); showLogo(false); profileMessage.textContent = 'Logo removed.'; }
  catch (err) { profileMessage.textContent = err.message; }
};
