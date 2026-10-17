window.GymWaiver = {
  current: null,
  async load() {
    const res = await fetch('/api/documents');
    if (!res.ok) throw new Error('Could not load the gym waiver. Refresh before registering a member.');
    const docs = await res.json();
    this.current = docs.find(doc => doc.kind === 'waiver' && doc.active) || null;
    const section = document.getElementById('waiver-section');
    section.hidden = !this.current;
    const checkbox = document.getElementById('waiver-accepted');
    const name = document.getElementById('waiver-name');
    checkbox.required = !!this.current; name.required = !!this.current;
    checkbox.checked = false; name.value = '';
    if (this.current) {
      const link = document.getElementById('waiver-link');
      link.href = `/api/documents/${this.current.id}/file`; link.textContent = `Download and review: ${this.current.title}`;
    }
  },
  payload() {
    return { waiverDocumentId: this.current?.id || null,
      waiverAccepted: document.getElementById('waiver-accepted').checked,
      waiverSignedName: document.getElementById('waiver-name').value.trim() };
  }
};
