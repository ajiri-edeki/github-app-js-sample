import { App, Octokit } from 'octokit'
import { config, githubConfigured } from './config.js'

let githubApp

export function getGitHubApp () {
  if (!githubConfigured()) {
    const error = new Error('GitHub App configuration is incomplete')
    error.status = 503
    throw error
  }
  if (!githubApp) {
    githubApp = new App({
      appId: config.appId,
      privateKey: config.privateKey,
      webhooks: { secret: config.webhookSecret },
      ...(config.enterpriseHostname && {
        Octokit: Octokit.defaults({ baseUrl: `https://${config.enterpriseHostname}/api/v3` })
      })
    })
  }
  return githubApp
}

export async function installationUrl () {
  const app = getGitHubApp()
  const { data } = await app.octokit.request('GET /app')
  const host = config.enterpriseHostname ? `https://${config.enterpriseHostname}` : 'https://github.com'
  return `${host}/apps/${data.slug}/installations/new`
}

export async function installationDetails (installationId) {
  const app = getGitHubApp()
  const { data } = await app.octokit.request('GET /app/installations/{installation_id}', {
    installation_id: Number(installationId)
  })
  return data
}

export async function installationRepositories (installationId) {
  const octokit = await getGitHubApp().getInstallationOctokit(Number(installationId))
  return octokit.paginate('GET /installation/repositories', { per_page: 100 })
}

export async function repositoryDetails (installationId, owner, repo) {
  const octokit = await getGitHubApp().getInstallationOctokit(Number(installationId))
  const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })
  return data
}
