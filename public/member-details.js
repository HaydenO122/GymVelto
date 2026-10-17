window.MemberDetails = {
  fields: [
    ['addressLine1','Street address',200,'address-line1'], ['addressLine2','Apartment / suite',200,'address-line2'],
    ['city','City',100,'address-level2'], ['region','State / province',100,'address-level1'],
    ['postalCode','ZIP / postal code',30,'postal-code'], ['country','Country',100,'country-name'],
    ['emergencyName','Emergency contact name',150,'off'], ['emergencyPhone','Emergency contact phone',50,'off'],
    ['emergencyRelationship','Relationship to member',100,'off']
  ],
  fill(data = {}) { this.fields.forEach(([key]) => { document.getElementById(`member-${key}`).value = data[key] || ''; }); },
  payload() { return Object.fromEntries(this.fields.map(([key]) => [key,document.getElementById(`member-${key}`).value.trim()])); },
  async photo() {
    const file = document.getElementById('member-photo-file')?.files[0];
    if (!file) return null;
    if (file.size > 1024*1024 || !['image/png','image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPG photo, up to 1 MB.');
    return new Promise((resolve,reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read the member photo.'));
      reader.readAsDataURL(file);
    });
  }
};
const detailsHost = document.getElementById('member-extra-details');
if (detailsHost) {
  MemberDetails.fields.forEach(([key,label,max,autocomplete],index) => {
    if (index === 0 || index === 6) { const heading=document.createElement('h2');heading.textContent=index===0?'Address (optional)':'Emergency contact (optional)';detailsHost.append(heading); }
    const caption=document.createElement('label');caption.htmlFor=`member-${key}`;caption.textContent=label;
    const input=document.createElement('input');input.id=`member-${key}`;input.maxLength=max;input.autocomplete=autocomplete;
    input.type=key==='emergencyPhone'?'tel':'text';detailsHost.append(caption,input);
  });
}
let memberPhotoUrl;
document.getElementById('member-photo-file')?.addEventListener('change',event => {
  const preview=document.getElementById('member-photo-preview'); const file=event.target.files[0];
  event.target.setCustomValidity('');
  if (memberPhotoUrl) URL.revokeObjectURL(memberPhotoUrl);
  preview.hidden=!file;
  if (!file) return;
  if (file.size>1024*1024 || !['image/png','image/jpeg'].includes(file.type)) {
    event.target.setCustomValidity('Choose a PNG or JPG photo, up to 1 MB.');preview.hidden=true;
  } else { event.target.setCustomValidity('');memberPhotoUrl=URL.createObjectURL(file);preview.src=memberPhotoUrl; }
});
