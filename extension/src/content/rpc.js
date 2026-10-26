export const api = globalThis.browser ?? globalThis.chrome;

/** True in private/incognito windows, where Tsuzuki never records anything. */
export const isPrivate = !!api?.extension?.inIncognitoContext;

/** Message the background. Resolves to the result, or null on any failure. */
export async function rpc(msg) {
  if (isPrivate) return null;
  try {
    const res = await api.runtime.sendMessage(msg);
    return res && res.ok ? res.result : null;
  } catch {
    // Extension reloaded/updated underneath an open tab, or background unavailable.
    return null;
  }
}
