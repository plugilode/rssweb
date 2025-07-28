import { readFileSync, existsSync } from "fs"

/**
 * Load the Gemini API key from the environment or from secrets/gemini.key.
 */
export function getGeminiApiKey(): string {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY
  }

  const secretPath = "secrets/gemini.key"
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim()
  }

  return ""
}
