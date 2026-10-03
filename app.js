import 'dotenv/config'
import express from 'express'
import { config, githubConfigured } from './src/config.js'
import { db, diagnostic, id, initializeDatabase, now, resetDatabase, setDiagnostic, transition } from './src/db.js'
import { installationDetails, installationRepositories, installationUrl, repositoryDetails } from './src/github.js'
import {
  createSource,
  getConnection,
  getSource,
  listConnections,
  listSources,
  updateSourceState,
  upsertConnection
} from './src/models.js'
import { startWorker, workerState } from './src/worker.js'
import { receiveWebhook, webhookBodyParser } from './src/webhooks.js'
import { badge, escapeHtml, fmt, layout, table } from './src/views.js'

initializeDatabase()
startWorker()

const app = express()
app.disable('x-powered-by')
app.post('/api/github/webhooks', webhookBodyParser, receiveWebhook)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))
app.use(express.static('public'))

function asyncRoute (handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function notFound (res, name = 'Record') {
  return res.status(404).json({ error: `${name} not found` })
}

function localOnly (req, res, next) {
  const remote = req.socket.remoteAddress || ''
  const local = remote === '127.0.0.1' || remote === '::1' || remote.endsWith('127.0.0.1')
  if (!config.testMode || !local) return res.status(404).json({ error: 'Not found' })
  next()
}

function repoShape (repository, selectedIds = new Set()) {
  return {
    id: repository.id,
    node_id: repository.node_id,
    owner: repository.owner?.login,
    name: repository.name,
    full_name: repository.full_name,
    visibility: repository.visibility || (repository.private ? 'private' : 'public'),
    selection_state: selectedIds.has(repository.id) ? 'Selected' : 'Unselected'
  }
}

app.get('/health', (req, res) => res.json({ ok: true, worker: workerState(), github_configured: githubConfigured() }))

app.get('/api/github/install', asyncRoute(async (req, res) => {
  res.redirect(await installationUrl())
}))

app.get('/api/github/callback', asyncRoute(async (req, res) => {
  const installationId = Number(req.query.installation_id)
  if (!installationId) return res.status(400).send('Missing installation_id')
  const installation = await installationDetails(installationId)
  const connection = upsertConnection(installation)
  res.redirect(`/connections/${connection.id}?installed=true`)
}))

app.get('/api/connections', (req, res) => res.json({ connections: listConnections() }))

app.get('/api/connections/:id', (req, res) => {
  const connection = getConnection(req.params.id)
  return connection ? res.json(connection) : notFound(res, 'Connection')
})

app.get('/api/connections/:id/repositories', asyncRoute(async (req, res) => {
  const connection = getConnection(req.params.id)
  if (!connection) return notFound(res, 'Connection')
  const selectedIds = new Set(connection.sources.filter(source => !source.removed_at).map(source => source.repository_id))
  const repositories = await installationRepositories(connection.installation_id)
  db().prepare('UPDATE connections SET last_provider_success_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), connection.id)
  res.json({ repositories: repositories.map(repository => repoShape(repository, selectedIds)) })
}))

app.post('/api/connections/:id/reauthorize', asyncRoute(async (req, res) => {
  const connection = getConnection(req.params.id)
  if (!connection) return notFound(res, 'Connection')
  db().prepare("UPDATE connections SET status = 'Reauth required', failure_cause = 'Reauthorization requested', updated_at = ? WHERE id = ?")
    .run(now(), connection.id)
  transition('Connection', connection.id, connection.status, 'Reauth required', 'Reauthorization requested', 'local user')
  res.json({ status: 'Reauth required', installation_url: await installationUrl() })
}))

app.get('/api/sources', (req, res) => res.json({ sources: listSources(req.query.connection_id) }))

app.post('/api/sources', asyncRoute(async (req, res) => {
  const connection = getConnection(req.body.connection_id)
  if (!connection) return notFound(res, 'Connection')
  const repositoryId = Number(req.body.repository_id)
  const repositories = await installationRepositories(connection.installation_id)
  const repository = repositories.find(item => item.id === repositoryId)
  if (!repository) return res.status(422).json({ error: 'Repository is not available to this installation' })
  const source = createSource(connection, repository)
  res.status(201).json(source)
}))

app.get('/api/sources/:id', (req, res) => {
  const source = getSource(req.params.id)
  return source ? res.json(source) : notFound(res, 'Source')
})

app.post('/api/sources/:id/disable', (req, res) => {
  const source = updateSourceState(req.params.id, 'Disabled', req.body.cause || 'Disabled by local user')
  return source ? res.json(source) : notFound(res, 'Source')
})

app.post('/api/sources/:id/enable', (req, res) => {
  const source = updateSourceState(req.params.id, 'Working', null)
  return source ? res.json(source) : notFound(res, 'Source')
})

app.post('/api/sources/:id/mark-broken', (req, res) => {
  const source = updateSourceState(req.params.id, 'Broken', req.body.cause || 'Marked broken by local user')
  return source ? res.json(source) : notFound(res, 'Source')
})

app.post('/api/sources/:id/restore', (req, res) => {
  const source = updateSourceState(req.params.id, 'Working', null)
  return source ? res.json(source) : notFound(res, 'Source')
})

app.post('/api/sources/:id/remove', (req, res) => {
  const source = getSource(req.params.id)
  if (!source) return notFound(res, 'Source')
  db().prepare("UPDATE sources SET status = 'Disabled', selection_state = 'Unselected', removed_at = ?, updated_at = ?, failure_cause = 'Removed from listening' WHERE id = ?")
    .run(now(), now(), source.id)
  transition('Source', source.id, source.status, 'Disabled', 'Removed from listening', 'local user')
  res.json(getSource(source.id))
})

app.post('/api/sources/:id/refresh', asyncRoute(async (req, res) => {
  const source = getSource(req.params.id)
  if (!source) return notFound(res, 'Source')
  try {
    const repository = await repositoryDetails(source.installation_id, source.owner, source.name)
    const timestamp = now()
    db().prepare(`UPDATE sources SET repository_node_id = ?, owner = ?, name = ?, full_name = ?, visibility = ?,
      reach_status = 'Reachable', failure_cause = NULL, updated_at = ? WHERE id = ?`)
      .run(repository.node_id, repository.owner.login, repository.name, repository.full_name,
        repository.visibility || (repository.private ? 'private' : 'public'), timestamp, source.id)
    res.json(getSource(source.id))
  } catch (error) {
    db().prepare("UPDATE sources SET reach_status = 'Unreachable', failure_cause = ?, updated_at = ? WHERE id = ?")
      .run(error.message, now(), source.id)
    throw error
  }
}))

app.get('/api/deliveries', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  res.json({ deliveries: db().prepare('SELECT * FROM deliveries ORDER BY received_at DESC LIMIT ?').all(limit) })
})

app.get('/api/deliveries/:id', (req, res) => {
  const delivery = db().prepare('SELECT * FROM deliveries WHERE id = ? OR delivery_id = ?').get(req.params.id, req.params.id)
  if (!delivery) return notFound(res, 'Delivery')
  delivery.processing_attempts = db().prepare('SELECT * FROM processing_attempts WHERE delivery_id = ? ORDER BY started_at').all(delivery.id)
  res.json(delivery)
})

app.post('/api/deliveries/:id/replay', localOnly, (req, res) => {
  const delivery = db().prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id)
  if (!delivery) return notFound(res, 'Delivery')
  if (!delivery.connection_id || !delivery.source_id) return res.status(422).json({ error: 'Delivery cannot be replayed without a Connection and Source' })
  db().prepare("UPDATE deliveries SET status = 'Replayed', failure_cause = NULL, replay_count = replay_count + 1, processed_at = NULL WHERE id = ?").run(delivery.id)
  res.json(db().prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id))
})

