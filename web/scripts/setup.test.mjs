import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readClient } from './setup.mjs';

const OWNER = '104729384756102938475';
const BOOK = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const PICKER = 'AIza' + 'x'.repeat(35);
const CLIENT = {
  web: { client_id: '123456789012-abc123def456.apps.googleusercontent.com', client_secret: 'GOCSPX-secret', project_id: 'p' }
};

let dir, puts, existing, fetched, asked;

const run = (cmd, args, options) => {
  if (args[2] === 'list') return { status: 0, stdout: JSON.stringify(existing.map((name) => ({ name, type: 'secret_text' }))) };
  puts.push({ name: args[3], value: options.input });
  return { status: 0 };
};

const fetchImpl = async (url) => {
  fetched.push(url);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (url === 'https://oauth2.googleapis.com/token') return reply({ access_token: 'ya29.fresh' });
  if (url.startsWith('https://script.googleapis.com/v1/projects/')) return reply({ scriptId: 'script-1', parentId: BOOK });
  return reply({ sub: OWNER, email: 'owner@example.com', email_verified: true });
};

const opts = (extra = {}) => ({
  run,
  fetchImpl,
  ask: async (question) => {
    asked.push(question);
    return PICKER;
  },
  log: () => {},
  rcPath: join(dir, '.clasprc.json'),
  claspProjectPath: join(dir, '.clasp.json'),
  listPath: join(dir, '.accounts.json'),
  readFile: () => JSON.stringify(CLIENT),
  ...extra
});

const secret = (name) => puts.find((p) => p.name === name)?.value;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-'));
  writeFileSync(join(dir, '.clasprc.json'), JSON.stringify({ tokens: { default: { refresh_token: '1//r', client_id: 'c', client_secret: 's' } } }));
  writeFileSync(join(dir, '.clasp.json'), JSON.stringify({ scriptId: 'script-1', rootDir: 'src' }));
  puts = [];
  existing = [];
  fetched = [];
  asked = [];
});

describe('npm run setup', () => {
  it('sets every secret from the client file, the Apps Script project and one question', async () => {
    await main(['client.json'], opts());

    expect(secret('GOOGLE_CLIENT_ID')).toBe(CLIENT.web.client_id);
    expect(secret('GOOGLE_CLIENT_SECRET')).toBe('GOCSPX-secret');
    expect(secret('GOOGLE_PROJECT_NUMBER')).toBe('123456789012');
    expect(secret('SPREADSHEET_ID')).toBe(BOOK);
    expect(secret('PICKER_API_KEY')).toBe(PICKER);
    expect(Buffer.from(secret('SESSION_KEY'), 'base64')).toHaveLength(32);
    expect(secret('ALLOWED_ACCOUNTS')).toBe(OWNER);
    expect(asked).toHaveLength(1);
    expect(fetched).toContain('https://script.googleapis.com/v1/projects/script-1');
  });

  it('never replaces a SESSION_KEY the Worker already has, which would sign everyone out', async () => {
    existing = ['SESSION_KEY'];
    await main(['client.json'], opts());
    expect(secret('SESSION_KEY')).toBeUndefined();
    expect(secret('GOOGLE_CLIENT_ID')).toBeDefined();
  });

  it('writes nothing when any value is wrong', async () => {
    await expect(main(['client.json'], opts({ ask: async () => 'not-a-key' }))).rejects.toThrow(/API key/);
    await expect(
      main(['client.json'], opts({ readFile: () => JSON.stringify({ installed: CLIENT.web }) }))
    ).rejects.toThrow(/Web application/);
    expect(puts).toEqual([]);
  });

  it('takes the book and the key as flags, asking nothing', async () => {
    await main(['client.json', `--picker-key=${PICKER}`, `--spreadsheet=${BOOK}`], opts());
    expect(asked).toEqual([]);
    expect(fetched.some((url) => url.includes('script.googleapis.com'))).toBe(false);
  });

  it('says what to do when the script is not bound to a book', async () => {
    const unbound = async (url) =>
      url.includes('script.googleapis.com') ? new Response(JSON.stringify({ scriptId: 'script-1' })) : fetchImpl(url);
    await expect(main(['client.json'], opts({ fetchImpl: unbound }))).rejects.toThrow(/--spreadsheet/);
  });
});

describe('readClient', () => {
  it('reads the project number off the client ID', () => {
    expect(readClient(JSON.stringify(CLIENT)).projectNumber).toBe('123456789012');
  });

  it('refuses a file that is not a web client', () => {
    expect(() => readClient('nope')).toThrow(/JSON/);
    expect(() => readClient(JSON.stringify({ web: { client_id: 'x' } }))).toThrow(/client_secret/);
    expect(() => readClient(JSON.stringify({ web: { client_id: 'weird', client_secret: 's' } }))).toThrow(/shape/);
  });
});
