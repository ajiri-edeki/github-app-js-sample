import path from 'node:path'
import process from 'node:process'

function bool (value) {
  return String(value).toLowerCase() === 'true'
}

function privateKey () {
  return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') || ''
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  appId: process.env.GITHUB_APP_ID || '',
  privateKey: privateKey(),
  clientId: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/connect-listen.sqlite'),
  testMode: bool(process.env.TEST_MODE),
  webhookProxyUrl: process.env.WEBHOOK_PROXY_URL || '',
  enterpriseHostname: process.env.ENTERPRISE_HOSTNAME || ''
}

export function githubConfigured () {
  return Boolean(config.appId && config.privateKey && config.webhookSecret)
}
