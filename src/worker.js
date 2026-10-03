import { db, diagnostic, id, now, setDiagnostic, transition } from './db.js'

let timer
let working = false

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function processOne () {
  if (working || diagnostic('worker_paused') === 'true') return
  const delivery = db().prepare("SELECT * FROM deliveries WHERE status IN ('Queued','Replayed') ORDER BY received_at LIMIT 1").get()
  if (!delivery) return
  working = true
  const attemptNumber = delivery.retry_count + delivery.replay_count + 1
  const attemptId = id('att')
  db().prepare(`INSERT INTO processing_attempts
    (id, delivery_id, attempt_number, status, started_at) VALUES (?, ?, ?, 'Processing', ?)`)
    .run(attemptId, delivery.id, attemptNumber, now())
  db().prepare("UPDATE deliveries SET status = 'Processing' WHERE id = ?").run(delivery.id)
  try {
    const delay = Math.min(Number(diagnostic('processing_delay_ms', '0')) || 0, 30000)
    if (delay) await sleep(delay)
    const connection = delivery.connection_id && db().prepare('SELECT * FROM connections WHERE id = ?').get(delivery.connection_id)
    const source = delivery.source_id && db().prepare('SELECT * FROM sources WHERE id = ?').get(delivery.source_id)
    if (!connection || connection.status !== 'Active') throw new Error('Connection is unavailable or requires reauthorization')
    if (!source || source.removed_at) throw new Error('No active Source matches this repository')
    if (source.status === 'Disabled') {
      db().prepare("UPDATE deliveries SET status = 'Filtered', failure_cause = ?, processed_at = ? WHERE id = ?")
        .run('Source is disabled', now(), delivery.id)
      db().prepare("UPDATE processing_attempts SET status = 'Filtered', completed_at = ? WHERE id = ?").run(now(), attemptId)
      return
    }
    if (diagnostic('fail_next_delivery') === 'true') {
      setDiagnostic('fail_next_delivery', 'false')
      throw new Error('Failure injected by local diagnostic control')
    }
    const timestamp = now()
    db().transaction(() => {
      db().prepare("UPDATE deliveries SET status = 'Accepted', failure_cause = NULL, processed_at = ? WHERE id = ?").run(timestamp, delivery.id)
      db().prepare("UPDATE processing_attempts SET status = 'Accepted', completed_at = ? WHERE id = ?").run(timestamp, attemptId)
      db().prepare(`UPDATE sources SET last_successful_processing_at = ?, updated_at = ?,
        status = CASE WHEN status = 'Broken' THEN 'Working' ELSE status END,
        failure_cause = CASE WHEN status = 'Broken' THEN NULL ELSE failure_cause END WHERE id = ?`)
        .run(timestamp, timestamp, source.id)
    })()
    if (source.status === 'Broken') transition('Source', source.id, 'Broken', 'Working', 'Successful delivery processing', 'worker')
  } catch (error) {
    const timestamp = now()
    db().transaction(() => {
      db().prepare("UPDATE deliveries SET status = 'Failed', failure_cause = ?, retry_count = retry_count + 1, processed_at = ? WHERE id = ?")
        .run(error.message, timestamp, delivery.id)
      db().prepare("UPDATE processing_attempts SET status = 'Failed', failure_cause = ?, completed_at = ? WHERE id = ?")
        .run(error.message, timestamp, attemptId)
      if (delivery.source_id) {
        const source = db().prepare('SELECT status FROM sources WHERE id = ?').get(delivery.source_id)
        db().prepare("UPDATE sources SET status = CASE WHEN status = 'Disabled' THEN status ELSE 'Broken' END, failure_cause = ?, updated_at = ? WHERE id = ?")
          .run(error.message, timestamp, delivery.source_id)
        if (source && source.status !== 'Disabled' && source.status !== 'Broken') transition('Source', delivery.source_id, source.status, 'Broken', error.message, 'worker')
      }
    })()
  } finally {
    working = false
  }
}

export function startWorker () {
  if (!timer) timer = setInterval(() => processOne().catch(console.error), 500)
  timer.unref()
}

export function stopWorker () {
  clearInterval(timer)
  timer = undefined
}

export function workerState () {
  return { paused: diagnostic('worker_paused') === 'true', working, delay_ms: Number(diagnostic('processing_delay_ms', '0')) }
}
