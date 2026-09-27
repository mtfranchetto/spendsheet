/**
 * admit.ts — the refusal screen's one command.
 */

/**
 * The one command that admits a refused account, with its ID already in it.
 *
 * Admission is by Google's account ID rather than the email, and the Worker
 * keeps no state to remember a first owner by — `google-identity.ts` argues
 * both. So a person still has to set the secret; this makes it one paste
 * rather than a copy, a lookup of the command and a second paste.
 */
export function admitCommand(account: string | null): string | null {
  // **The ID arrives in the URL, and this turns it into something pasted into a
  // shell.** Anyone can send a link to `?signin=refused&account=…`, so only an
  // ID shaped like Google's — digits, nothing else — becomes a command at all.
  if (!account || !/^[0-9]{1,64}$/.test(account)) return null;
  return `echo '${account}' | npx wrangler secret put ALLOWED_ACCOUNTS`;
}
