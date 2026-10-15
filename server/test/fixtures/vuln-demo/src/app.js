// Intentionally vulnerable app layer — BlastRadius detection fixture.
import { exec } from 'node:child_process';
import {
  getUser,
  makeToken,
  render,
  runUserCode,
  searchUsers,
} from './db.js';

export function handleRequest(req) {
  const user = getUser(req.id);
  const results = searchUsers(req.q);
  const token = makeToken(user);
  render('<b>' + token + '</b>');
  return { user, results, token };
}

export function adminRun(cmd) {
  exec(cmd, (err, out) => console.log(out));
}

export function debugEval(code) {
  return runUserCode(code);
}

handleRequest({ id: 1, q: 'x' });
