# Sharing the book with someone else

A household ledger has two people in it. This is how to give the second one
access to the Sheet and to the app, and what each of those actually exposes.

Both are one-time human operations, so they are written down here rather than
automated — the governing rule in `CLAUDE.md`.

> **The one thing not to do:** give someone your Google password. It puts them
> inside the account holding your bank credentials, and it makes the sheet's
> own edit history say your name for both pairs of hands.

---

## 1. The Sheet

Nothing special. Open it, **Share**, add their address, choose a role:

| Role | Can they | Use it when |
|---|---|---|
| **Editor** | tick `confirmed`, set categories, type into `cash_entry`, edit `rules` and `categories` | they are keeping the ledger with you — the usual answer |
| **Viewer** | read everything, change nothing | they want to see the numbers and not maintain them |

**Editor is the honest default** if they will use the app at all, because
everything the app writes is a write to the Sheet.

Two things worth knowing before you click:

- **Sharing the Sheet shares the script.** The bound Apps Script project goes
  with it, and an Editor can open the editor and read the code. The code is
  fine — it is meant to be public. **Your credentials are not in it:** the
  private key and client id live in Script Properties, which is a separate
  permission (an Editor on the *sheet* cannot read Script Properties unless
  they are also an editor on the *script project*, which sharing the sheet does
  grant). Treat sharing the sheet as sharing the bank connection.
- **It does not give them the app.** The app has its own list — below.

---

## 2. The app

The app admits Google accounts by ID, from a list on the Worker. From `web/`:

```sh
npm run accounts -- add <account id> [email]
```

You do not need to find their ID. They open the app, sign in, and are refused
— and the refusal screen shows them the exact `add` line to send you. Run it
and they sign in again.

**Sharing the app is not sharing the book.** The app reads with *their* Google
grant, which `drive.file` limits to files they have picked themselves. So they
need the Sheet shared with them first — step 1 — and then choose it once in
their own *Choose the book*. Without the Sheet they are admitted to an app that
can read nothing.

The nightly sync is unaffected either way: it is a trigger owned by you, it
runs as you, and no bank call ever happens from the app.

[`web/README.md`](../web/README.md) has the rest — where the list lives and why
every change pushes the whole of it.

---

## Taking access away

Reverse both, and **do both**:

1. `npm run accounts -- remove <account id>` from `web/`. Their session ends on
   their next request.
2. Remove them from the Sheet's share list. This is what stops their grant
   reading the book, whatever the app's list says.

If they should lose the app but keep the sheet, step 1 alone is enough. If you
are removing them entirely and they were an Editor, also consider that they
have seen the script project — rotating the Enable Banking credentials is the
thorough version, and `docs/SETUP.md` has that procedure.
