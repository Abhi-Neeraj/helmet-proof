'use strict';

const crypto = require('node:crypto');
const { one, all, run } = require('./db');
const { HttpError } = require('./http-utils');

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,38}[A-Za-z0-9]$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/** Trims the name and collapses runs of spaces, so "A  B " and "A B" are the same user. */
function cleanUsername(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function assertUsername(username) {
  if (!USERNAME.test(username)) {
    throw new HttpError(400, 'Username must be 3 to 40 characters: letters, numbers, spaces, dots, dashes or underscores');
  }
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > MAX_PASSWORD) throw new HttpError(400, 'Password is too long');
}

// Passwords are never stored. Only a salted scrypt hash is.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Checked when the username does not exist, so a wrong username takes as long
// as a wrong password and cannot be told apart by timing.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function findByUsername(username) {
  return one('SELECT * FROM users WHERE username_key = ?', cleanUsername(username).toLowerCase());
}

function findById(id) {
  return one('SELECT * FROM users WHERE id = ?', id);
}

/** Returns the user when the username and password match, otherwise null. */
function checkLogin(username, password) {
  const user = findByUsername(username);
  const matches = verifyPassword(password ?? '', user ? user.password_hash : DUMMY_HASH);
  return user && matches ? user : null;
}

function createUser({ username, password, role = 'staff', status = 'pending' }) {
  const name = cleanUsername(username);
  assertUsername(name);
  assertPassword(password);
  if (findByUsername(name)) throw new HttpError(409, 'That username is already taken');
  const result = run(
    'INSERT INTO users (username, username_key, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    name, name.toLowerCase(), hashPassword(password), role, status, Date.now(),
  );
  return findById(Number(result.lastInsertRowid));
}

function setPassword(id, password) {
  assertPassword(password);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
}

function touchLogin(id) {
  run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), id);
}

function activeAdminCount() {
  return one('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\' AND status = \'active\'').n;
}

function listUsers() {
  return all(
    `SELECT * FROM users
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
  ).map(present);
}

/** The safe, public shape of a user. Never includes the password hash. */
function present(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

module.exports = {
  cleanUsername, assertPassword, verifyPassword, findByUsername, findById, checkLogin,
  createUser, setPassword, touchLogin, activeAdminCount, listUsers, present,
};
