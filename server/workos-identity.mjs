import {authenticateUser, fail, text, uid} from './model.mjs';

const builder = account => ({id: account.id, name: account.name});
const normalizedName = name => name.trim().toLowerCase();

function verifiedIdentity(identity) {
  // Callers must obtain this object from the server's WorkOS authentication
  // response. This validates shape; it does not authenticate browser input.
  if (!identity || typeof identity.id !== 'string' || !identity.id.trim() || identity.id.length > 256 || identity.id !== identity.id.trim()) {
    fail('WorkOS did not return a valid user identity.', 401);
  }
  if (typeof identity.email !== 'string' || !identity.email.trim() || identity.email.length > 320 || /[\r\n]/.test(identity.email)) {
    fail('WorkOS did not return a valid email address.', 401);
  }
  return {workosId: identity.id, email: identity.email.trim(), emailVerified: identity.emailVerified === true};
}

function mappedAccount(state, workosId) {
  const accounts = state.users.filter(account => account.workosId === workosId);
  if (accounts.length > 1) fail('This sign-in is linked to multiple builders. Contact support.', 409);
  return accounts[0];
}

function applyIdentity(account, identity) {
  Object.assign(account, identity);
  // Claiming a legacy account retires its reusable password. The builder UUID
  // and every ownership reference remain unchanged.
  delete account.hash;
  delete account.salt;
  return builder(account);
}

/** Resolve only by WorkOS user ID, never by an email address or display name. */
export function resolveWorkOSBuilder(store, identity) {
  const profile = verifiedIdentity(identity);
  return store.transaction(state => {
    const account = mappedAccount(state, profile.workosId);
    return account ? applyIdentity(account, profile) : null;
  });
}

/** Complete a server-authenticated WorkOS user's explicit builder onboarding. */
export function onboardWorkOSBuilder(store, identity, input) {
  const profile = verifiedIdentity(identity);
  if (!input || !['create', 'claim'].includes(input.mode)) fail('Choose a new builder name or connect an existing builder.');
  const name = text(input.name, 80).trim();
  if (!name) fail('Enter a builder name.');
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('Use a builder name without control characters.');

  // All lookups and writes happen inside the same synchronous transaction, so
  // simultaneous callbacks cannot bind an identity twice or take the same name.
  return store.transaction(state => {
    const mapped = mappedAccount(state, profile.workosId);
    if (mapped) {
      if (normalizedName(mapped.name) !== normalizedName(name)) fail('This WorkOS account already has a builder profile.', 409);
      return applyIdentity(mapped, profile);
    }

    const matches = state.users.filter(account => normalizedName(account.name) === normalizedName(name));
    if (input.mode === 'create') {
      if (matches.length) fail('That builder name is already registered.', 409);
      const account = {id: uid(), name};
      state.users.push(account);
      return applyIdentity(account, profile);
    }

    // A legacy password proves ownership even if its name happens to match the
    // WorkOS display name/email. An existing WorkOS binding is never replaced.
    if (matches.length > 1) fail('This builder name has multiple accounts. Contact support.', 409);
    const account = matches[0];
    if (account?.workosId) fail('This builder is already connected to another WorkOS account.', 409);
    authenticateUser(account, input.password);
    return applyIdentity(account, profile);
  });
}
