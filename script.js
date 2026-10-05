/* =========================================================
   MOBILE NAVIGATION
========================================================= */
const hamburgerBtn = document.getElementById('hamburgerBtn');
const mainNav = document.getElementById('mainNav');

function toggleDrawer() {
  const isOpen = mainNav.classList.toggle('open');
  hamburgerBtn.classList.toggle('open');
  hamburgerBtn.setAttribute('aria-expanded', isOpen);
}

function closeDrawer() {
  mainNav.classList.remove('open');
  hamburgerBtn.classList.remove('open');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
}

if (hamburgerBtn && mainNav) {
  hamburgerBtn.addEventListener('click', toggleDrawer);

  document.addEventListener('click', (event) => {
    const tappedOutsideMenu = !mainNav.contains(event.target);
    const tappedOutsideButton = !hamburgerBtn.contains(event.target);

    if (
      mainNav.classList.contains('open') &&
      tappedOutsideMenu &&
      tappedOutsideButton
    ) {
      closeDrawer();
    }
  });

  /* Close mobile menu after selecting a link */
  const navLinks = mainNav.querySelectorAll('a');
  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      if (mainNav.classList.contains('open')) {
        closeDrawer();
      }
    });
  });
}

const heroApplyBtn = document.getElementById('heroApplyBtn');
const heroApplicationForm = document.getElementById('applicationForm');

if (heroApplyBtn && heroApplicationForm) {
  heroApplyBtn.addEventListener('click', () => {
    if (mainNav && mainNav.classList.contains('open')) {
      closeDrawer();
    }

    heroApplicationForm.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  });
}

/* =========================================================
   CV UPLOAD HELPERS
========================================================= */
const cvInput = document.getElementById('cv');
const cvDropzone = document.getElementById('cvDropzone');
const cvUploadTitle = document.getElementById('cvUploadTitle');
const cvUploadStatus = document.getElementById('cvUploadStatus');
const cvDefaultTitle = 'Drop your Resume / CV here';
const maxCvSize = 10 * 1024 * 1024;

/* =========================================================
   RESET CV UI
========================================================= */
function resetCvUploadUi() {
  if (cvDropzone) {
    cvDropzone.classList.remove(
      'is-dragging',
      'is-accepted',
      'is-invalid',
      'is-scanning',
      'is-screening-failed',
      'is-screening-passed'
    );
  }

  if (cvUploadTitle) {
    cvUploadTitle.textContent = cvDefaultTitle;
  }

  if (cvUploadStatus) {
    cvUploadStatus.textContent = '';
  }
}

/* =========================================================
   CV RIPPLE EFFECT
========================================================= */
function triggerCvRipple() {
  if (!cvDropzone) return;

  cvDropzone.classList.remove('is-rippling');
  void cvDropzone.offsetWidth;
  cvDropzone.classList.add('is-rippling');

  window.setTimeout(() => {
    cvDropzone.classList.remove('is-rippling');
  }, 380);
}

/* =========================================================
   CV VALIDATION
========================================================= */
function validateCvFile(file) {
  resetCvUploadUi();

  if (!file) {
    return false;
  }

  const extension = file.name.split('.').pop().toLowerCase();
  let message = '';

  /* File type */
  if (!['pdf', 'docx'].includes(extension)) {
    message = 'File type not accepted. Please choose a PDF or DOCX file.';
  }
  /* File size */
  else if (file.size > maxCvSize) {
    message = 'File size exceeds 10MB. Please choose a smaller file.';
  }

  /* Invalid file */
  if (message) {
    if (cvInput) {
      cvInput.setCustomValidity(message);
    }
    if (cvDropzone) {
      cvDropzone.classList.add('is-invalid');
    }
    if (cvUploadStatus) {
      cvUploadStatus.textContent = message;
    }
    return false;
  }

  /* Valid file */
  if (cvInput) {
    cvInput.setCustomValidity('');
  }
  if (cvDropzone) {
    cvDropzone.classList.add('is-accepted');
  }
  if (cvUploadTitle) {
    cvUploadTitle.textContent = file.name;
  }
  if (cvUploadStatus) {
    cvUploadStatus.textContent = '✓ File uploaded successfully';
  }

  triggerCvRipple();
  return true;
}

/* =========================================================
   FORM MESSAGE HELPER
========================================================= */
function showFormMessage(statusMsg, message, type) {
  if (!statusMsg) return;

  statusMsg.textContent = message;
  statusMsg.className = `form-status-message ${type}`;
  statusMsg.style.display = 'block';
  statusMsg.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });
}

/* =========================================================
   APPLICATION FORM SUBMISSION
   ========================================================= */
const applicationForm = document.getElementById('applicationForm');

