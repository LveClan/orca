export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)
  const tokenNames = new Set(tokens.map((token) => token.split('/')[0]))

  for (const key of keys) {
    if (!tokenNames.has(key)) {
      tokens.push(key)
      tokenNames.add(key)
    }
  }

  env.WSLENV = tokens.join(':')
}

export function removeWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const removedNames = new Set(keys)
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  env.WSLENV = existing
    .split(':')
    .filter(Boolean)
    .filter((token) => !removedNames.has(token.split('/')[0]))
    .join(':')
}
