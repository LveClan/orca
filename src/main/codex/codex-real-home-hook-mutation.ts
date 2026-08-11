import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJsonWithRaw,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import {
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  grantManagedCodexHookTrust,
  type CodexTrustGrantFallbackReason
} from './codex-hook-trust-grant'
import {
  removeCodexManagedHookTrustEntries,
  removeStaleWslCodexManagedHookTrustEntries
} from './codex-managed-trust-reconciliation'
import { buildCodexWslManagedHookCommand } from './hook-service'
import type { CodexTrustEntry } from './config-toml-trust'
import { restoreCodexTrustConfig } from './codex-trust-config-rollback'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'
import {
  backupRealHomeHooksJsonOnce,
  restoreRealHomeHooksJson
} from './codex-real-home-hook-backup'
import type {
  RealHomeCodexHookContext,
  RealHomeCodexHookLane
} from './codex-real-home-hook-install'

export type RealHomeCodexHookMutationResult = {
  lane: RealHomeCodexHookLane
  retryAfterMs?: number
}

function assertHooksJsonGeneration(
  hooksJsonPath: string,
  hooksWritePath: string,
  expectedRaw: string | null
): void {
  const currentRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf-8') : null
  if (currentRaw !== expectedRaw || resolveHooksJsonWritePath(hooksJsonPath) !== hooksWritePath) {
    throw new Error('Codex hooks.json changed while Orca prepared its trust repair')
  }
}

export function installRealHomeCodexHook(
  userDataPath: string,
  context: RealHomeCodexHookContext
): RealHomeCodexHookMutationResult {
  const { material, hooksJsonPath } = context
  mkdirSync(context.runtimeHomePath, { recursive: true })
  const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (!config) {
    console.warn('[codex-real-home-hooks] could not parse', hooksJsonPath, '- hook install skipped')
    return {
      lane: 'unavailable',
      retryAfterMs: Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    }
  }
  if (Object.keys(config).some((key) => key !== 'hooks')) {
    return {
      lane: 'unavailable',
      retryAfterMs: Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
    }
  }

  writeManagedScript(material.scriptPath, material.script)

  const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName(context))
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  const managedEntries: CodexTrustEntry[] = []
  for (const eventName of material.events) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const reconciled = reconcileManagedHookDefinition(current, isManagedCommand, material.command)
    nextHooks[eventName] = reconciled.definitions
    managedEntries.push({
      sourcePath: context.trustSourcePath,
      eventLabel: material.eventLabel[eventName],
      groupIndex: reconciled.groupIndex,
      handlerIndex: reconciled.handlerIndex,
      command: material.command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  }
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if ((material.events as readonly string[]).includes(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  const previousMode = previousRaw === null ? undefined : statSync(hooksWritePath).mode
  backupRealHomeHooksJsonOnce(userDataPath, context, previousRaw)
  const trustConfigSnapshot = mutateRealHomeHooksPreservingUserTrust({
    sourcePath: context.trustSourcePath,
    runtimeHomePath: context.runtimeHomePath,
    tomlPath: context.tomlPath,
    host: context.host,
    useDefaultCodexHome: context.useDefaultCodexHome,
    beforeHooks: config.hooks ?? {},
    afterHooks: nextHooks,
    writeHooks: () => {
      assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
      writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks } as HooksConfig, {
        preserveMode: true
      })
    },
    restoreHooks: () => restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
  })

  removeStaleWslRealHomeTrust(context, managedEntries)

  const grant = grantManagedCodexHookTrust({
    runtimeHomePath: context.runtimeHomePath,
    tomlPath: context.tomlPath,
    managedCommand: material.command,
    managedEntries,
    host: context.host,
    telemetryLane: 'real-home',
    useDefaultCodexHome: context.useDefaultCodexHome
  })
  if (grant.lane === 'rpc') {
    return { lane: 'installed' }
  }

  try {
    restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
  } finally {
    if (trustConfigSnapshot) {
      restoreCodexTrustConfig(context.tomlPath, trustConfigSnapshot)
    }
  }
  console.warn(
    `[codex-real-home-hooks] trust grant unavailable (${grant.reason}); entry rolled back`
  )
  return { lane: 'unavailable', retryAfterMs: getInstallRetryAfterMs(grant.reason) }
}