const diagnostics = express.Router()
diagnostics.use(localOnly)

diagnostics.post('/reset', (req, res) => {
  resetDatabase()
  res.json({ reset: true })
})

diagnostics.post('/worker/pause', (req, res) => {
  setDiagnostic('worker_paused', 'true')
  res.json(workerState())
})

diagnostics.post('/worker/resume', (req, res) => {
  setDiagnostic('worker_paused', 'false')
  res.json(workerState())
})

diagnostics.post('/worker/delay', (req, res) => {
  const delay = Math.max(0, Math.min(Number(req.body.delay_ms) || 0, 30000))
  setDiagnostic('processing_delay_ms', delay)
  res.json(workerState())
})

diagnostics.post('/worker/fail-next', (req, res) => {
  setDiagnostic('fail_next_delivery', 'true')
  res.json({ fail_next_delivery: true })
})

diagnostics.post('/clock/advance', (req, res) => {
  const milliseconds = Number(req.body.milliseconds) || (Number(req.body.minutes) || 0) * 60000
  setDiagnostic('clock_offset_ms', Number(diagnostic('clock_offset_ms', '0')) + milliseconds)
  res.json({ now: now(), offset_ms: Number(diagnostic('clock_offset_ms', '0')) })
})

diagnostics.post('/connections/:id/force-reauth', (req, res) => {
  const connection = getConnection(req.params.id)
  if (!connection) return notFound(res, 'Connection')
  db().prepare("UPDATE connections SET status = 'Reauth required', failure_cause = 'Forced by diagnostic control', updated_at = ? WHERE id = ?").run(now(), connection.id)
  db().prepare("UPDATE sources SET status = CASE WHEN status = 'Disabled' THEN status ELSE 'Reauth required' END, failure_cause = 'Connection requires reauthorization', updated_at = ? WHERE connection_id = ?")
    .run(now(), connection.id)
  transition('Connection', connection.id, connection.status, 'Reauth required', 'Forced by diagnostic control', 'diagnostics')
  res.json(getConnection(connection.id))
})

