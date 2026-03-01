export type ThemePreference = 'dark'

export const THEME_STORAGE_KEY = 'swarm-theme'

const DARK_CLASS_NAME = 'dark'
const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'

function persistThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Ignore localStorage failures in restricted environments.
  }
}

export const THEME_INIT_SCRIPT = `(() => {
  try {
    const darkClass = '${DARK_CLASS_NAME}';
    document.documentElement.classList.add(darkClass);
    window.localStorage.setItem('${THEME_STORAGE_KEY}', '${DEFAULT_THEME_PREFERENCE}');
  } catch {
    document.documentElement.classList.add('${DARK_CLASS_NAME}');
  }
})();`

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark'
}

export function readStoredThemePreference(): ThemePreference {
  return DEFAULT_THEME_PREFERENCE
}

function applyDarkClass(): void {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.classList.add(DARK_CLASS_NAME)
}

export function applyThemePreference(
  _preference: ThemePreference = DEFAULT_THEME_PREFERENCE,
  options: { persist?: boolean } = {},
): void {
  applyDarkClass()

  if (options.persist ?? true) {
    persistThemePreference(DEFAULT_THEME_PREFERENCE)
  }
}

export function initializeThemePreference(): ThemePreference {
  applyThemePreference(DEFAULT_THEME_PREFERENCE, { persist: false })
  return DEFAULT_THEME_PREFERENCE
}
