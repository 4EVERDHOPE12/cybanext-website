(function () {
  const registrationOptions = document.getElementById('registrationOptions');
  const message = document.getElementById('selectionMessage');

  const trackLabels = {
    digital_forensics: 'Digital Forensics',
    incident_response: 'Incident Response',
    soc_analyst: 'SOC Analyst',
    network_security: 'Network Security',
    web_app_penetration_testing: 'Web Application Penetration Testing',
    cloud_security: 'Cloud Security'
  };

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('auth-error', isError);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Registration date unavailable'
      : `Registered ${date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      })}`;
  }

  function addRegistration(registration) {
    if (
      typeof registration.registrationId !== 'string' ||
      !['digital_forensics', 'regular_track'].includes(registration.applicantType)
    ) {
      return;
    }

    const item = document.createElement('li');
    const button = document.createElement('button');
    const track = document.createElement('strong');
    const details = document.createElement('span');

    button.type = 'button';
    button.className = 'registration-option';
    track.textContent = trackLabels[registration.track] || 'Applicant registration';
    details.textContent = `${registration.registrationId} · ${formatDate(registration.createdAt)}`;
    button.append(track, details);
    button.addEventListener('click', async () => {
      button.disabled = true;
      showMessage('Opening your selected application…');

      try {
        const response = await fetch('/api/applicant-session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            action: 'select-registration',
            applicantType: registration.applicantType,
            registrationId: registration.registrationId
          }),
          cache: 'no-store',
          credentials: 'same-origin'
        });
        const result = await response.json();

        if (response.status === 401) {
          window.location.replace('/applicant-login.html');
          return;
        }
        if (!response.ok || result.selected !== true) {
          throw new Error(
            result.error || 'That registration could not be selected. Please try again.'
          );
        }

        window.location.replace('/applicant-dashboard.html');
      } catch (error) {
        button.disabled = false;
        showMessage(
          error.message || 'Your registration could not be selected. Please try again.',
          true
        );
      }
    });

    item.appendChild(button);
    registrationOptions.appendChild(item);
  }

  async function loadRegistrations() {
    try {
      const response = await fetch(
        '/api/applicant-session?includeRegistrations=true',
        {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin'
        }
      );
      const result = await response.json();

      if (response.status === 401) {
        window.location.replace('/applicant-login.html');
        return;
      }
      if (!response.ok || result.authenticated !== true) {
        throw new Error(
          result.error || 'Your registrations are temporarily unavailable.'
        );
      }
      if (result.selectionRequired !== true) {
        window.location.replace('/applicant-dashboard.html');
        return;
      }

      (Array.isArray(result.registrations) ? result.registrations : [])
        .forEach(addRegistration);

      if (registrationOptions.children.length === 0) {
        showMessage(
          'No registrations are available for this sign-in. Request a new link.',
          true
        );
        return;
      }

      showMessage('Choose the registration you want to open.');
    } catch (error) {
      showMessage(
        error.message || 'Your registrations are temporarily unavailable. Please try again.',
        true
      );
    }
  }

  loadRegistrations();
})();