function seedFixture (kind = 'working') {
  const number = Date.now() % 1000000
  const connection = upsertConnection({
    id: 900000000 + number,
    account: { login: `fixture-${number}`, type: 'Organization' },
    repository_selection: 'selected',
    permissions: { metadata: 'read', issues: 'read', pull_requests: 'read' }
  })
  const source = createSource(connection, {
    id: 800000000 + number,
    node_id: `R_fixture_${number}`,
    owner: { login: connection.account_login },
    name: `connector-${kind}`,
    full_name: `${connection.account_login}/connector-${kind}`,
    visibility: 'private'
  })
  if (kind === 'broken') return updateSourceState(source.id, 'Broken', 'Seeded diagnostic failure', 'diagnostics')
  if (kind === 'disabled') return updateSourceState(source.id, 'Disabled', 'Seeded disabled Source', 'diagnostics')
  return source
}

diagnostics.post('/seed/connection', (req, res) => {
  const number = Date.now() % 1000000
  res.status(201).json(upsertConnection({
    id: 900000000 + number,
    account: { login: `fixture-${number}`, type: 'Organization' },
    repository_selection: 'selected',
    permissions: { metadata: 'read' }
  }))
})
diagnostics.post('/seed/source', (req, res) => res.status(201).json(seedFixture('working')))
diagnostics.post('/seed/broken-source', (req, res) => res.status(201).json(seedFixture('broken')))
diagnostics.post('/seed/disabled-source', (req, res) => res.status(201).json(seedFixture('disabled')))

diagnostics.get('/export', (req, res) => {
  res.json({
    exported_at: now(),
    connections: listConnections(),
    sources: listSources(),
    grants: db().prepare('SELECT id, installation_id, permission_summary, authorization_status, account_login, created_at, revoked_at, provenance FROM grants').all(),
    identities: db().prepare('SELECT * FROM identities').all(),
    deliveries: db().prepare('SELECT * FROM deliveries ORDER BY received_at DESC').all(),
    processing_attempts: db().prepare('SELECT * FROM processing_attempts ORDER BY started_at DESC').all(),
    health_transitions: db().prepare('SELECT * FROM health_transitions ORDER BY created_at DESC').all(),
    worker: workerState()
  })
})

app.use('/api/diagnostics', diagnostics)

