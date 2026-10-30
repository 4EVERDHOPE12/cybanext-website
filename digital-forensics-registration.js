(function (root, createRegistration) {
  const register = createRegistration();

  if (typeof module === 'object' && module.exports) {
    module.exports = register;
  } else {
    root.registerDigitalForensicsApplicant = register;
  }
})(globalThis, function () {
  return async function registerDigitalForensicsApplicant(
    applicant,
    { fetchRequest = fetch, storage = sessionStorage } = {}
  ) {
    const response = await fetchRequest('/api/create-digital-forensics-registration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fullName: applicant.fullName,
        email: applicant.email,
        phone: applicant.phone
      })
    });

    let registration;
    try {
      registration = await response.json();
    } catch {
      throw new Error('The registration server returned an unexpected response.');
    }

    if (
      !response.ok ||
      !registration ||
      typeof registration.registrationId !== 'string' ||
      !registration.registrationId.trim() ||
      typeof registration.fullName !== 'string' ||
      typeof registration.email !== 'string' ||
      typeof registration.phone !== 'string'
    ) {
      throw new Error(
        registration?.error ||
        'We could not save your Digital Forensics registration. Please try again.'
      );
    }

    storage.setItem(
      'digitalForensicsRegistrationId',
      registration.registrationId
    );
    storage.setItem(
      'digitalForensicsApplicantName',
      registration.fullName
    );
    storage.setItem(
      'digitalForensicsApplicantEmail',
      registration.email
    );
    storage.setItem(
      'digitalForensicsApplicantPhone',
      registration.phone || ''
    );

    return registration;
  };
});
