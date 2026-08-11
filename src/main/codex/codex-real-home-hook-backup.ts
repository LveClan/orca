import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { RealHomeCodexHookContext } from './codex-real-home-hook-install'

export function backupRealHomeHooksJsonOnce(
  userDataPath: string,
  context: RealHomeCodexHookContext,
  previousRaw: string | null
): void {
  if (previousRaw === null) {
    return
  }
  const backupDir = getRealHomeHookStateDir(userDataPath, context)
  const backupPath = join(backupDir, 'hooks.json.pre-orca')
  if (existsSync(backupPath)) {
    return
  }
  mkdirSync(backupDir, { recursive: true })
  writeFileAtomically(backupPath, previousRaw, { mode: 0o600 })
}

export function restoreRealHomeHooksJson(
  hooksJsonPath: string,
  previousRaw: string | null,
  previousMode?: number
): void {
  if (previousRaw === null) {
    if (existsSync(hooksJsonPath)) {
      unlinkSync(hooksJsonPath)
    }
    return
  }
  writeFileAtomically(hooksJsonPath, previousRaw, { mode: previousMode })
}

function getRealHomeHookStateDir(userDataPath: string, context: RealHomeCodexHookContext): string {
  if (context.key === 'host') {
    return join(userDataPath, 'codex-real-home-hooks')
  }
  return join(
    userDataPath,
    'codex-real-home-hooks',
    `wsl-${Buffer.from(context.key.slice('wsl:'.length), 'utf-8').toString('hex')}`
  )
}
