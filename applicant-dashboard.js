(async function () {
  const logoutButtons = [
    document.getElementById('logoutButton'),
    document.getElementById('sidebarLogoutButton')
  ].filter(Boolean);
  const supportLink = document.querySelector('.support-button');

  function buildSupportMailto(applicationReference) {
    const reference = applicationReference || 'Unknown';
    const subject = `Applicant Support – ${reference}`;
    const body = [
      'Hello Cybanext Support,',
      '',
      'I would like help with my application, payment or receipt.',
      '',
      'Application reference: ' + reference,
      '',
      'Please assist me with the issue below:',
      '',
      ''
    ].join('\n');

    return `mailto:support@cybanext.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function ensureAuthenticated() {
    try {
      const response = await fetch('/api/applicant-session', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      if (!response.ok) {
        window.location.replace('/applicant-login.html');
        return null;
      }

      const result = await response.json();
      if (result.authenticated !== true) {
        window.location.replace('/applicant-login.html');
        return null;
      }

      return result.applicationReference || null;
    } catch {
      window.location.replace('/applicant-login.html');
      return null;
    }
  }

  async function handleLogout() {
    try {
      const response = await fetch('/api/logout-applicant', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      if (response.ok) {
        window.location.replace('/applicant-login.html');
        return;
      }

      const result = await response.json().catch(() => ({}));
      console.error('Logout failed:', result.error || 'Unknown error');
      window.location.replace('/applicant-login.html');
    } catch {
      window.location.replace('/applicant-login.html');
    }
  }

  logoutButtons.forEach((button) => {
    button.addEventListener('click', handleLogout);
  });

  const applicationReference = await ensureAuthenticated();
  if (supportLink) {
    supportLink.href = buildSupportMailto(applicationReference);
  }
})();