if (applicationForm) {
  applicationForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitBtn = document.getElementById('submitBtn');
    const applicationStatus = document.getElementById('applicationStatus');
    const cvInput = document.getElementById('cv');

    const fullName = document.getElementById('fullName');
    const email = document.getElementById('email');
    const track = document.getElementById('track');
    const reason = document.getElementById('reason');

    const showStatus = (message, type = 'info') => {
      if (!applicationStatus) return;

      applicationStatus.textContent = message;
      applicationStatus.className = `form-status-message ${type}`;
      applicationStatus.style.display = 'block';
    };

    const resetSubmitButton = () => {
      if (!submitBtn) return;

      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Submit Application <i class="ti ti-arrow-right"></i>';
    };

    /* -----------------------------------------
       BASIC FORM VALIDATION
       ----------------------------------------- */

    if (
      !fullName ||
      !email ||
      !track ||
      !reason ||
      !cvInput
    ) {
      showStatus(
        'Some required application fields are missing. Please refresh the page and try again.',
        'error'
      );
      return;
    }

    if (!fullName.value.trim()) {
      showStatus('Please enter your full name.', 'error');
      fullName.focus();
      return;
    }

    if (!email.validity.valid || !email.value.trim()) {
      showStatus('Please enter a valid email address.', 'error');
      email.focus();
      return;
    }

    if (!track.value) {
      showStatus('Please select an internship track.', 'error');
      track.focus();
      return;
    }

    if (!reason.value.trim()) {
      showStatus('Please tell us why you want to join this track.', 'error');
      reason.focus();
      return;
    }

    if (!cvInput.files || !cvInput.files.length) {
      showStatus('Please upload your CV before continuing.', 'error');
      return;
    }

    const cvFile = cvInput.files[0];

    /* -----------------------------------------
       CV CLIENT-SIDE VALIDATION
       ----------------------------------------- */

    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    const maxFileSize = 10 * 1024 * 1024;

    const fileExtension = cvFile.name
      .split('.')
      .pop()
      .toLowerCase();

    if (!['pdf', 'docx'].includes(fileExtension)) {
      showStatus(
        'Please upload your CV as a PDF or DOCX file.',
        'error'
      );
      return;
    }

    if (cvFile.size > maxFileSize) {
      showStatus(
        'Your CV is too large. Please upload a file smaller than 10MB.',
        'error'
      );
      return;
    }

    if (
      cvFile.type &&
      !allowedTypes.includes(cvFile.type) &&
      !['pdf', 'docx'].includes(fileExtension)
    ) {
      showStatus(
        'Please upload a valid PDF or DOCX CV.',
        'error'
      );
      return;
    }

    /* -----------------------------------------
       DISABLE SUBMIT BUTTON
       ----------------------------------------- */

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        'Screening CV... <i class="ti ti-loader-2"></i>';
    }

    showStatus(
      'Your CV is being screened. Please wait...',
      'info'
    );

    try {
      /* -----------------------------------------
         STEP 1: SERVER-SIDE CV SCREENING
         ----------------------------------------- */

      const scanFormData = new FormData();

      scanFormData.append('cv', cvFile);
      scanFormData.append('track', track.value);

      const scanResponse = await fetch('/api/scan-cv', {
        method: 'POST',
        body: scanFormData
      });

      let scanResult;

      try {
        scanResult = await scanResponse.json();
      } catch (jsonError) {
        throw new Error(
          'We could not process the CV screening response.'
        );
      }

      if (!scanResponse.ok) {
        throw new Error(
          scanResult.error ||
          'We could not screen your CV. Please try again.'
        );
      }

      /* -----------------------------------------
         STEP 2: STOP IF APPLICANT IS NOT QUALIFIED
         ----------------------------------------- */

      if (!scanResult.qualified) {
        showStatus(
          'Thank you for applying. Based on our current screening requirements, your CV does not meet the requirements for this track.',
          'error'
        );

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML =
            'Submit Application <i class="ti ti-arrow-right"></i>';
        }

        return;
      }

      /* -----------------------------------------
         STEP 3: QUALIFIED
         SUBMIT APPLICATION + KEEP CV
         ----------------------------------------- */

      showStatus(
        'Your CV passed the initial screening. Submitting your application...',
        'success'
      );

      if (submitBtn) {
        submitBtn.innerHTML =
          'Submitting Application... <i class="ti ti-loader-2"></i>';
      }

      const applicationData = new FormData(applicationForm);
      applicationData.delete('cv');

      const formspreeResponse = await fetch(
        applicationForm.action,
        {
          method: 'POST',
          body: applicationData,
          headers: {
            Accept: 'application/json'
          }
        }
      );

      let formspreeResult = {};

      try {
        formspreeResult = await formspreeResponse.json();
      } catch (jsonError) {
        /*
        Some successful form endpoints may return
        an empty/non-JSON response.
        */
      }

      if (!formspreeResponse.ok) {
        throw new Error(
          formspreeResult.error ||
          'We could not submit your application. Please try again.'
        );
      }

      /* -----------------------------------------
         STEP 4: SAVE APPLICANT SESSION
         ----------------------------------------- */

      const selectedTrackLabel =
        track.options[track.selectedIndex].textContent.trim();

      sessionStorage.setItem(
        'applicantName',
        fullName.value.trim()
      );

      sessionStorage.setItem(
        'applicantEmail',
        email.value.trim()
      );

      sessionStorage.setItem(
        'selectedTrack',
        track.value
      );

      sessionStorage.setItem(
        'applicantTrackLabel',
        selectedTrackLabel
      );

      /* -----------------------------------------
         STEP 5: SEND QUALIFIED APPLICANT TO PAYMENT
         ----------------------------------------- */

      showStatus(
        'Application submitted successfully. Redirecting you to payment...',
        'success'
      );

      setTimeout(() => {
        if (track.value === 'digital_forensics') {
          window.location.href =
            './payment/digital-forensics.html';
        } else {
          window.location.href =
            './payment/track-payment.html';
        }
      }, 800);

    } catch (error) {
      console.error(
        'Application submission error:',
        error
      );

      showStatus(
        error.message ||
        'Something went wrong while submitting your application. Please try again.',
        'error'
      );

      resetSubmitButton();
    }
  });
}

