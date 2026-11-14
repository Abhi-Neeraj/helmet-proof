'use strict';

// Creates a dashboard account, or updates one that already exists.
// The account is active straight away, with no approval step.
//
//   npm run create-user -- --username "Jane Doe" --password "a long password" --role admin
//
// --role is "admin", "staff" or "customer" (default staff). The password is stored only as a hash.

const { run } = require('../src/db');
const users = require('../src/users');

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const username = option('username');
const password = option('password');
const role = option('role') || 'staff';

if (!username || !password || !['admin', 'staff', 'customer'].includes(role)) {
  console.error('Usage: npm run create-user -- --username "<name>" --password "<password>" [--role admin|staff|customer]');
  process.exit(1);
}

try {
  const existing = users.findByUsername(username);
  if (existing) {
    users.setPassword(existing.id, password);
    run('UPDATE users SET role = ?, status = \'active\' WHERE id = ?', role, existing.id);
    console.log(`Updated ${role} account "${existing.username}".`);
  } else {
    const user = users.createUser({ username, password, role, status: 'active' });
    console.log(`Created ${role} account "${user.username}".`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
