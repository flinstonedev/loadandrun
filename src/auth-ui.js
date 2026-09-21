const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

// Authentication can only return to a page within this application.
export function appReturnTo(value, fallback = '/spaces') {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'https://loadandrun.invalid');
    if (url.origin !== 'https://loadandrun.invalid' || /^\/(?:auth|api)(?:\/|$)/.test(url.pathname) || /^\/account\/setup(?:\/|$)/.test(url.pathname)) return fallback;
    url.searchParams.delete('authError');
    return url.pathname + url.search + url.hash;
  } catch {return fallback;}
}

export function hostedAuthURL(mode, returnTo) {
  return `${mode === 'register' ? '/auth/signup' : '/auth/login'}?${new URLSearchParams({returnTo: appReturnTo(returnTo)})}`;
}

export function authErrorMessage(code) {
  const messages = {
    cancelled: 'Sign-in was cancelled. Try again when you’re ready.',
    canceled: 'Sign-in was cancelled. Try again when you’re ready.',
    access_denied: 'Sign-in was not completed. Try again or choose another sign-in method.',
    invalid_state: 'This sign-in link expired or was already used. Start sign-in again.',
    expired: 'Your sign-in session expired. Sign in again to continue.',
    unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
    configuration: 'Sign-in is not ready yet. Please try again shortly.',
  };
  return Object.hasOwn(messages, code) ? messages[code] : 'We couldn’t complete sign-in. Please try again.';
}

export function workosLogoutURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.workos.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch {return null;}
}

export function createAuthUI({getSession, api, go, navigate = url => location.assign(url)}) {
  let setupMode = 'create';

  function start(mode = 'login') {
    if (getSession().onboarding) return go('/account/setup');
    navigate(hostedAuthURL(mode, location.pathname + location.search + location.hash));
  }

  function renderSetup(page) {
    document.title = 'Finish account setup · Load and Run';
    const current = getSession();
    if (current.user) return go('/spaces');
    if (!current.onboarding) {
      page.innerHTML = '<section class="account-setup"><span class="eyebrow">YOUR LOAD AND RUN ACCOUNT</span><h1>Sign in to continue</h1><p class="form-intro">Sign in to choose your builder name or connect an existing account.</p><button class="primary" data-action="login">Sign in</button></section>';
      return;
    }
    const claim = setupMode === 'claim';
    page.innerHTML = `<section class="account-setup" aria-labelledby="setup-heading"><span class="eyebrow">YOUR LOAD AND RUN ACCOUNT</span><h1 id="setup-heading">${claim ? 'Keep your work' : 'Make yourself at home'}</h1><p class="form-intro">${claim ? 'Connect your existing builder account to keep your spaces, widgets, and saved ideas.' : 'Choose the builder name people can use to invite you to their spaces.'}</p><div class="setup-identity"><span>Signed in as</span><strong>${escapeHTML(current.onboarding.email)}</strong><button class="text-button" data-action="logout">Use another sign-in</button></div><div class="setup-options" role="group" aria-label="Account setup"><button type="button" class="quiet" data-setup-mode="create" aria-pressed="${!claim}">Create a new profile</button><button type="button" class="quiet" data-setup-mode="claim" aria-pressed="${claim}">Keep my existing account</button></div><form id="account-setup-form"><label for="setup-name">${claim ? 'Existing builder name' : 'Builder name'}</label><input id="setup-name" name="name" required maxlength="80" autocomplete="username" aria-describedby="setup-name-hint" value="${claim ? '' : escapeHTML(current.onboarding.suggestedName || '')}"><p class="hint" id="setup-name-hint">${claim ? 'Use the name you previously used to sign in to Load and Run.' : 'Your public name in shared spaces and the community. It must be unique.'}</p>${claim ? '<label for="setup-password">Existing Load and Run password</label><input id="setup-password" name="password" type="password" required maxlength="256" autocomplete="current-password" aria-describedby="setup-password-hint"><p class="hint" id="setup-password-hint">Enter your old password once to connect this account. Future sign-ins use your email or social account.</p>' : '<p class="setup-migration-note">Already have spaces here? Choose <button type="button" class="text-button" data-setup-mode="claim">Keep my existing account</button> to keep all your work.</p>'}<p class="error" id="setup-error" role="alert" tabindex="-1" hidden></p><button type="submit" class="primary wide">${claim ? 'Connect existing account' : 'Continue to Load and Run'}</button></form></section>`;
    page.querySelectorAll('[data-setup-mode]').forEach(button => {
      button.onclick = () => {setupMode = button.dataset.setupMode;renderSetup(page);page.querySelector('#setup-name').focus();};
    });
    const form = page.querySelector('#account-setup-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form));
      const error = page.querySelector('#setup-error');
      const button = form.querySelector('[type="submit"]');
      error.hidden = true;
      form.setAttribute('aria-busy', 'true');
      page.querySelectorAll('button, input').forEach(control => {control.disabled = true;});
      button.textContent = claim ? 'Connecting your account…' : 'Creating your profile…';
      try {
        const result = await api('auth/onboard', {mode: claim ? 'claim' : 'create', name: fields.name, ...(claim ? {password: fields.password} : {})});
        // Reload to adopt the rotated session and discard the one-time password.
        navigate(appReturnTo(result.returnTo));
      } catch (failure) {
        error.textContent = failure.message || 'We couldn’t finish account setup. Please try again.';
        error.hidden = false;
        error.focus();
        if (failure.status === 401) {
          const retry = document.createElement('button');
          retry.type = 'button';retry.className = 'text-button';retry.textContent = 'Start sign-in again';
          retry.onclick = () => navigate(hostedAuthURL('login', '/spaces'));
          error.append(document.createElement('br'), retry);
        }
        page.querySelectorAll('button, input').forEach(control => {control.disabled = false;});
        form.removeAttribute('aria-busy');
        button.textContent = claim ? 'Connect existing account' : 'Continue to Load and Run';
      }
    };
  }

  function renderError(page) {
    const code = new URLSearchParams(location.search).get('authError');
    if (!code || getSession().user) return;
    const banner = document.createElement('div');
    banner.className = 'auth-error-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `<p>${escapeHTML(authErrorMessage(code))}</p><button class="quiet" data-action="login">Try signing in again</button>`;
    page.prepend(banner);
  }

  return {start, renderSetup, renderError};
}