function reconcileManagedHookDefinition(
  current: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean,
  command: string
): { definitions: HookDefinition[]; groupIndex: number; handlerIndex: number } {
  const directCommandKeys = ['command', 'bash', 'powershell'] as const
  const hasManagedDirectCommand = current.some((definition) =>
    directCommandKeys.some((key) => isManagedCommand(definition[key]))
  )
  const nestedLocations = current.flatMap((definition, groupIndex) =>
    Array.isArray(definition.hooks)
      ? definition.hooks.flatMap((hook, handlerIndex) =>
          isManagedCommand(hook.command) ? [{ groupIndex, handlerIndex }] : []
        )
      : []
  )
  if (!hasManagedDirectCommand && nestedLocations.length === 1) {
    const { groupIndex, handlerIndex } = nestedLocations[0]!
    const definition = current[groupIndex]!
    const hasDirectCommand = directCommandKeys.some((key) => typeof definition[key] === 'string')
    if (definition.matcher === undefined && !hasDirectCommand) {
      const definitions = [...current]
      const hooks = [...definition.hooks!]
      hooks[handlerIndex] = buildManagedCommandHook(command)
      definitions[groupIndex] = { ...definition, hooks }
      return { definitions, groupIndex, handlerIndex }
    }
  }

  const cleaned = removeManagedCommands(current, isManagedCommand)
  return {
    definitions: [...cleaned, { hooks: [buildManagedCommandHook(command)] }],
    groupIndex: cleaned.length,
    handlerIndex: 0
  }
}

function getInstallRetryAfterMs(reason: CodexTrustGrantFallbackReason): number {
  return reason === 'unsupported' || reason === 'unsupported-cached' || reason === 'disabled'
    ? Number.POSITIVE_INFINITY
    : Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS
}

function removeStaleWslRealHomeTrust(
  context: RealHomeCodexHookContext,
  desiredEntries: readonly CodexTrustEntry[]
): void {
  if (context.host.kind !== 'wsl') {
    return
  }
  try {
    removeStaleWslCodexManagedHookTrustEntries({
      tomlPath: context.tomlPath,
      runtimeHomePath: context.runtimeHomePath,
      desiredEntries,
      managedEventLabels: new Set(Object.values(context.material.eventLabel)),
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS,
      buildManagedCommand: buildCodexWslManagedHookCommand
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] failed to drop stale WSL trust entries:', error)
  }
}

export function sweepRealHomeCodexHook(context: RealHomeCodexHookContext): RealHomeCodexHookLane {
  const { hooksJsonPath } = context
  const { raw: previousRaw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (previousRaw === null) {
    removeRealHomeCodexHookTrust(context)
    removeWslRealHomeHookScript(context)
    return 'removed'
  }
  if (!config) {
    return 'unavailable'
  }
  if (!config.hooks) {
    removeRealHomeCodexHookTrust(context)
    removeWslRealHomeHookScript(context)
    return 'removed'
  }
  const isManagedCommand = createManagedCommandMatcher(getManagedScriptFileName(context))
  const nextHooks: Record<string, HookDefinition[]> = { ...config.hooks }
  let removedAny = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (
      cleaned.length !== definitions.length ||
      cleaned.some((definition, index) => definition !== definitions[index])
    ) {
      removedAny = true
    }
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (removedAny) {
    const hooksWritePath = resolveHooksJsonWritePath(hooksJsonPath)
    const previousMode = statSync(hooksWritePath).mode
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: context.trustSourcePath,
      runtimeHomePath: context.runtimeHomePath,
      tomlPath: context.tomlPath,
      host: context.host,
      useDefaultCodexHome: context.useDefaultCodexHome,
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        assertHooksJsonGeneration(hooksJsonPath, hooksWritePath, previousRaw)
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks } as HooksConfig, {
          preserveMode: true
        })
      },
      restoreHooks: () => restoreRealHomeHooksJson(hooksWritePath, previousRaw, previousMode)
    })
  }
  removeRealHomeCodexHookTrust(context)
  removeWslRealHomeHookScript(context)
  return 'removed'
}

function removeRealHomeCodexHookTrust(context: RealHomeCodexHookContext): void {
  try {
    removeStaleWslRealHomeTrust(context, [])
    removeCodexManagedHookTrustEntries({
      tomlPath: context.tomlPath,
      runtimeHomePath: context.runtimeHomePath,
      sourcePath: context.trustSourcePath,
      command: context.material.command,
      managedEventLabels: new Set(Object.values(context.material.eventLabel)),
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] failed to drop Orca trust entries:', error)
  }
}

function getManagedScriptFileName(context: RealHomeCodexHookContext): string {
  return context.host.kind === 'wsl' ? 'codex-hook.sh' : getCodexManagedScriptFileName()
}

function removeWslRealHomeHookScript(context: RealHomeCodexHookContext): void {
  if (context.host.kind !== 'wsl' || !existsSync(context.material.scriptPath)) {
    return
  }
  try {
    unlinkSync(context.material.scriptPath)
  } catch (error) {
    console.warn('[codex-real-home-hooks] failed to remove WSL hook script:', error)
  }
}