app.get('/', (req, res) => {
  const connections = listConnections()
  const sources = listSources().filter(source => !source.removed_at)
  const deliveries = db().prepare('SELECT * FROM deliveries ORDER BY received_at DESC LIMIT 8').all()
  const body = `<div class="grid">
    <section class="card"><div class="metric">${connections.length}</div><p>Connections</p></section>
    <section class="card"><div class="metric">${sources.filter(source => source.status === 'Working').length}</div><p>Working Sources</p></section>
    <section class="card"><div class="metric">${sources.filter(source => source.status === 'Broken').length}</div><p>Broken Sources</p></section>
    <section class="card"><div class="metric">${deliveries.filter(delivery => delivery.status === 'Failed').length}</div><p>Recent failed deliveries</p></section>
  </div>
  ${!githubConfigured() ? '<div class="notice">GitHub App credentials are not configured. You can still use local fixtures with <code>TEST_MODE=true</code>.</div>' : ''}
  <div class="actions"><a class="button" href="/connections/new">Add GitHub</a><a class="button secondary" href="/events">Review event history</a></div>
  <h2>Recent activity</h2>${deliveryTable(deliveries)}`
  res.send(layout('Dashboard', body, config))
})

app.get('/connections', (req, res) => {
  const connections = listConnections()
  const rows = connections.map(connection => [
    `<a href="/connections/${escapeHtml(connection.id)}">${escapeHtml(connection.account_login)}</a>`,
    escapeHtml(connection.account_type), badge(connection.status), escapeHtml(connection.repository_selection),
    `${Number(connection.source_counts.working || 0)} working / ${Number(connection.source_counts.broken || 0)} broken`, fmt(connection.updated_at)
  ])
  res.send(layout('Connections', `<div class="actions"><a class="button" href="/connections/new">Add GitHub</a></div>${table(['Account', 'Type', 'Status', 'Repository scope', 'Sources', 'Updated'], rows, 'No Connections yet.')}`, config))
})

app.get('/connections/new', (req, res) => {
  const body = `${githubConfigured()
    ? '<div class="card"><h2>Install the GitHub App</h2><p>Choose a personal account or organization, then grant access to all or selected repositories. Credentials stay server-side.</p><a class="button" href="/api/github/install">Continue to GitHub</a></div>'
    : '<div class="notice error"><strong>Configuration required.</strong> Set <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, and <code>GITHUB_WEBHOOK_SECRET</code>, then restart the app.</div>'}`
  res.send(layout('Add GitHub', body, config))
})

app.get('/connections/:id', asyncRoute(async (req, res) => {
  const connection = getConnection(req.params.id)
  if (!connection) return res.status(404).send(layout('Connection not found', '<div class="empty">The requested Connection does not exist.</div>', config))
  let repositoryMarkup = '<div class="empty">Configure GitHub credentials to discover repositories.</div>'
  if (githubConfigured() && connection.status !== 'Disabled') {
    try {
      const selectedIds = new Set(connection.sources.filter(source => !source.removed_at).map(source => source.repository_id))
      const repositories = await installationRepositories(connection.installation_id)
      repositoryMarkup = table(['Repository', 'Visibility', 'Selection', 'Action'], repositories.map(repository => {
        const selected = selectedIds.has(repository.id)
        return [escapeHtml(repository.full_name), escapeHtml(repository.visibility || (repository.private ? 'private' : 'public')),
          selected ? badge('Selected') : badge('Unselected'),
          selected ? 'Already listening' : `<form data-api data-redirect="/connections/${escapeHtml(connection.id)}" method="post" action="/api/sources"><input type="hidden" name="connection_id" value="${escapeHtml(connection.id)}"><input type="hidden" name="repository_id" value="${repository.id}"><button>Select Source</button></form>`]
      }), 'No repositories are available to this installation.')
    } catch (error) {
      repositoryMarkup = `<div class="notice error">Repository discovery failed: ${escapeHtml(error.message)}</div>`
    }
  }
  const body = `${req.query.installed ? '<div class="notice">GitHub App installation recorded successfully.</div>' : ''}
  <section class="card"><dl><dt>Status</dt><dd>${badge(connection.status)}</dd><dt>Account</dt><dd>${escapeHtml(connection.account_login)} (${escapeHtml(connection.account_type)})</dd>
  <dt>Installation ID</dt><dd>${connection.installation_id}</dd><dt>Grant ID</dt><dd>${escapeHtml(connection.grant_id)}</dd><dt>Repository scope</dt><dd>${escapeHtml(connection.repository_selection)}</dd>
  <dt>Last provider interaction</dt><dd>${fmt(connection.last_provider_success_at)}</dd><dt>Failure cause</dt><dd>${escapeHtml(connection.failure_cause || '—')}</dd></dl></section>
  <div class="actions"><a class="button secondary" href="/api/github/install">Reauthorize on GitHub</a>${config.testMode ? `<form data-api method="post" action="/api/diagnostics/connections/${escapeHtml(connection.id)}/force-reauth"><button class="secondary">Force reauth state</button></form>` : ''}</div>
  <h2>Selected Sources</h2>${sourceTable(connection.sources)}<h2 style="margin-top:28px">Available repositories</h2>${repositoryMarkup}`
  res.send(layout(`Connection: ${connection.account_login}`, body, config))
}))