/* =========================================================
   CONTACT FORM
========================================================= */
const contactForm = document.getElementById('contactForm');

if (contactForm) {
  contactForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const statusMsg = document.getElementById('contactStatus');
    const submitBtn = document.getElementById('contactSubmitBtn');

    const contactName = document.getElementById('contactName');
    const contactEmail = document.getElementById('contactEmail');
    const contactReason = document.getElementById('contactReason');
    const contactMessage = document.getElementById('contactMessage');

    /* ================= VALIDATION ================= */
    if (!contactName.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your name.', 'error');
      contactName.focus();
      return;
    }

    if (!contactEmail.value.trim()) {
      showFormMessage(
        statusMsg,
        'Please enter your email address.',
        'error'
      );
      contactEmail.focus();
      return;
    }

    if (!contactEmail.validity.valid) {
      showFormMessage(
        statusMsg,
        'Please enter a valid email address.',
        'error'
      );
      email.focus();
      return;
    }

    if (!contactReason.value) {
      showFormMessage(
        statusMsg,
        'Please select a reason for contacting us.',
        'error'
      );
      contactReason.focus();
      return;
    }

    if (!contactMessage.value.trim()) {
      showFormMessage(
        statusMsg,
        'Please enter your message.',
        'error'
      );
      contactMessage.focus();
      return;
    }

    /* ================= SUBMITTING ================= */
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Sending...';

    try {
      const response = await fetch(contactForm.action, {
        method: 'POST',
        body: new FormData(contactForm),
        headers: {
          Accept: 'application/json'
        }
      });

      if (response.ok) {
        showFormMessage(
          statusMsg,
          "Thank you! Your message has been sent. We'll be in touch soon.",
          'success'
        );
        contactForm.reset();
      } else {
        throw new Error('Contact submission failed');
      }
    } catch (error) {
      showFormMessage(
        statusMsg,
        'Something went wrong while sending your message. Please try again.',
        'error'
      );
    }

    /* Restore button */
    submitBtn.disabled = false;
    submitBtn.innerHTML =
      'Send Message <i class="ti ti-arrow-right" aria-hidden="true"></i>';
  });
}

/* =========================================================
   CV DROPZONE & DRAG EVENTS
========================================================= */
if (cvInput && cvDropzone) {
  /* Click to browse */
  cvDropzone.addEventListener('click', () => cvInput.click());

  /* Keyboard accessibility */
  cvDropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      cvInput.click();
    }
  });

  /* Drag enter / drag over */
  ['dragenter', 'dragover'].forEach((eventName) => {
    cvDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      cvDropzone.classList.add('is-dragging');
      triggerCvRipple();
    });
  });

  /* Drag leave / drop */
  ['dragleave', 'drop'].forEach((eventName) => {
    cvDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (
        eventName === 'drop' ||
        !cvDropzone.contains(event.relatedTarget)
      ) {
        cvDropzone.classList.remove('is-dragging');
      }
    });
  });

  /* Drop file */
  cvDropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;

    const transfer = new DataTransfer();
    transfer.items.add(file);
    cvInput.files = transfer.files;

    cvInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* Normal file selection */
  cvInput.addEventListener('change', () => {
    const selectedFile = cvInput.files[0];
    if (!selectedFile) {
      resetCvUploadUi();
      return;
    }
    validateCvFile(selectedFile);
  });

  /* Reset form */
  applicationForm?.addEventListener('reset', () => {
    window.setTimeout(resetCvUploadUi, 0);
  });
}