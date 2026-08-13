import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeChildProcess from 'node:child_process'

// Why: the probe spawns a real login shell, and `resolveRelayGrokHome` swallows every
// spawn failure into its fallback. Left unmocked this asserts the runner's scheduling
// latency, not the parser: on a loaded sharded CI box the 8s timeout expires and the
// first case silently flips to the fallback path.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, execFile: vi.fn() }
})

const { execFile } = await import('node:child_process')
const execFileMock = vi.mocked(execFile)
const { resolveRelayGrokHome } = await import('./managed-hook-runtime')

type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

function stubProbeOutput(stdout: string): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    ;(args.at(-1) as ExecFileCallback)(null, { stdout, stderr: '' })
    return undefined
  }) as unknown as typeof execFile)
}

function stubProbeFailure(error: Error): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    ;(args.at(-1) as ExecFileCallback)(error)
    return undefined
  }) as unknown as typeof execFile)
}

beforeEach(() => {
  execFileMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.runIf(process.platform !== 'win32')('resolveRelayGrokHome', () => {
  it('uses the login-shell GROK_HOME and normalizes trailing separators', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('/srv/grok///\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const [shell, args] = execFileMock.mock.calls[0] ?? []
    expect(shell).toBe('/bin/sh')
    // `sh`/`dash` reject `-lc`, so the mode choice is part of the contract under test.
    expect(args?.[0]).toBe('-c')
  })

  it('passes -lc to a login shell that supports it', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    stubProbeOutput('/srv/grok\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/srv/grok')

    const [shell, args] = execFileMock.mock.calls[0] ?? []
    expect(shell).toBe('/bin/zsh')
    expect(args?.[0]).toBe('-lc')
  })

  it('falls back when the login-shell GROK_HOME is not an absolute POSIX path', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeOutput('../relative\n')

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })

  // Why: this is the branch that made the old test flaky — pin it so a probe failure is
  // an asserted fallback rather than an invisible substitution for a real answer.
  it('falls back when the probe fails or times out', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    stubProbeFailure(Object.assign(new Error('spawn timed out'), { killed: true }))

    await expect(resolveRelayGrokHome('/home/orca')).resolves.toBe('/home/orca/.grok')
  })
})
