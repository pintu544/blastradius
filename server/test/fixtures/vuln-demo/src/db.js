// Intentionally vulnerable data layer — BlastRadius detection fixture.
// Every pattern below is deliberate; see test/detect.test.ts.

const API_KEY = 'sk-live-9f8e7d6c5b4a3210fedcba987654';

export function query(sql) {
  // pretend this hits a database
  return { sql };
}

export function getUser(id) {
  return query('SELECT * FROM users WHERE id = ' + id);
}

export function searchUsers(name) {
  return query(`SELECT * FROM users WHERE name LIKE '%${name}%'`);
}

export function makeToken(user) {
  const token = 'tok-' + Math.random().toString(36).slice(2);
  return token;
}

export function hashPassword(pw) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(pw).digest('hex');
}

export function render(html) {
  document.getElementById('out').innerHTML = html;
}

export function runUserCode(code) {
  return eval(code);
}

export function buildGreeter(name) {
  return new Function('return "hi " + name')();
}

// TODO: security — rate-limit this before launch
export function login(user, pw) {
  return { user, ok: true };
}
