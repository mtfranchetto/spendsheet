/**
 * Who may run what, held to the source rather than to a list.
 *
 * `google.script.run` reaches every global whose name lacks a trailing `_`,
 * from any page this project serves — and the dialogs open for anyone the book
 * is shared with. So "public" is a property of a name, and every public
 * function is a way in for someone who is not the owner unless it gates. A new function that forgets is the realistic
 * security failure, which is why the rule below finds it by reading `src/`
 * rather than by remembering.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A book with the owner seeded. */
function book() {
  const c = load({ userEmail: 'owner@example.com' });
  c.setup();
  return c;
}

describe('the gate on every public function in the project', () => {
  // `google.script.run` can call *any* global whose name lacks a trailing `_`
  // from any page this project serves, and it runs with the owner's
  // authority. The consent redirect answers in plain text and serves no page;
  // these gates are why that is not the only thing keeping a caller who is
  // not the owner away from every public function. A function a stranger can reach can return balances,
  // overwrite the PEM, or spend the bank's daily allowance with nobody at the
  // keyboard.
  //
  // So the rule covers every public function rather than a list of them. Each
  // one must do one of three things:
  //
  //   - gate on its first statement (`requireInteractive_`, `requireOwner_` or
  //     `requireScheduled_`);
  //   - be an entry point Google reserves by name (`doGet`, `onOpen`, `onEdit`);
  //   - reach no Google service at all, **transitively**.
  //
  // "Transitively" is the point. `syncScheduled` touched nothing itself and
  // handed straight to a sync. The walk follows every name a body mentions,
  // strings included, since `functionExists_` and the menu call by string. It
  // stops at a function that gates, because nothing past that gate runs for a
  // stranger. Over-approximating the call graph errs toward flagging, which is
  // the safe direction.
  //
  // Break it on purpose to see it work: drop the `_` from `syncAll_` and this
  // goes red, naming the path to `LockService`.

  const gs = readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();

  /**
   * The source with comments blanked, twice over. `code` keeps string and
   * regex contents, because a function named in a string is still called.
   * `shape` blanks those too, so a `'{'` in a string cannot unbalance the brace
   * count. Both keep every offset, so a span found in one reads out of the other.
   */
  function scan(src) {
    const code = src.split('');
    const shape = src.split('');
    const blank = (from, to, both) => {
      for (let k = from; k < to; k++) {
        if (src[k] === '\n') continue;
        shape[k] = ' ';
        if (both) code[k] = ' ';
      }
    };
    let i = 0;
    let last = '';
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2) + 2;
        blank(i, end, true);
        i = end;
      } else if (c === '/' && n === '/') {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? src.length : nl;
        blank(i, end, true);
        i = end;
      } else if (c === "'" || c === '"' || c === '`' || (c === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(last))) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (c === '/' && src[j] === '[') inClass = true;
          else if (c === '/' && src[j] === ']') inClass = false;
          else if (src[j] === c && !inClass) break;
          j++;
        }
        blank(i + 1, j, false);
        i = j + 1;
        last = 'x';
      } else {
        if (!/\s/.test(c)) last = c;
        i++;
      }
    }
    return { code: code.join(''), shape: shape.join('') };
  }

  /** Every top-level function in `src/*.gs`: name -> { file, body }. */
  const fns = {};
  gs.forEach((file) => {
    const { code, shape } = scan(readFileSync(join(SRC, file), 'utf8'));
    for (const m of shape.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      const open = shape.indexOf('{', m.index);
      let depth = 0;
      let close = open;
      for (; close < shape.length; close++) {
        if (shape[close] === '{') depth++;
        else if (shape[close] === '}' && --depth === 0) break;
      }
      fns[m[1]] = { file, start: m.index, end: close, body: code.slice(open, close + 1) };
    }
  });
  const names = Object.keys(fns);

  /**
   * Every global the source reaches through a dot and the scopes tests treat as
   * a Google service. `Utilities`, `Logger` and `console` are not here: signing
   * a string or writing a log line spends nothing and reads nothing a caller
   * could want.
   */
  const SERVICES = ['SpreadsheetApp', 'UrlFetchApp', 'ScriptApp', 'MailApp', 'GmailApp', 'DriveApp',
    'Drive', 'Session', 'PropertiesService', 'CacheService', 'LockService', 'HtmlService', 'ContentService'];
  const SERVICE = new RegExp('\\b(' + SERVICES.join('|') + ')\\s*\\.');
  const GATES = ['requireInteractive_', 'requireOwner_', 'requireScheduled_'];
  const RESERVED = ['doGet', 'onOpen', 'onEdit'];

  // On the first statement, and nowhere later: a gate after a read has already
  // let the read happen.
  const GATED = new RegExp('^\\{\\s*(?:' + GATES.join('|') + ')\\s*\\(');
  const gated = (name) => GATED.test(fns[name].body);

  const callees = Object.fromEntries(names.map((name) => {
    const words = new Set(fns[name].body.match(/[A-Za-z0-9_$]+/g));
    return [name, names.filter((other) => other !== name && words.has(other))];
  }));

  /** The shortest path from `name` to a service, not passing through a gate; or null. */
  function reach(name) {
    const seen = new Set([name]);
    const queue = [[name]];
    while (queue.length) {
      const path = queue.shift();
      const here = path[path.length - 1];
      const hit = fns[here].body.match(SERVICE);
      if (hit) return [...path, hit[1]];
      for (const next of callees[here]) {
        if (seen.has(next) || gated(next) || GATES.includes(next)) continue;
        seen.add(next);
        queue.push([...path, next]);
      }
    }
    return null;
  }

  const exposed = names.filter((name) => !name.endsWith('_'));

  it('reads the source it thinks it reads', () => {
    // If any of these fail the derivation broke, and the rule below is vacuous.
    expect(exposed.length).toBeGreaterThan(100);
    const all = gs.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
    expect(names.length).toBe(all.match(/^function\s+/gm).length);

    // A brace in a string or a regex that threw the count off would run one
    // body into the next.
    gs.forEach((file) => {
      const spans = names.filter((n) => fns[n].file === file).sort((a, b) => fns[a].start - fns[b].start);
      spans.slice(1).forEach((name, k) => {
        expect(fns[spans[k]].end, spans[k] + ' runs into ' + name).toBeLessThan(fns[name].start);
      });
    });

    expect(gated('saveCredentials')).toBe(true);
    expect(gated('openWebApp')).toBe(true);
    expect(reach('readConfig_')).not.toBeNull();
    expect(reach('normalizeDescription')).toBeNull();
  });

  it('names every Google service the source uses', () => {
    // A service added later that is missing here would make every function
    // using it look pure. Anything ending in `App` or `Service` is one.
    const all = gs.map((f) => scan(readFileSync(join(SRC, f), 'utf8')).code).join('\n');
    const used = new Set(all.match(/\b[A-Z][A-Za-z]*(?:App|Service)(?=\s*\.)/g));
    expect([...used].filter((s) => !SERVICES.includes(s))).toEqual([]);
  });

  it('gates every public function that can reach a Google service', () => {
    const offenders = exposed
      .filter((name) => !RESERVED.includes(name) && !gated(name))
      .map((name) => [name, reach(name)])
      .filter(([, path]) => path)
      .map(([name, path]) => `${name} (${fns[name].file}): ${path.join(' -> ')}`);

    expect(offenders).toEqual([]);
  });

  it('keeps the gates, and everything they call, below the front door', () => {
    // Every menu item and trigger opens with a gate, so a gate that lived in
    // (or leaned on) a front door's file would make the whole Sheet depend on
    // that door existing. `05_auth.gs` serves the consent redirect; nothing the
    // gates run may be defined there or above it. Walked transitively, because
    // the owner check is four helpers deep before it reaches `_config`.
    const seen = new Set();
    const queue = [...GATES, 'seedWebAppOwner_'];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...callees[name]);
    }
    expect(seen.has('webAppAccessDecision_')).toBe(true);
    const misplaced = [...seen].filter((name) => Number(fns[name].file.slice(0, 2)) >= 5)
      .map((name) => `${name} (${fns[name].file})`);
    expect(misplaced).toEqual([]);
  });

  it('gates every trigger handler on the event, not on the UI', () => {
    // A trigger has no UI and no signed-in user, so `requireInteractive_`
    // alone would pass the rule above and refuse every unattended run. Read
    // out of the schedule, so a new trigger is held to it the day it is wired.
    const schedule = readFileSync(join(SRC, '11_triggers.gs'), 'utf8');
    const triggerFns = [...schedule.matchAll(/\bfn:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(triggerFns).toEqual(['syncScheduled', 'selfCheck', 'snapshotToDrive', 'learnScheduled']);

    triggerFns.forEach((name) => {
      const src = readFileSync(join(SRC, fns[name].file), 'utf8');
      expect(src, name).toMatch(new RegExp(`function ${name}\\((\\w+)\\) \\{\\n  requireScheduled_\\(\\1\\);`));
    });
  });

  it('refuses the anonymous page context, and only that one', () => {
    // The three states `requireInteractive_` decides between, told apart by the
    // two things it reads: is there a UI, and who is the active user.
    const c = book();

    // A menu click: a UI context, so it is let through even before an identity
    // is known — which is what keeps `setup()` runnable on a book with no owner.
    c.Session.getActiveUser = () => ({ getEmail: () => '' });
    expect(() => c.requireInteractive_(), 'menu click').not.toThrow();

    // A dialog callback: no UI, but the owner is the active user.
    c.Session.getActiveUser = () => ({ getEmail: () => 'owner@example.com' });
    c.SpreadsheetApp.getUi = () => { throw new Error('no UI in this context'); };
    expect(() => c.requireInteractive_(), 'dialog callback').not.toThrow();

    // A `google.script.run` from anyone but the owner: no UI, and no owner. The
    // one case that must fail — it is the whole reason this gate exists.
    c.Session.getActiveUser = () => ({ getEmail: () => '' });
    expect(() => c.requireInteractive_(), 'a caller who is not the owner').toThrow('Not available');
  });

  describe('requireScheduled_', () => {
    /** A page call from nobody: no UI, nobody signed in. */
    function anonymous() {
      const c = book();
      c.Session.getActiveUser = () => ({ getEmail: () => '' });
      c.SpreadsheetApp.getUi = () => { throw new Error('no UI in this context'); };
      return c;
    }

    it('lets a real trigger run through with no UI and nobody signed in', () => {
      const c = anonymous();
      expect(() => c.requireScheduled_({ authMode: c.ScriptApp.AuthMode.FULL, triggerUid: '1' })).not.toThrow();
    });

    it('lets it through when the runtime wraps the enum afresh rather than handing over the member', () => {
      // Whether the event holds the member itself is not documented. A copy
      // with the member's prototype and name has to pass, or the sync, the
      // alarm and the backup all stop on the day the runtime rewraps it.
      const c = anonymous();
      const full = c.ScriptApp.AuthMode.FULL;
      const rewrapped = Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(full)),
        { toString: () => 'FULL' }));
      expect(rewrapped).not.toBe(full);
      expect(() => c.requireScheduled_({ authMode: rewrapped })).not.toThrow();
    });

    it('refuses everything a browser can send in place of the event', () => {
      // `google.script.run` carries JSON, so the enum's name is the closest a
      // caller can get, in every shape JSON has.
      const c = anonymous();
      // The last two are JSON as a careless deserialiser might assign it: an
      // own `toString` that is a string, and `__proto__` set to an array, which
      // borrows `Array.prototype.toString` to print `FULL`.
      [undefined, null, 'FULL', { authMode: 'FULL' }, { authMode: ['FULL'] }, { authMode: {} },
        { authMode: c.ScriptApp.AuthMode.LIMITED }, { authMode: { toString: 'FULL' } },
        { authMode: Object.setPrototypeOf({}, ['FULL']) }].forEach((e) => {
        expect(() => c.requireScheduled_(e), JSON.stringify(e)).toThrow('Not available');
      });
    });

    it('still lets the Sheet in, so the snapshot menu item and the editor keep working', () => {
      const c = book();
      expect(() => c.requireScheduled_(undefined)).not.toThrow();
    });

    it('stops each trigger handler before it spends anything', () => {
      const c = anonymous();
      const forged = { authMode: 'FULL' };
      c.LockService.getScriptLock = () => { throw new Error('the sync started'); };

      expect(() => c.syncScheduled(forged)).toThrow('Not available');
      expect(() => c.selfCheck(forged)).toThrow('Not available');
      expect(() => c.snapshotToDrive(forged)).toThrow('Not available');
      c.planMemory_ = () => { throw new Error('the memory rebuild started'); };
      expect(() => c.learnScheduled(forged)).toThrow('Not available');
      expect(c.__sentMail).toHaveLength(0);
      expect(c.__driveFiles).toHaveLength(0);
    });
  });
});
