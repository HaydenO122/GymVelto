const docMessage = document.getElementById('document-message');
async function docRequest(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Could not complete the request.'); }
  return res.json();
}
async function loadDocuments() {
  const docs = await docRequest('/api/documents');
  const list = document.getElementById('document-list');
  list.replaceChildren();
  if (!docs.length) { list.textContent = 'No documents yet. Upload a PDF above to get started.'; return; }
  docs.forEach(doc => {
    const card = document.createElement('article'); card.className = 'gym-document-card';
    const title = document.createElement('h3'); title.textContent = doc.title;
    const detail = document.createElement('p');
    detail.textContent = `${doc.kind === 'waiver' ? (doc.active ? 'Current signup waiver' : 'Previous waiver') : (doc.active ? 'Document' : 'Archived document')} · ${new Date(doc.uploadedAt).toLocaleDateString()} · ${Math.ceil(doc.bytes / 1024)} KB`;
    const link = document.createElement('a'); link.href = `/api/documents/${doc.id}/file`; link.textContent = 'Download PDF';
    card.append(title, detail, link);
    if (doc.kind === 'waiver') {
      const view = document.createElement('button'); view.type = 'button'; view.textContent = `View acknowledgements (${doc.acceptances})`;
      view.onclick = async () => {
        try {
          const rows = await docRequest(`/api/documents/${doc.id}/acceptances`);
          document.getElementById('acceptance-panel').hidden = false;
          document.getElementById('acceptance-title').textContent = `Acknowledgements: ${doc.title}`;
          const list = document.getElementById('acceptance-list'); list.replaceChildren();
          if (!rows.length) list.textContent = 'No member acknowledgements for this version yet.';
          rows.forEach(row => { const p = document.createElement('p'); p.textContent = `${row.fullName} — entered name: ${row.waiverSignedName} — ${new Date(row.waiverAcceptedAt).toLocaleString()}`; list.append(p); });
        } catch (err) { docMessage.textContent = err.message; }
      };
      card.append(view);
    }
    if (doc.active) {
      const archive = document.createElement('button'); archive.type = 'button'; archive.textContent = 'Archive';
      archive.onclick = async () => {
        if (!confirm(doc.kind === 'waiver' ? 'Stop requiring this waiver for new signups? Existing acknowledgements will remain saved.' : 'Archive this document? The file will remain saved.')) return;
        try { await docRequest(`/api/documents/${doc.id}/archive`, { method: 'POST' }); await loadDocuments(); }
        catch (err) { docMessage.textContent = err.message; }
      };
      card.append(archive);
    }
    list.append(card);
  });
}
document.getElementById('document-form').onsubmit = async event => {
  event.preventDefault();
  const file = document.getElementById('file').files[0];
  if (!file || file.size > 5 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.pdf')) { docMessage.textContent = 'Choose a PDF file, up to 5 MB.'; return; }
  const button = document.getElementById('upload-button'); button.disabled = true; docMessage.textContent = 'Uploading…';
  try {
    const query = new URLSearchParams({ title: document.getElementById('title').value.trim(), kind: document.getElementById('kind').value, filename: file.name });
    await docRequest(`/api/documents?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
    event.target.reset(); await loadDocuments(); docMessage.textContent = 'Document saved.';
  } catch (err) { docMessage.textContent = err.message; }
  finally { button.disabled = false; }
};
loadDocuments().catch(err => { document.getElementById('document-list').textContent = err.message; });
