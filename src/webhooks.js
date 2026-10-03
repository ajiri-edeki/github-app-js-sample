import crypto from 'node:crypto'
import express from 'express'
import { config } from './config.js'
import { db, id, now } from './db.js'
import { recordIdentity } from './models.js'

export const supportedRepositoryEvents = new Set([
  'issues', 'issue_comment', 'sub_issues', 'issue_dependencies', 'pull_request', 'pull_request_review',
  'pull_request_review_comment', 'pull_request_review_thread', 'discussion', 'discussion_comment', 'release',
  'milestone', 'push', 'create', 'delete', 'commit_comment', 'gollum', 'fork', 'public'
])

function validSignature (body, signature) {
  if (!config.webhookSecret || !signature?.startsWith('sha256=')) return false
  const expected = `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`
  const left = Buffer.from(expected)
  const right = Buffer.from(signature)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function lifecycleEvent (eventName, action, payload, connection) {
  if (!connection) return
  const timestamp = now()
  if (eventName === 'installation' && ['deleted', 'suspend'].includes(action)) {
    db().prepare("UPDATE connections SET status = 'Disabled', failure_cause = ?, updated_at = ? WHERE id = ?")
      .run(`GitHub installation ${action}`, timestamp, connection.id)
    db().prepare("UPDATE sources SET reach_status = 'Unreachable', failure_cause = ?, updated_at = ? WHERE connection_id = ?")
      .run(`GitHub installation ${action}`, timestamp, connection.id)
  }
  if (eventName === 'installation' && action === 'unsuspend') {
    db().prepare("UPDATE connections SET status = 'Active', failure_cause = NULL, updated_at = ?, last_provider_success_at = ? WHERE id = ?")
      .run(timestamp, timestamp, connection.id)
  }
  if (eventName === 'installation_repositories') {
    for (const repository of payload.repositories_removed || []) {
      db().prepare("UPDATE sources SET reach_status = 'Removed', selection_state = 'Removed', failure_cause = 'Repository removed from GitHub App installation', updated_at = ? WHERE repository_id = ?")
        .run(timestamp, repository.id)
    }
  }
  if (eventName === 'repository' && payload.repository) {
    const repository = payload.repository
    db().prepare(`UPDATE sources SET owner = ?, name = ?, full_name = ?, repository_node_id = ?, visibility = ?,
      updated_at = ?, reach_status = CASE WHEN ? = 'deleted' THEN 'Removed' ELSE 'Reachable' END,
      failure_cause = CASE WHEN ? = 'deleted' THEN 'Repository deleted' ELSE NULL END WHERE repository_id = ?`)
      .run(repository.owner.login, repository.name, repository.full_name, repository.node_id || null,
        repository.visibility || (repository.private ? 'private' : 'public'), timestamp, action, action, repository.id)
  }
}

export const webhookBodyParser = express.raw({ type: 'application/json', limit: '2mb' })

export function receiveWebhook (req, res) {
  const signature = req.get('x-hub-signature-256')
  const deliveryId = req.get('x-github-delivery')
  const eventName = req.get('x-github-event')
  if (!validSignature(req.body, signature)) return res.status(401).json({ error: 'Invalid webhook signature' })
  if (!deliveryId || !eventName) return res.status(400).json({ error: 'Missing GitHub delivery headers' })
  const duplicate = db().prepare('SELECT id, status FROM deliveries WHERE delivery_id = ?').get(deliveryId)
  if (duplicate) return res.status(200).json({ duplicate: true, delivery: duplicate })
  let payload
  try {
    payload = JSON.parse(req.body.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' })
  }
  const installationId = payload.installation?.id || null
  const repositoryId = payload.repository?.id || null
  const connection = installationId && db().prepare('SELECT * FROM connections WHERE installation_id = ?').get(installationId)
  const source = repositoryId && db().prepare('SELECT * FROM sources WHERE repository_id = ? AND removed_at IS NULL').get(repositoryId)
  const action = payload.action || null
  const supported = supportedRepositoryEvents.has(eventName)
  const lifecycle = ['installation', 'installation_repositories', 'repository'].includes(eventName)
  let status = supported ? 'Queued' : 'Filtered'
  let failureCause = null
  if (supported && !connection) {
    status = 'Filtered'
    failureCause = 'No Connection matches the installation'
  } else if (supported && !source) {
    status = 'Filtered'
    failureCause = 'No Source matches the repository'
  } else if (!supported) {
    failureCause = lifecycle ? 'Lifecycle event handled outside Source activity' : 'Unsupported or out-of-scope event'
  }
  const record = {
    id: id('del'),
    delivery_id: deliveryId,
    event_name: eventName,
    action,
    installation_id: installationId,
    repository_id: repositoryId,
    connection_id: connection?.id || null,
    source_id: source?.id || null,
    status,
    failure_cause: failureCause,
    correlation_id: req.get('x-request-id') || id('corr'),
    received_at: now()
  }
  db().prepare(`INSERT INTO deliveries
    (id, delivery_id, event_name, action, installation_id, repository_id, connection_id, source_id,
      status, failure_cause, correlation_id, received_at)
    VALUES (@id, @delivery_id, @event_name, @action, @installation_id, @repository_id, @connection_id, @source_id,
      @status, @failure_cause, @correlation_id, @received_at)`).run(record)
  if (source) db().prepare('UPDATE sources SET last_received_event_at = ?, updated_at = ? WHERE id = ?').run(record.received_at, record.received_at, source.id)
  recordIdentity(connection?.id, payload.sender)
  if (lifecycle) lifecycleEvent(eventName, action, payload, connection)
  return res.status(status === 'Queued' ? 202 : 200).json({ id: record.id, status, correlation_id: record.correlation_id })
}
