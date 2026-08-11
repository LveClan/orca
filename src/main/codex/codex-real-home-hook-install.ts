import { join } from 'node:path'
import { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-hook-trust-grant'
import {
  createCodexWslRuntimeHookInstallPlan,
  getCodexManagedHookInstallMaterial,
  getCodexWslManagedHookInstallMaterial,
  type CodexManagedHookInstallMaterial
} from './hook-service'
import { getSystemCodexHomePath } from './codex-home-paths'
import type { CodexTrustGrantHost } from './codex-trust-grant-host'
import type {
  CodexWslRuntimeHookTarget,
  WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'
import { installRealHomeCodexHook, sweepRealHomeCodexHook } from './codex-real-home-hook-mutation'

/**
 * Real-home Codex hook lane for the system-default selection.
 *
 * - 'pending': no attempt yet this process; routing may optimistically use the
 *   real home (reads are hook-free and the install runs before pane spawns).
 * - 'installed': entry appended LAST in ~/.codex/hooks.json and trusted by
 *   codex itself through the app-server grant client.
 * - 'unavailable': the grant lane could not trust the entry (old binary,
 *   unsupported RPC, verify failure). The entry is rolled back.
 * - 'removed': hooks are opted out; Orca entries are swept from the real home.
 */
export type RealHomeCodexHookLane = 'pending' | 'installed' | 'unavailable' | 'removed'

export type RealHomeCodexHookTarget = CodexWslRuntimeHookTarget & {
  runtime: 'wsl'
  wslDistro: string
  runtimeHomePath: string
}

export type RealHomeCodexHookContext = {
  key: string
  runtimeHomePath: string
  hooksJsonPath: string
  tomlPath: string
  trustSourcePath: string
  host: CodexTrustGrantHost
  useDefaultCodexHome: boolean
  material: CodexManagedHookInstallMaterial
}

const laneByTarget = new Map<string, RealHomeCodexHookLane>()
const installRetryAfterByTarget = new Map<string, number>()
const knownWslTargets = new Map<string, RealHomeCodexHookTarget>()
const reconciliationGenerationByTarget = new Map<string, number>()

function getTargetKey(target?: Pick<RealHomeCodexHookTarget, 'runtime' | 'wslDistro'>): string {
  return target?.runtime === 'wsl' ? `wsl:${target.wslDistro}` : 'host'
}

export function getRealHomeCodexHookLane(
  target?: Pick<RealHomeCodexHookTarget, 'runtime' | 'wslDistro'>
): RealHomeCodexHookLane {
  return laneByTarget.get(getTargetKey(target)) ?? 'pending'
}

/**
 * Host routing gate consumed by CodexRuntimeHomeService. WSL keeps real-home
 * routing even when status hook trust is unavailable.
 */
export function isRealHomeCodexHookLaneUsable(
  target?: Pick<RealHomeCodexHookTarget, 'runtime' | 'wslDistro'>
): boolean {
  return getRealHomeCodexHookLane(target) !== 'unavailable'
}

function resolveRealHomeHookContext(
  target?: RealHomeCodexHookTarget,
  onCanonicalPathSettled?: (settlement: WslCanonicalPathSettlement) => void
): RealHomeCodexHookContext {
  if (target?.runtime === 'wsl') {
    const plan = createCodexWslRuntimeHookInstallPlan(
      target.runtimeHomePath,
      target,
      undefined,
      onCanonicalPathSettled
    )
    if (!plan) {
      throw new Error('Could not resolve the WSL Codex real-home hook paths')
    }
    const material = getCodexWslManagedHookInstallMaterial(plan)
    return {
      key: getTargetKey(target),
      runtimeHomePath: target.runtimeHomePath,
      hooksJsonPath: join(target.runtimeHomePath, 'hooks.json'),
      tomlPath: join(target.runtimeHomePath, 'config.toml'),
      trustSourcePath: plan.trustConfigPath,
      host: { kind: 'wsl', distro: plan.wslDistro, linuxRuntimeHome: plan.linuxRuntimeHome },
      useDefaultCodexHome: false,
      material: {
        ...material,
        scriptPath: join(target.runtimeHomePath, '.orca', 'agent-hooks', 'codex-hook.sh')
      }
    }
  }
  const runtimeHomePath = getSystemCodexHomePath()
  return {
    key: 'host',
    runtimeHomePath,
    hooksJsonPath: join(runtimeHomePath, 'hooks.json'),
    tomlPath: join(runtimeHomePath, 'config.toml'),
    trustSourcePath: join(runtimeHomePath, 'hooks.json'),
    host: { kind: 'native' },
    useDefaultCodexHome: true,
    material: getCodexManagedHookInstallMaterial()
  }
}

/**
 * Ensures the real-home hook state matches the settings: installs and trusts
 * the Orca status hook when enabled, sweeps it when opted out. Idempotent and
 * synchronous (launch prep); repeat calls are cheap — an unchanged hooks.json
 * write no-ops and a valid grant ledger skips the RPC session entirely.
 * Never throws: failures mark the hook lane unavailable; host may fall back.
 */
export function ensureRealHomeCodexHookState(args: {
  hooksEnabled: boolean
  userDataPath: string
  target?: RealHomeCodexHookTarget
}): RealHomeCodexHookLane {
  const key = getTargetKey(args.target)
  const reconciliationGeneration = args.target
    ? (reconciliationGenerationByTarget.get(key) ?? 0) + 1
    : 0
  if (args.target) {
    knownWslTargets.set(key, args.target)
    reconciliationGenerationByTarget.set(key, reconciliationGeneration)
  }
  // Why: the grant client caches failed probes, but mutating and rolling back
  // hooks.json before consulting it still adds synchronous work to every pane.
  const currentLane = getRealHomeCodexHookLane(args.target)
  if (
    args.hooksEnabled &&
    currentLane === 'unavailable' &&
    Date.now() < (installRetryAfterByTarget.get(key) ?? 0)
  ) {
    return currentLane
  }
  try {
    let installedTrustSourcePath: string | null = null
    const onCanonicalPathSettled =
      args.hooksEnabled && args.target
        ? (settlement: WslCanonicalPathSettlement): void => {
            if (
              settlement.status !== 'resolved' ||
              reconciliationGenerationByTarget.get(key) !== reconciliationGeneration
            ) {
              return
            }
            const resolvedPlan = createCodexWslRuntimeHookInstallPlan(
              args.target!.runtimeHomePath,
              args.target,
              () => settlement.canonicalPath
            )
            if (!resolvedPlan || resolvedPlan.trustConfigPath === installedTrustSourcePath) {
              return
            }
            // Why: Codex canonicalizes WSL hook sources. Reinstall once the
            // guest resolves a symlink so the trust key matches what Codex reads.
            installRetryAfterByTarget.delete(key)
            ensureRealHomeCodexHookState(args)
          }
        : undefined
    const context = resolveRealHomeHookContext(args.target, onCanonicalPathSettled)
    installedTrustSourcePath = context.trustSourcePath
    const mutation = args.hooksEnabled
      ? installRealHomeCodexHook(args.userDataPath, context)
      : { lane: sweepRealHomeCodexHook(context) }
    const nextLane = mutation.lane
    laneByTarget.set(key, nextLane)
    if (mutation.retryAfterMs !== undefined) {
      installRetryAfterByTarget.set(key, mutation.retryAfterMs)
    } else if (!args.hooksEnabled || nextLane === 'installed') {
      installRetryAfterByTarget.delete(key)
    }
  } catch (error) {
    console.warn('[codex-real-home-hooks] ensure failed; hook lane unavailable:', error)
    laneByTarget.set(key, 'unavailable')
    if (args.hooksEnabled) {
      installRetryAfterByTarget.set(key, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
    }
  }
  return getRealHomeCodexHookLane(args.target)
}

export function sweepKnownWslRealHomeCodexHooks(userDataPath: string): void {
  for (const target of knownWslTargets.values()) {
    ensureRealHomeCodexHookState({ hooksEnabled: false, userDataPath, target })
  }
}

export const _internals = {
  setLaneForTesting(
    lane: RealHomeCodexHookLane,
    target?: Pick<RealHomeCodexHookTarget, 'runtime' | 'wslDistro'>
  ): void {
    const key = getTargetKey(target)
    laneByTarget.set(key, lane)
    installRetryAfterByTarget.delete(key)
  },
  resetForTesting(): void {
    laneByTarget.clear()
    installRetryAfterByTarget.clear()
    knownWslTargets.clear()
    reconciliationGenerationByTarget.clear()
  }
}
