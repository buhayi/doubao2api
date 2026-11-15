// SPDX-License-Identifier: AGPL-3.0-only
// Compatibility entry points for the retired CAPTCHA recovery feature.
// Existing imports keep working, but no configuration starts a verification window.
export function createVerificationManager() {
  return {
    status: () => ({ enabled: false, mode: "disabled", automatic: false, manualFallback: false, accounts: {} }),
    async recover(_secret, error) { throw error; },
    async dispose() {},
  };
}

export function withAutomaticVerification(api) {
  return api;
}