app.get('/sources/:id', (req, res) => {
  const source = getSource(req.params.id)
  if (!source) return res.status(404).send(layout('Source not found', '<div class="empty">The requested Source does not exist.</div>', config))
  const body = `<section class="card"><dl><dt>Status</dt><dd>${badge(source.status)}</dd><dt>Repository</dt><dd>${escapeHtml(source.full_name)}</dd><dt>Repository ID</dt><dd>${source.repository_id}</dd>
  <dt>Node ID</dt><dd>${escapeHtml(source.repository_node_id || '—')}</dd><dt>Visibility</dt><dd>${escapeHtml(source.visibility)}</dd><dt>Reach</dt><dd>${escapeHtml(source.reach_status)}</dd>
  <dt>Connection</dt><dd><a href="/connections/${escapeHtml(source.connection_id)}">${escapeHtml(source.connection.account_login)}</a></dd><dt>Failure cause</dt><dd>${escapeHtml(source.failure_cause || '—')}</dd>
  <dt>Last event received</dt><dd>${fmt(source.last_received_event_at)}</dd><dt>Last successful processing</dt><dd>${fmt(source.last_successful_processing_at)}</dd></dl></section>
  <div class="actions">
    ${source.status === 'Disabled' ? actionForm(source.id, 'enable', 'Re-enable Source') : actionForm(source.id, 'disable', 'Disable Source', 'secondary')}
    ${source.status === 'Broken' ? actionForm(source.id, 'restore', 'Restore Source') : actionForm(source.id, 'mark-broken', 'Mark broken', 'secondary')}
    ${actionForm(source.id, 'refresh', 'Refresh metadata', 'secondary')}${actionForm(source.id, 'remove', 'Remove from listening', 'danger')}
  </div><h2>Recent deliveries</h2>${deliveryTable(source.recent_deliveries)}
  <h2 style="margin-top:28px">Health transitions</h2>${table(['Status change', 'Cause', 'Actor', 'At'], source.health_transitions.map(item => [
    `${escapeHtml(item.from_status || 'New')} → ${escapeHtml(item.to_status)}`, escapeHtml(item.cause || '—'), escapeHtml(item.actor), fmt(item.created_at)
  ]), 'No health transitions recorded.')}`
  res.send(layout(`Source: ${source.full_name}`, body, config))
})

app.get('/events', (req, res) => {
  const deliveries = db().prepare('SELECT * FROM deliveries ORDER BY received_at DESC LIMIT 200').all()
  res.send(layout('Webhook delivery history', deliveryTable(deliveries, true), config))
})

