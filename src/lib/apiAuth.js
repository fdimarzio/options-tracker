import { shouldAttachAuth } from "./authCore.js";

let installed = false;

// Adds `Authorization: Bearer <access token>` to same-origin /api/* fetches so the
// server can identify the signed-in user. No secret ever lives in the bundle.
export function installApiAuth(getAccessToken) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (shouldAttachAuth(input, window.location.origin)) {
      const token = await getAccessToken();
      if (token) {
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
        init = { ...init, headers };
      }
    }
    return original(input, init);
  };
}
