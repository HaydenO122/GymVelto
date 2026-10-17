const photoStatus=document.getElementById('photo-status');
function memberPhotoPath() { return `/api/member/${encodeURIComponent(document.getElementById('originalBarcode').value)}/photo`; }
document.getElementById('replace-photo').onclick=async() => {
  const file=document.getElementById('member-photo-file').files[0];
  if(!file || file.size>1024*1024 || !['image/png','image/jpeg'].includes(file.type)) { photoStatus.textContent='Choose a PNG or JPG photo, up to 1 MB.';return; }
  try {
    const response=await fetch(memberPhotoPath(),{method:'POST',headers:{'Content-Type':file.type},body:file});
    if(!response.ok) {const data=await response.json().catch(()=>({}));throw new Error(data.error||'Could not save photo.');}
    document.getElementById('member-photo-preview').src=`${memberPhotoPath()}?v=${Date.now()}`;
    document.getElementById('member-photo-preview').hidden=false;document.getElementById('remove-photo').hidden=false;
    photoStatus.textContent='Member photo saved.';
  } catch(error) {photoStatus.textContent=error.message;}
};
document.getElementById('remove-photo').onclick=async() => {
  try {
    const response=await fetch(memberPhotoPath(),{method:'DELETE'});if(!response.ok)throw new Error('Could not remove photo.');
    document.getElementById('member-photo-preview').hidden=true;document.getElementById('member-photo-file').value='';document.getElementById('remove-photo').hidden=true;
    photoStatus.textContent='Member photo removed.';
  } catch(error) {photoStatus.textContent=error.message;}
};