app.get('/diagnostics', localOnly, (req, res) => {
  const connections = listConnections()
  const state = workerState()
  const controls = [
    ['Reset local database', '/api/diagnostics/reset', 'danger'], ['Seed Connection', '/api/diagnostics/seed/connection', ''],
    ['Seed working Source', '/api/diagnostics/seed/source', ''], ['Seed broken Source', '/api/diagnostics/seed/broken-source', 'secondary'],
    ['Seed disabled Source', '/api/diagnostics/seed/disabled-source', 'secondary'],
    [state.paused ? 'Resume worker' : 'Pause worker', state.paused ? '/api/diagnostics/worker/resume' : '/api/diagnostics/worker/pause', 'secondary'],
    ['Fail next delivery', '/api/diagnostics/worker/fail-next', 'secondary']
  ]
  const body = `<div class="notice">These controls are available only in local test mode. Diagnostic exports contain safe metadata, never application keys, tokens, webhook secrets, or full webhook payloads.</div>
  <section class="card"><dl><dt>Worker</dt><dd>${state.paused ? badge('Disabled') : badge('Active')}</dd><dt>Processing delay</dt><dd>${state.delay_ms} ms</dd><dt>Test clock</dt><dd>${fmt(now())}</dd><dt>Connections</dt><dd>${connections.length}</dd></dl></section>
  <div class="actions">${controls.map(([label, path, style]) => `<form data-api method="post" action="${path}"><button class="${style}">${label}</button></form>`).join('')}<a class="button secondary" href="/api/diagnostics/export">Export safe state</a></div>
  <div class="grid"><form class="card" data-api method="post" action="/api/diagnostics/worker/delay"><h2>Processing delay</h2><label for="delay_ms">Milliseconds (0–30000)</label><input id="delay_ms" name="delay_ms" type="number" min="0" max="30000" value="${state.delay_ms}"><button style="margin-top:12px">Apply delay</button></form>
  <form class="card" data-api method="post" action="/api/diagnostics/clock/advance"><h2>Advance test clock</h2><label for="minutes">Minutes</label><input id="minutes" name="minutes" type="number" value="60"><button style="margin-top:12px">Advance clock</button></form></div>`
  res.send(layout('Local diagnostics', body, config))
})

function actionForm (sourceId, action, label, style = '') {
  return `<form data-api method="post" action="/api/sources/${escapeHtml(sourceId)}/${action}"><button class="${style}">${label}</button></form>`
}

function sourceTable (sources) {
  return table(['Repository', 'Status', 'Reach', 'Last event', 'Last success'], sources.map(source => [
    `<a href="/sources/${escapeHtml(source.id)}">${escapeHtml(source.full_name)}</a>`, badge(source.status), escapeHtml(source.reach_status), fmt(source.last_received_event_at), fmt(source.last_successful_processing_at)
  ]), 'No Sources selected.')
}

function deliveryTable (deliveries, includeActions = false) {
  const headers = ['Event', 'Status', 'Source', 'Delivery ID', 'Received', 'Cause']
  if (includeActions && config.testMode) headers.push('Action')
  const rows = deliveries.map(delivery => {
    const row = [escapeHtml(`${delivery.event_name}${delivery.action ? `.${delivery.action}` : ''}`), badge(delivery.status),
      delivery.source_id ? `<a href="/sources/${escapeHtml(delivery.source_id)}">${escapeHtml(delivery.source_id)}</a>` : '—',
      `<code>${escapeHtml(delivery.delivery_id)}</code>`, fmt(delivery.received_at), escapeHtml(delivery.failure_cause || '—')]
    if (includeActions && config.testMode) row.push(delivery.source_id && delivery.connection_id ? `<form data-api method="post" action="/api/deliveries/${escapeHtml(delivery.id)}/replay"><button class="secondary">Replay</button></form>` : '—')
    return row
  })
  return table(headers, rows, 'No webhook deliveries received.')
}

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  res.status(404).send(layout('Not found', '<div class="empty">The requested page does not exist.</div>', config))
})

app.use((error, req, res, next) => {
  console.error(error)
  const status = error.status || error.statusCode || 500
  const message = status >= 500 ? 'Request failed' : error.message
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message, correlation_id: id('err') })
  res.status(status).send(layout('Request failed', `<div class="notice error">${escapeHtml(message)}</div>`, config))
})

app.listen(config.port, () => {
  console.log(`Connect & Listen is running at ${config.baseUrl}`)
  console.log(`Webhook endpoint: ${config.baseUrl}/api/github/webhooks`)
  if (config.testMode) console.log(`Local diagnostics: ${config.baseUrl}/diagnostics`)
})
