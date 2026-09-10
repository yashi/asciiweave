import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const commit = '857733cd9abccf5694814706e6a9b020c1c6187f'
const healthy = JSON.stringify({ ok: true, commit })
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function check(responses: { body: string; status?: number }[], access = false) {
  const directory = mkdtempSync(join(tmpdir(), 'asciiweave-smoke-'))
  directories.push(directory)
  writeFileSync(join(directory, 'responses.json'), JSON.stringify(responses))
  writeFileSync(join(directory, 'attempts.json'), '[]')
  writeFileSync(join(directory, 'summary'), '')
  writeFileSync(
    join(directory, 'curl'),
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(process.env.SMOKE_FIXTURE, 'attempts.json')
const attempts = JSON.parse(fs.readFileSync(file, 'utf8'))
const responses = JSON.parse(fs.readFileSync(path.join(process.env.SMOKE_FIXTURE, 'responses.json'), 'utf8'))
const response = responses[Math.min(attempts.length, responses.length - 1)]
attempts.push(process.argv.slice(2))
fs.writeFileSync(file, JSON.stringify(attempts))
process.stdout.write(response.body)
process.exit(response.status ?? 0)
`,
    { mode: 0o755 },
  )
  writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  })
  const result = spawnSync('bash', [resolve('.github/scripts/deployment-smoke.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SMOKE_FIXTURE: directory,
      SMOKE_TEST_URL: access ? 'https://production.example' : '',
      DEPLOYMENT_URL: 'https://staging.example',
      SMOKE_TEST_ACCESS: String(access),
      ACCESS_ID: 'test-client',
      ACCESS_SECRET: 'test-secret',
      DEPLOYED_COMMIT: commit,
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    },
  })
  return {
    ...result,
    attempts: JSON.parse(readFileSync(join(directory, 'attempts.json'), 'utf8')) as string[][],
    summary: readFileSync(join(directory, 'summary'), 'utf8'),
  }
}

describe('deployment health check', () => {
  it('waits for the deployed commit after a healthy previous version', () => {
    const result = check([{ body: '{"ok":true,"commit":"previous"}' }, { body: healthy }], true)
    expect(result.status).toBe(0)
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]).toContain('https://production.example/api/health')
    expect(result.attempts[0]).toContain('CF-Access-Client-Id: test-client')
    expect(result.attempts[0]).toContain('CF-Access-Client-Secret: test-secret')
    expect(result.summary).toContain(`Deployed commit ${commit} to https://production.example`)
  })

  it('uses the staging deployment URL without Access headers', () => {
    const result = check([{ body: healthy }])
    expect(result.status).toBe(0)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toContain('https://staging.example/api/health')
    expect(result.attempts[0]).not.toContain('-H')
  })

  it('retries transport failures and invalid health responses', () => {
    const result = check([
      { body: '', status: 22 },
      { body: '<html>Access login</html>' },
      { body: healthy },
    ])
    expect(result.status).toBe(0)
    expect(result.attempts).toHaveLength(3)
  })

  it.each([
    '{"ok":true,"commit":"previous"}',
    JSON.stringify({ ok: false, commit }),
    JSON.stringify({ ok: true, commit: `${commit}-other` }),
    '',
  ])('fails after ten unconfirmed responses: %s', (body) => {
    const result = check([{ body }])
    expect(result.status).toBe(1)
    expect(result.attempts).toHaveLength(10)
    expect(result.summary).toBe('')
    expect(result.stdout).toContain('::error::Health check did not confirm commit')
  })
})
