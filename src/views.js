function escapeHtml (value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

export function badge (status) {
  return `<span class="badge badge-${String(status).toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(status)}</span>`
}

export function layout (title, body, options = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Connect & Listen</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><a class="brand" href="/">Connect & Listen</a><nav><a href="/connections">Connections</a><a href="/events">Events</a>${options.testMode ? '<a href="/diagnostics">Diagnostics</a>' : ''}</nav></header>
<main><div class="eyebrow">GitHub connector fixture</div><h1>${escapeHtml(title)}</h1>${body}</main>
<footer>Local QA fixture — not production INK behavior and not for customer data.</footer>
<script>
document.addEventListener('submit', async event => {
  const form = event.target.closest('form[data-api]'); if (!form) return; event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  const response = await fetch(form.action, { method: form.method || 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  if (!response.ok) { const result = await response.json().catch(() => ({})); alert(result.error || 'Request failed'); return }
  location.href = form.dataset.redirect || location.href;
});
</script></body></html>`
}

export function table (headers, rows, empty = 'No records yet.') {
  if (!rows.length) return `<div class="empty">${escapeHtml(empty)}</div>`
  return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

export function fmt (value) {
  return value ? escapeHtml(new Date(value).toLocaleString()) : '—'
}

export { escapeHtml }
