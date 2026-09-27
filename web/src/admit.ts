/**
 * admit.ts — the refusal screen's one command.
 *
 * The owner's own account is admitted by `npm run deploy`, from the account
 * `clasp` is signed in as, so this is for everyone after: a second account of
 * yours, or someone you are sharing the viewer with. They sign in, are
 * refused, and send the owner this line.
 *
 * **It adds; it never replaces.** `scripts/accounts.mjs` keeps the list, so
 * running a command someone else sent cannot take anyone off it.
 *
 * **It is built only from what the Worker sealed**, via `/auth/refused`, and
 * still checked to the character: it is text a person pastes into a shell,
 * and a check that trusts its caller is one refactor from trusting a URL.
 */
export type RefusedAccount = { sub: string; email: string };

const ACCOUNT_ID = /^[0-9]{1,64}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function admitCommand(who: RefusedAccount | null | undefined): string | null {
  if (!who || !ACCOUNT_ID.test(who.sub) || !EMAIL.test(who.email)) return null;
  return `npm run accounts -- add ${who.sub} ${who.email}`;
}
