import { db, id, now, transition } from './db.js'

export function connectionHealth (connection) {
  const counts = db().prepare(`SELECT
    SUM(CASE WHEN status = 'Working' THEN 1 ELSE 0 END) AS working,
    SUM(CASE WHEN status = 'Broken' THEN 1 ELSE 0 END) AS broken,
    SUM(CASE WHEN status = 'Disabled' THEN 1 ELSE 0 END) AS disabled,
    SUM(CASE WHEN status = 'Reauth required' THEN 1 ELSE 0 END) AS reauth
    FROM sources WHERE connection_id = ? AND removed_at IS NULL`).get(connection.id)
  const delivery = db().prepare(`SELECT
    MAX(CASE WHEN status = 'Accepted' THEN processed_at END) AS last_successful_delivery,
    MAX(CASE WHEN status = 'Failed' THEN processed_at END) AS last_failed_delivery
    FROM deliveries WHERE connection_id = ?`).get(connection.id)
  return { ...connection, source_counts: counts, ...delivery }
}

export function listConnections () {
  return db().prepare('SELECT * FROM connections ORDER BY updated_at DESC').all().map(connectionHealth)
}

export function getConnection (connectionId) {
  const row = db().prepare('SELECT * FROM connections WHERE id = ?').get(connectionId)
  if (!row) return null
  return {
    ...connectionHealth(row),
    grant: db().prepare('SELECT * FROM grants WHERE id = ?').get(row.grant_id),
    sources: db().prepare('SELECT * FROM sources WHERE connection_id = ? ORDER BY full_name').all(row.id),
    identities: db().prepare('SELECT * FROM identities WHERE connection_id = ? ORDER BY login').all(row.id)
  }
}

export function upsertConnection (installation) {
  const timestamp = now()
  const existing = db().prepare('SELECT * FROM connections WHERE installation_id = ?').get(installation.id)
  const account = installation.account || {}
  let grant = db().prepare('SELECT * FROM grants WHERE installation_id = ?').get(installation.id)
  if (!grant) {
    grant = {
      id: id('gr'),
      installation_id: installation.id,
      permission_summary: JSON.stringify(installation.permissions || {}),
      authorization_status: 'Authorized',
      account_login: account.login || 'unknown',
      created_at: timestamp,
      provenance: 'GitHub App installation callback'
    }
    db().prepare(`INSERT INTO grants
      (id, installation_id, permission_summary, authorization_status, account_login, created_at, provenance)
      VALUES (@id, @installation_id, @permission_summary, @authorization_status, @account_login, @created_at, @provenance)`).run(grant)
  } else {
    db().prepare(`UPDATE grants SET permission_summary = ?, authorization_status = 'Authorized',
      account_login = ?, revoked_at = NULL WHERE id = ?`)
      .run(JSON.stringify(installation.permissions || {}), account.login || 'unknown', grant.id)
  }
  if (existing) {
    db().prepare(`UPDATE connections SET account_login = ?, account_type = ?, repository_selection = ?,
      grant_id = ?, status = 'Active', failure_cause = NULL, updated_at = ?, last_provider_success_at = ? WHERE id = ?`)
      .run(account.login || 'unknown', account.type || 'Unknown', installation.repository_selection || 'selected', grant.id, timestamp, timestamp, existing.id)
    if (existing.status !== 'Active') transition('Connection', existing.id, existing.status, 'Active', 'GitHub App installation refreshed')
    return getConnection(existing.id)
  }
  const connectionId = id('cn')
  db().prepare(`INSERT INTO connections
    (id, installation_id, account_login, account_type, repository_selection, grant_id, status, created_at, updated_at, last_provider_success_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`)
    .run(connectionId, installation.id, account.login || 'unknown', account.type || 'Unknown', installation.repository_selection || 'selected', grant.id, timestamp, timestamp, timestamp)
  transition('Connection', connectionId, null, 'Active', 'GitHub App installed')
  return getConnection(connectionId)
}

export function listSources (connectionId) {
  if (connectionId) return db().prepare('SELECT * FROM sources WHERE connection_id = ? ORDER BY full_name').all(connectionId)
  return db().prepare('SELECT * FROM sources ORDER BY updated_at DESC').all()
}

export function getSource (sourceId) {
  const source = db().prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) return null
  return {
    ...source,
    connection: db().prepare('SELECT id, installation_id, account_login, account_type, status FROM connections WHERE id = ?').get(source.connection_id),
    recent_deliveries: db().prepare('SELECT * FROM deliveries WHERE source_id = ? ORDER BY received_at DESC LIMIT 25').all(source.id),
    health_transitions: db().prepare("SELECT * FROM health_transitions WHERE entity_type = 'Source' AND entity_id = ? ORDER BY created_at DESC LIMIT 25").all(source.id)
  }
}

export function createSource (connection, repository) {
  const existing = db().prepare('SELECT * FROM sources WHERE repository_id = ?').get(repository.id)
  const timestamp = now()
  if (existing) {
    db().prepare(`UPDATE sources SET connection_id = ?, installation_id = ?, repository_node_id = ?, owner = ?, name = ?,
      full_name = ?, visibility = ?, selection_state = 'Selected', reach_status = 'Reachable', removed_at = NULL, updated_at = ? WHERE id = ?`)
      .run(connection.id, connection.installation_id, repository.node_id || null, repository.owner.login, repository.name, repository.full_name,
        repository.visibility || (repository.private ? 'private' : 'public'), timestamp, existing.id)
    return getSource(existing.id)
  }
  const sourceId = id('src')
  db().prepare(`INSERT INTO sources
    (id, connection_id, installation_id, repository_id, repository_node_id, owner, name, full_name, visibility,
      selection_state, reach_status, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Selected', 'Reachable', 'Working', ?, ?)`)
    .run(sourceId, connection.id, connection.installation_id, repository.id, repository.node_id || null, repository.owner.login,
      repository.name, repository.full_name, repository.visibility || (repository.private ? 'private' : 'public'), timestamp, timestamp)
  transition('Source', sourceId, null, 'Working', 'Repository selected')
  return getSource(sourceId)
}

export function updateSourceState (sourceId, status, cause, actor = 'local user') {
  const source = db().prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
  if (!source) return null
  db().prepare('UPDATE sources SET status = ?, failure_cause = ?, updated_at = ? WHERE id = ?')
    .run(status, cause || null, now(), sourceId)
  if (source.status !== status || source.failure_cause !== cause) transition('Source', sourceId, source.status, status, cause, actor)
  return getSource(sourceId)
}

export function recordIdentity (connectionId, sender) {
  if (!sender?.id || !sender?.login || !connectionId) return
  const timestamp = now()
  const existing = db().prepare('SELECT id FROM identities WHERE github_user_id = ? AND connection_id = ?').get(sender.id, connectionId)
  if (existing) {
    db().prepare("UPDATE identities SET login = ?, reach_status = 'Reachable', freshness_status = 'Current', updated_at = ? WHERE id = ?")
      .run(sender.login, timestamp, existing.id)
  } else {
    db().prepare(`INSERT INTO identities
      (id, github_user_id, login, connection_id, reach_status, freshness_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Reachable', 'Current', ?, ?)`)
      .run(id('idn'), sender.id, sender.login, connectionId, timestamp, timestamp)
  }
}
