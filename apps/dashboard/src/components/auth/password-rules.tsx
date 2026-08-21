import { validatePassword } from "@/lib/password-policy"

const PASSWORD_RULES = [
  { id: "min-length", label: "At least 8 characters" },
  { id: "has-letter", label: "At least one letter" },
  { id: "has-number", label: "At least one number" },
] as const

/** Requirement checklist shown while typing a password. Hidden until input. */
export function PasswordRules({ password }: { password: string }) {
  if (password.length === 0) return null
  const checks = validatePassword(password)
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {PASSWORD_RULES.map((rule) => {
        const passed =
          rule.id === "min-length"
            ? checks.minLength
            : rule.id === "has-letter"
              ? checks.hasLetter
              : checks.hasNumber
        return (
          <li
            key={rule.id}
            className={passed ? "text-success" : "text-muted-foreground"}
          >
            {passed ? "✓" : "○"} {rule.label}
          </li>
        )
      })}
    </ul>
  )
}
