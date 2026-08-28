import { getServerBackendBaseUrl } from "@/lib/config.server"
import { LoginPage } from "./login-form"

export default async function LoginPageServer() {
  // The page passes both flags through instead of reducing to
  // ``noUsers`` — ``setup_available`` is the durable first-user signal
  // (the /setup link shows only while it is true), while ``has_users``
  // distinguishes a fresh install from an initialized invitation-only
  // installation for the admission copy.
  let hasUsers = true
  let setupAvailable = false
  try {
    const backendUrl = getServerBackendBaseUrl()
    const res = await fetch(`${backendUrl}/auth/has-users`, {
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json()
      if (data.has_users === false) {
        hasUsers = false
      }
      if (data.setup_available === true) {
        setupAvailable = true
      }
    }
  } catch {
    // Backend unreachable — show login form anyway (graceful degradation)
  }

  // Dev sign-in: availability is decided by the backend
  // (DEV_SIGNIN_ENABLED / deployment profile), never guessed client-side.
  let devSignin: { enabled: boolean; landingPath: string } = {
    enabled: false,
    landingPath: "/",
  }
  try {
    const backendUrl = getServerBackendBaseUrl()
    const res = await fetch(`${backendUrl}/auth/dev-signin/available`, {
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json()
      if (data.enabled === true && typeof data.landing_path === "string") {
        devSignin = { enabled: true, landingPath: data.landing_path }
      }
    }
  } catch {
    // Backend unreachable — no dev button
  }

  return (
    <LoginPage
      hasUsers={hasUsers}
      setupAvailable={setupAvailable}
      devSignin={devSignin}
    />
  )
}
